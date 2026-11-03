/**
 * The calendar plan-day clock (F2a step 9): the Phase F default of the one
 * plan-day boundary — local midnight, DST-safe, one timer for every listener.
 */
import { calendarPlanDayClock } from '@/governors/plan-day-clock';

const HOUR = 3_600_000;
const local = (y: number, m: number, d: number, h = 0, min = 0): number => new Date(y, m - 1, d, h, min).getTime();

/** A manual timer: `after` records the delay; an entry's `fn` fires it once; `live()` lists the pending ones. */
const manualTimer = () => {
  const armed: Array<{ ms: number; fn: () => void; done: boolean }> = [];
  return {
    after: (ms: number, fn: () => void) => {
      const entry = { ms, done: false, fn: () => { entry.done = true; fn(); } };
      armed.push(entry);
      return () => { entry.done = true; };
    },
    live: () => armed.filter((e) => !e.done),
  };
};

test('a window runs from local midnight to the next one, keyed by its start date', () => {
  const clock = calendarPlanDayClock({ now: () => 0 });
  const w = clock.window(local(2026, 11, 3, 14, 30));
  expect(w).toEqual({ key: '2026-11-03', startsAt: local(2026, 11, 3), endsAt: local(2026, 11, 4), quietMinute: 0 });
  expect(clock.dayKey(local(2026, 11, 3, 23, 59))).toBe('2026-11-03');
  expect(clock.dayKey(local(2026, 11, 4))).toBe('2026-11-04');
});

test('DST-safe in the local zone: windows tile a year with no gap or overlap, each 23, 24 or 25 hours', () => {
  const clock = calendarPlanDayClock({ now: () => 0 });
  const lengths = new Set<number>();
  let w = clock.window(local(2026, 1, 1, 9));
  for (let i = 0; i < 366; i += 1) {
    lengths.add((w.endsAt - w.startsAt) / HOUR);
    const next = clock.window(w.endsAt);
    expect(next.startsAt).toBe(w.endsAt);
    expect(next.key).not.toBe(w.key);
    w = next;
  }
  for (const h of lengths) expect([23, 24, 25]).toContain(h);
  const observesDst = new Date(2026, 0, 1).getTimezoneOffset() !== new Date(2026, 6, 1).getTimezoneOffset();
  if (observesDst) expect([...lengths].sort()).toEqual([23, 24, 25]);
});

test('onRoll fires once per boundary with the window that began, on one shared timer', () => {
  let now = local(2026, 11, 3, 22);
  const timer = manualTimer();
  const clock = calendarPlanDayClock({ now: () => now, after: timer.after });
  const a: string[] = [];
  const b: string[] = [];
  const offA = clock.onRoll((w) => a.push(w.key));
  clock.onRoll((w) => b.push(w.key));
  expect(timer.live()).toHaveLength(1);
  expect(timer.live()[0].ms).toBe(2 * HOUR);
  now = local(2026, 11, 4, 0, 0);
  timer.live()[0].fn();
  expect(a).toEqual(['2026-11-04']);
  expect(b).toEqual(['2026-11-04']);
  expect(timer.live().map((e) => e.ms)).toEqual([24 * HOUR]);
  offA();
  now = local(2026, 11, 5, 0, 1);
  timer.live()[0].fn();
  expect(a).toEqual(['2026-11-04']);
  expect(b).toEqual(['2026-11-04', '2026-11-05']);
});

test('an early wake re-arms without a roll; the last unsubscribe cancels the timer', () => {
  let now = local(2026, 11, 3, 23);
  const timer = manualTimer();
  const clock = calendarPlanDayClock({ now: () => now, after: timer.after });
  const keys: string[] = [];
  const off = clock.onRoll((w) => keys.push(w.key));
  now = local(2026, 11, 3, 23, 59);
  timer.live()[0].fn();
  expect(keys).toEqual([]);
  expect(timer.live()).toHaveLength(1);
  expect(timer.live()[0].ms).toBe(60_000);
  off();
  expect(timer.live()).toHaveLength(0);
});
