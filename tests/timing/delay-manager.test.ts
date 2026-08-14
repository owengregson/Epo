import { DelayManager } from '@/timing/delay-manager';
import { jittered } from '@/timing/primitives';
import { FakeClock } from '@/governors/clock';

/** A controllable sleep: records calls, resolves when released or aborted. */
function makeSleepHarness() {
  const calls: number[] = [];
  const releases: Array<() => void> = [];
  const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise<void>((resolve) => {
      calls.push(ms);
      if (signal?.aborted) {
        resolve();
        return;
      }
      signal?.addEventListener('abort', () => resolve(), { once: true });
      releases.push(resolve);
    });
  return { calls, releases, sleep };
}

describe('DelayManager', () => {
  test('wait registers a pending entry with the real deadline, then unregisters', async () => {
    const clock = new FakeClock(1_000_000);
    const h = makeSleepHarness();
    const dm = new DelayManager({ clock, sleep: h.sleep });

    const p = dm.wait('engine:action-delay', 240_000);
    expect(dm.pending()).toEqual([
      {
        key: 'engine:action-delay',
        label: undefined,
        startedAt: 1_000_000,
        deadline: 1_240_000,
        ms: 240_000,
      },
    ]);
    expect(dm.nextDeadline('engine:action-delay')).toBe(1_240_000);

    h.releases[0]();
    await expect(p).resolves.toEqual({ completed: true });
    expect(dm.pending()).toEqual([]);
    expect(dm.nextDeadline('engine:action-delay')).toBeNull();
  });

  test('a policy wait samples with the injected rng', async () => {
    const clock = new FakeClock(0);
    const h = makeSleepHarness();
    const rngValues = [0.5, 0.5]; // jittered midpoint, zero jitter term
    const dm = new DelayManager({ clock, sleep: h.sleep, rng: () => rngValues.shift() ?? 0.5 });
    const p = dm.wait('k', jittered(60_000, 120_000, 30));
    expect(h.calls).toEqual([90_000]);
    h.releases[0]();
    await p;
  });

  test('cancel(key) resolves the wait with completed: false', async () => {
    const dm = new DelayManager({ clock: new FakeClock(0), sleep: makeSleepHarness().sleep });
    const p = dm.wait('prune:park', 30_000);
    expect(dm.cancel('prune:park')).toBe(true);
    await expect(p).resolves.toEqual({ completed: false });
    expect(dm.cancel('prune:park')).toBe(false); // nothing left to cancel
  });

  test('cancelAll(prefix) only cancels matching keys', async () => {
    const h = makeSleepHarness();
    const dm = new DelayManager({ clock: new FakeClock(0), sleep: h.sleep });
    const e = dm.wait('engine:idle', 1000);
    const pr = dm.wait('prune:park', 1000);
    expect(dm.cancelAll('engine:')).toBe(1);
    await expect(e).resolves.toEqual({ completed: false });
    expect(dm.pending().map((x) => x.key)).toEqual(['prune:park']);
    h.releases.at(-1)?.();
    await expect(pr).resolves.toEqual({ completed: true });
  });

  test('an external signal abort resolves the wait with completed: false', async () => {
    const dm = new DelayManager({ clock: new FakeClock(0), sleep: makeSleepHarness().sleep });
    const ac = new AbortController();
    const p = dm.wait('engine:idle', 30_000, { signal: ac.signal });
    ac.abort();
    await expect(p).resolves.toEqual({ completed: false });
  });

  test('an already-aborted external signal resolves immediately', async () => {
    const dm = new DelayManager({ clock: new FakeClock(0), sleep: makeSleepHarness().sleep });
    const ac = new AbortController();
    ac.abort();
    await expect(dm.wait('k', 30_000, { signal: ac.signal })).resolves.toEqual({
      completed: false,
    });
  });

  test('a duplicate key replaces the previous wait (cancels it first)', async () => {
    const h = makeSleepHarness();
    const dm = new DelayManager({ clock: new FakeClock(0), sleep: h.sleep });
    const first = dm.wait('k', 1000);
    const second = dm.wait('k', 2000);
    await expect(first).resolves.toEqual({ completed: false });
    expect(dm.pending()).toHaveLength(1);
    h.releases.at(-1)?.();
    await expect(second).resolves.toEqual({ completed: true });
  });

  test('onChange fires on register and settle; unsubscribe stops it', async () => {
    const h = makeSleepHarness();
    const dm = new DelayManager({ clock: new FakeClock(0), sleep: h.sleep });
    const snapshots: number[] = [];
    const off = dm.onChange((pending) => snapshots.push(pending.length));
    const p = dm.wait('k', 1000);
    h.releases[0]();
    await p;
    expect(snapshots).toEqual([1, 0]);
    off();
    const p2 = dm.wait('k', 1000);
    h.releases[1]();
    await p2;
    expect(snapshots).toEqual([1, 0]); // no further notifications
  });

  test('dispose cancels everything', async () => {
    const dm = new DelayManager({ clock: new FakeClock(0), sleep: makeSleepHarness().sleep });
    const p = dm.wait('a', 1000);
    dm.dispose();
    await expect(p).resolves.toEqual({ completed: false });
    expect(dm.pending()).toEqual([]);
  });
});
