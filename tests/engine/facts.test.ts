/**
 * The fact gatherer: gather ONCE per tick, only what was asked for, honouring
 * each source's staleness budget — the mechanism that turns "sample the clock
 * once" from a special gate into a property of the runtime.
 */

import { FactGatherer, type FactSources } from '@/engine/facts';
import { FakeClock } from '@/governors/clock';

const T0 = 1_000_000;

describe('FactGatherer', () => {
  test('gathers a source once per tick, however many rules read it', async () => {
    let calls = 0;
    const clock = new FakeClock(T0);
    const g = new FactGatherer(
      {
        clock: {
          staleAfterMs: 0,
          gather: () => {
            calls += 1;
            return { now: clock.now() };
          },
        },
      },
      clock,
    );
    g.beginTick();
    await g.collect(['clock']);
    await g.collect(['clock']);
    await g.read('clock');
    expect(calls).toBe(1);
  });

  test('a new tick re-gathers a per-tick source', async () => {
    let calls = 0;
    const clock = new FakeClock(T0);
    const g = new FactGatherer(
      {
        clock: {
          staleAfterMs: 0,
          gather: () => {
            calls += 1;
            return { now: clock.now() };
          },
        },
      },
      clock,
    );
    g.beginTick();
    await g.read('clock');
    clock.advance(5_000);
    g.beginTick();
    const second = await g.read('clock');
    expect(calls).toBe(2);
    expect(second.now).toBe(T0 + 5_000);
  });

  test('a budgeted source survives ticks until its budget expires', async () => {
    let calls = 0;
    const clock = new FakeClock(T0);
    const g = new FactGatherer(
      {
        ledger: {
          staleAfterMs: 5_000,
          gather: () => {
            calls += 1;
            return {
              atHardCeiling: false,
              atOperatingRate: false,
              withinActiveHours: true,
              msUntilCycleReset: 0,
              actionsInLastHour: calls,
            };
          },
        },
      },
      clock,
    );
    g.beginTick();
    expect((await g.read('ledger')).actionsInLastHour).toBe(1);
    clock.advance(4_000);
    g.beginTick();
    expect((await g.read('ledger')).actionsInLastHour).toBe(1); // still fresh
    clock.advance(2_000);
    g.beginTick();
    expect((await g.read('ledger')).actionsInLastHour).toBe(2); // budget spent
  });

  test('collect gathers ONLY the declared keys, in order', async () => {
    const order: string[] = [];
    const clock = new FakeClock(T0);
    const sources: FactSources = {
      clock: {
        staleAfterMs: 0,
        gather: () => {
          order.push('clock');
          return { now: T0 };
        },
      },
      lifecycle: {
        staleAfterMs: 0,
        gather: () => {
          order.push('lifecycle');
          return { aborted: false, halted: false };
        },
      },
      sentinel: {
        staleAfterMs: 0,
        gather: () => {
          order.push('sentinel');
          return { status: 'ok' as const };
        },
      },
    };
    const g = new FactGatherer(sources, clock);
    g.beginTick();
    const got = await g.collect(['lifecycle', 'clock']);
    expect(order).toEqual(['lifecycle', 'clock']);
    expect(Object.keys(got)).toEqual(['lifecycle', 'clock']);
    expect(got.sentinel).toBeUndefined();
  });

  test('a source may read another source; the read is memoised, not re-run', async () => {
    let clockCalls = 0;
    const clock = new FakeClock(T0);
    const g = new FactGatherer(
      {
        clock: {
          staleAfterMs: 0,
          gather: () => {
            clockCalls += 1;
            return { now: clock.now() };
          },
        },
        cadence: {
          staleAfterMs: 0,
          gather: async (read) => ({ sweepDue: (await read('clock')).now > 0, overdue: [] }),
        },
      },
      clock,
    );
    g.beginTick();
    await g.collect(['clock', 'cadence']);
    expect(clockCalls).toBe(1);
  });

  test('an unregistered source is a LOUD error, never a fabricated value', async () => {
    const g = new FactGatherer({}, new FakeClock(T0));
    await expect(g.read('sentinel')).rejects.toThrow(/no source registered/);
  });

  test('a rejected gather is not cached — the next read retries', async () => {
    let calls = 0;
    const g = new FactGatherer(
      {
        sentinel: {
          staleAfterMs: 60_000,
          gather: () => {
            calls += 1;
            if (calls === 1) throw new Error('evaluate failed');
            return { status: 'ok' as const };
          },
        },
      },
      new FakeClock(T0),
    );
    g.beginTick();
    await expect(g.read('sentinel')).rejects.toThrow('evaluate failed');
    expect((await g.read('sentinel')).status).toBe('ok');
  });

  test('invalidate drops one entry mid-tick', async () => {
    let calls = 0;
    const g = new FactGatherer(
      {
        clock: {
          staleAfterMs: 60_000,
          gather: () => {
            calls += 1;
            return { now: T0 };
          },
        },
      },
      new FakeClock(T0),
    );
    g.beginTick();
    await g.read('clock');
    g.invalidate('clock');
    await g.read('clock');
    expect(calls).toBe(2);
  });
});
