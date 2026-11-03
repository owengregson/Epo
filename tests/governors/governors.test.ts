/**
 * The rate governor after the cadence switch (spec §5.13 S2 item 6): durable counters over both ledgers on
 * the plan's day boundary, and the uncrossable hard ceiling. The plan decides the pace and the volume.
 */
import { FakeClock } from '@/governors/clock';
import { windowClock } from '@/governors/plan-day-clock';
import { RateGovernor, type RatePlan } from '@/governors/rate-governor';
import type { PlanDayWindow } from '@/kernel/plan';
import { openTestStore } from '../kit/store';

const cfg = { dailyHardCeiling: 50 };

/** A plan whose days start at 02:45 local. */
const planDay: RatePlan = {
  day: windowClock((t: number): PlanDayWindow => {
    const d = new Date(t);
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 2, 45);
    if (start.getTime() > t) start.setDate(start.getDate() - 1);
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1, 2, 45);
    return { key: start.toDateString(), startsAt: start.getTime(), endsAt: end.getTime(), quietMinute: 165 };
  }),
};

describe('the plan-day (its boundary resets the counters)', () => {
  test('with no plan wired the day is the calendar day', () => {
    const store = openTestStore(':memory:');
    const clock = new FakeClock(Date.parse('2026-08-12T12:00:00'));
    const g = new RateGovernor(store, clock, cfg);
    expect(g.dayStart()).toBe(Date.parse('2026-08-12T00:00:00'));
    store.close();
  });

  test("the day starts and resets at the plan's boundary", () => {
    const store = openTestStore(':memory:');
    const clock = new FakeClock(Date.parse('2026-08-15T02:00:00'));
    const g = new RateGovernor(store, clock, cfg, planDay);
    expect(g.dayStart()).toBe(Date.parse('2026-08-14T02:45:00'));
    store.recordAction('before', 'follow', 'ok', Date.parse('2026-08-14T02:00:00'));
    store.recordAction('after', 'follow', 'ok', Date.parse('2026-08-14T23:00:00'));
    expect(g.actionsToday()).toBe(1);
    clock.set(Date.parse('2026-08-15T03:00:00'));
    expect(g.actionsToday()).toBe(0);
    store.close();
  });

  test('the hard ceiling holds at its configured count', () => {
    const store = openTestStore(':memory:');
    const clock = new FakeClock(Date.parse('2026-08-12T12:00:00'));
    const g = new RateGovernor(store, clock, cfg);
    for (let i = 0; i < cfg.dailyHardCeiling - 1; i++) store.recordAction(String(i), 'follow', 'ok', clock.now());
    expect(g.atHardCeiling()).toBe(false);
    store.recordAction('last', 'follow', 'ok', clock.now());
    expect(g.atHardCeiling()).toBe(true);
    store.close();
  });
});

test('actionsInLastHour counts both ledgers within the trailing hour only', () => {
  const store = openTestStore(':memory:');
  const clock = new FakeClock(Date.parse('2026-08-12T12:00:00'));
  const g = new RateGovernor(store, clock, cfg);
  const now = clock.now();
  store.recordAction('a', 'follow', 'ok', now - 30 * 60_000); // 30 min ago (in)
  store.recordAction('b', 'follow', 'ok', now - 90 * 60_000); // 90 min ago (out)
  store.recordPruneAction('c', 'ok', now - 10 * 60_000); // prune, 10 min ago (in)
  expect(g.actionsInLastHour()).toBe(2);
  store.close();
});

test('the governor holds no pace, no plan volume and no active hours of its own (spec §5.13 S2 item 6)', () => {
  const store = openTestStore(':memory:');
  const g = new RateGovernor(store, new FakeClock(0), cfg) as unknown as Record<string, unknown>;
  for (const gone of ['nextDelayMs', 'plannedToday', 'remainingToday', 'atOperatingRate', 'withinActiveHours',
    'cycleStartMs', 'msUntilCycleReset']) expect(g[gone]).toBeUndefined();
  store.close();
});
