/**
 * WaitRunner — the ONE gate every engine wait passes through. Asserts the gate
 * itself: per-class noise, 'exact' passthrough, the deadline published
 * SYNCHRONOUSLY at registration (before the await), park bookkeeping, and the
 * delegation surface the loops drive their control commands through.
 */

import { FakeClock } from '@/governors/clock';
import { DelayManager } from '@/timing/delay-manager';
import { mulberry32, type WaitClass } from '@/timing/noise';
import { type DelayPolicy, uniform } from '@/timing/primitives';
import { WaitRunner } from '@/timing/wait-runner';

type Key = 'x:park' | 'x:backoff' | 'x:beat' | 'x:exact';
type Park = 'holding';

const CLASSES = {
  'x:park': 'exact',
  'x:backoff': 'retry-backoff',
  'x:beat': 'local-beat',
  'x:exact': 'exact',
} as const satisfies Record<Key, WaitClass>;

const T0 = Date.parse('2026-08-12T12:00:00');

interface Rig {
  runner: WaitRunner<Key, Park>;
  clock: FakeClock;
  slept: number[];
  registered: Array<{ key: Key; deadline: number; park: Park | null }>;
  settled: Array<{ key: Key; park: Park | null }>;
  abort: AbortController;
}

const rig = (over: { advance?: boolean } = {}): Rig => {
  const clock = new FakeClock(T0);
  const slept: number[] = [];
  const registered: Rig['registered'] = [];
  const settled: Rig['settled'] = [];
  const abort = new AbortController();
  const delays = new DelayManager({
    clock,
    sleep: async (ms) => {
      slept.push(ms);
      if (over.advance !== false) clock.advance(ms);
    },
  });
  const runner = new WaitRunner<Key, Park>({
    delays,
    clock,
    classes: CLASSES,
    noiseRng: mulberry32(0xc0ffee),
    parkReason: (key) => (key === 'x:park' ? 'holding' : null),
    signal: () => abort.signal,
    hooks: {
      onRegistered: (key, deadline, park) => registered.push({ key, deadline, park }),
      onSettled: (key, park) => settled.push({ key, park }),
    },
  });
  return { runner, clock, slept, registered, settled, abort };
};

describe('WaitRunner — the noise gate', () => {
  test("'exact' hands the caller's own policy through untouched", () => {
    const r = rig();
    const policy = uniform(1_000, 2_000);
    expect(r.runner.noised('x:exact', policy)).toBe(policy);
    expect(r.runner.noised('x:exact', 5_000)).toBe(5_000);
  });

  test('a non-exact class returns a noise POLICY, never the bare base', () => {
    const r = rig();
    for (const key of ['x:backoff', 'x:beat'] as const) {
      const out = r.runner.noised(key, 60_000);
      expect(typeof out).not.toBe('number');
      expect((out as DelayPolicy).kind).toBe(`noise(${CLASSES[key]})`);
    }
  });

  test("a plan park ends exactly where the plan names it: an 'exact' park is never jittered", () => {
    const r = rig();
    const base = 6 * 3_600_000;
    expect(r.runner.noised('x:park', base)).toBe(base);
  });

  test('the noise draws never consume the sampler rng (the seeded-stream guarantee)', async () => {
    const clock = new FakeClock(T0);
    let managerDraws = 0;
    const delays = new DelayManager({
      clock,
      rng: () => {
        managerDraws += 1;
        return 0.5;
      },
      sleep: async () => {},
    });
    const runner = new WaitRunner<Key>({
      delays,
      clock,
      classes: CLASSES,
      noiseRng: mulberry32(1),
      signal: () => new AbortController().signal,
    });
    await runner.wait('x:beat', 30_000);
    expect(managerDraws).toBe(0);
  });
});

describe('WaitRunner — registration and settlement', () => {
  test('publishes the REAL deadline synchronously, before the wait resolves', async () => {
    const r = rig();
    const base = 6 * 3_600_000;
    const pending = r.runner.wait('x:park', base);

    // The hook already fired — a multi-hour hold is visible the moment it starts.
    expect(r.registered).toHaveLength(1);
    expect(r.registered[0].park).toBe('holding');
    expect(r.registered[0].deadline).toBe(T0 + base);
    expect(r.settled).toHaveLength(0);

    await pending;
    expect(r.settled).toEqual([{ key: 'x:park', park: 'holding' }]);
  });

  test('a step-scale wait reports a null park on both hooks', async () => {
    const r = rig();
    await r.runner.wait('x:beat', 10_000);
    expect(r.registered[0].park).toBeNull();
    expect(r.settled[0].park).toBeNull();
  });

  test('settles — and reports — even when the wait is aborted mid-flight', async () => {
    const clock = new FakeClock(T0);
    const settled: string[] = [];
    const abort = new AbortController();
    const delays = new DelayManager({
      clock,
      sleep: (_ms, signal) =>
        new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve())),
    });
    const runner = new WaitRunner<Key, Park>({
      delays,
      clock,
      classes: CLASSES,
      noiseRng: mulberry32(2),
      signal: () => abort.signal,
      hooks: { onSettled: (key) => settled.push(key) },
    });

    const pending = runner.wait('x:beat', 60_000);
    abort.abort();
    const result = await pending;

    expect(result.completed).toBe(false); // never rejects
    expect(settled).toEqual(['x:beat']);
  });
});

describe('WaitRunner — the control surface the loops drive', () => {
  test('nextDeadline reads the in-flight wait, null once it settles', async () => {
    const clock = new FakeClock(T0);
    const abort = new AbortController();
    let release: () => void = () => {};
    const delays = new DelayManager({
      clock,
      sleep: () => new Promise<void>((resolve) => (release = resolve)),
    });
    const runner = new WaitRunner<Key>({
      delays,
      clock,
      classes: CLASSES,
      noiseRng: mulberry32(3),
      signal: () => abort.signal,
    });

    const pending = runner.wait('x:exact', 45_000);
    expect(runner.nextDeadline('x:exact')).toBe(T0 + 45_000);
    expect(runner.nextDeadline('x:beat')).toBeNull();
    release();
    await pending;
    expect(runner.nextDeadline('x:exact')).toBeNull();
  });

  test('cancelAll wakes every wait under the prefix', async () => {
    const clock = new FakeClock(T0);
    const abort = new AbortController();
    const delays = new DelayManager({
      clock,
      sleep: (_ms, signal) =>
        new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve())),
    });
    const runner = new WaitRunner<Key>({
      delays,
      clock,
      classes: CLASSES,
      noiseRng: mulberry32(4),
      signal: () => abort.signal,
    });

    const a = runner.wait('x:exact', 60_000);
    const b = runner.wait('x:beat', 60_000);
    expect(runner.cancelAll('x:')).toBe(2);
    expect((await a).completed).toBe(false);
    expect((await b).completed).toBe(false);
  });
});
