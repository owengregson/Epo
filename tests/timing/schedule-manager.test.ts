import { ScheduleManager } from '@/timing/schedule-manager';
import { FakeClock, SystemClock } from '@/governors/clock';

describe('ScheduleManager.every', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('runs the task on the interval; immediate runs once up front', () => {
    const sm = new ScheduleManager({ clock: new SystemClock() });
    let runs = 0;
    sm.every(
      'k',
      1000,
      () => {
        runs += 1;
      },
      { immediate: true },
    );
    expect(runs).toBe(1);
    jest.advanceTimersByTime(3000);
    expect(runs).toBe(4);
    sm.dispose();
  });

  test('a second every() under the same key is a no-op (idempotent)', () => {
    const sm = new ScheduleManager({ clock: new SystemClock() });
    let a = 0;
    let b = 0;
    sm.every('k', 1000, () => {
      a += 1;
    });
    sm.every('k', 1000, () => {
      b += 1;
    });
    jest.advanceTimersByTime(2000);
    expect(a).toBe(2);
    expect(b).toBe(0);
    sm.dispose();
  });

  test('overlap guard: ticks landing while the async task runs are DROPPED', async () => {
    const sm = new ScheduleManager({ clock: new SystemClock() });
    let starts = 0;
    let release: () => void = () => {};
    sm.every('k', 1000, () => {
      starts += 1;
      return new Promise<void>((r) => {
        release = r;
      });
    });
    jest.advanceTimersByTime(1000); // first tick starts, never finishes
    jest.advanceTimersByTime(3000); // three more ticks — all dropped
    expect(starts).toBe(1);
    release();
    // Drain the catch → finally microtask hops so the busy flag clears.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    jest.advanceTimersByTime(1000);
    expect(starts).toBe(2);
    sm.dispose();
  });

  test('a throwing task never kills the loop', () => {
    const sm = new ScheduleManager({ clock: new SystemClock() });
    let runs = 0;
    sm.every('k', 1000, () => {
      runs += 1;
      throw new Error('boom');
    });
    jest.advanceTimersByTime(3000);
    expect(runs).toBe(3);
    sm.dispose();
  });

  test('stop(key) halts that loop; dispose halts everything', () => {
    const sm = new ScheduleManager({ clock: new SystemClock() });
    let a = 0;
    let b = 0;
    sm.every('a', 1000, () => {
      a += 1;
    });
    sm.every('b', 1000, () => {
      b += 1;
    });
    sm.stop('a');
    jest.advanceTimersByTime(2000);
    expect(a).toBe(0);
    expect(b).toBe(2);
    sm.dispose();
    jest.advanceTimersByTime(2000);
    expect(b).toBe(2);
  });
});

describe('ScheduleManager.cadence', () => {
  test('due when never run; not due until everyMs elapses; markRun persists', () => {
    const sm = new ScheduleManager({ clock: new FakeClock(0) });
    let stored: number | null = null;
    const c = sm.cadence('sweep', {
      getLastRunAt: () => stored,
      setLastRunAt: (at) => {
        stored = at;
      },
    });
    expect(c.isDue(1_000, 4 * 3_600_000)).toBe(true); // never ran
    c.markRun(1_000);
    expect(stored).toBe(1_000);
    expect(c.lastRunAt()).toBe(1_000);
    expect(c.isDue(1_000 + 4 * 3_600_000 - 1, 4 * 3_600_000)).toBe(false);
    expect(c.isDue(1_000 + 4 * 3_600_000, 4 * 3_600_000)).toBe(true);
  });
});
