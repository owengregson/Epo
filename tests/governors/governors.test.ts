import { FakeClock } from '@/governors/clock';
import { windowClock } from '@/governors/plan-day-clock';
import { RateGovernor, type RatePlan } from '@/governors/rate-governor';
import type { PlanDayWindow } from '@/kernel/plan';
import { automaticDayMax } from '@/kernel/plan';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { openTestStore } from '../kit/store';

const cfg = { dailyHardCeiling: 50, dailyOperatingRate: 25, minDelayMs: 1000, maxDelayMs: 2000,
  jitterPercent: 0, activeHoursStart: 0, activeHoursEnd: 24 };

test('the day plan decrements with recorded actions', () => {
  const store = openTestStore(':memory:');
  const clock = new FakeClock(Date.parse('2026-08-12T12:00:00'));
  const g = new RateGovernor(store, clock, cfg);
  const plan = g.plannedToday();
  expect(g.remainingToday()).toBe(plan);
  store.recordAction('1', 'follow', 'ok', clock.now());
  expect(g.remainingToday()).toBe(plan - 1);
  store.close();
});

/** A plan whose days start at 02:45 local and hold `planned` automatic actions with `remaining` left. */
const planOf = (planned: number, remaining: number): RatePlan => {
  const windowOf = (t: number): PlanDayWindow => {
    const d = new Date(t);
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 2, 45);
    if (start.getTime() > t) start.setDate(start.getDate() - 1);
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1, 2, 45);
    return { key: start.toDateString(), startsAt: start.getTime(), endsAt: end.getTime(), quietMinute: 165 };
  };
  return { day: windowClock(windowOf), volume: () => ({ planned, remaining }) };
};

describe('the plan-day (the plan draws the day; its boundary resets the counter)', () => {
  test('with no plan wired the day is the calendar day and the volume its automatic maximum', () => {
    const store = openTestStore(':memory:');
    const clock = new FakeClock(Date.parse('2026-08-12T12:00:00'));
    const g = new RateGovernor(store, clock, cfg);
    expect(g.plannedToday()).toBe(automaticDayMax(cfg.dailyOperatingRate));
    expect(g.dayStart()).toBe(Date.parse('2026-08-12T00:00:00'));
    expect(g.cycleStartMs()).toBe(g.dayStart());
    store.close();
  });

  test("plannedToday and remainingToday are the plan's; the day starts and resets at its boundary", () => {
    const store = openTestStore(':memory:');
    const clock = new FakeClock(Date.parse('2026-08-15T02:00:00'));
    const g = new RateGovernor(store, clock, cfg, () => 0, planOf(19, 7));
    expect(g.plannedToday()).toBe(19);
    expect(g.remainingToday()).toBe(7);
    expect(g.dayStart()).toBe(Date.parse('2026-08-14T02:45:00'));
    expect(g.msUntilCycleReset()).toBe(45 * 60_000);
    store.recordAction('before', 'follow', 'ok', Date.parse('2026-08-14T02:00:00'));
    store.recordAction('after', 'follow', 'ok', Date.parse('2026-08-14T23:00:00'));
    expect(g.actionsToday()).toBe(1);
    clock.set(Date.parse('2026-08-15T03:00:00'));
    expect(g.actionsToday()).toBe(0);
    store.close();
  });

  test('atOperatingRate trips at the plan, before the configured rate', () => {
    const store = openTestStore(':memory:');
    const clock = new FakeClock(Date.parse('2026-08-12T12:00:00'));
    const g = new RateGovernor(store, clock, cfg);
    const plan = g.plannedToday();
    for (let i = 0; i < plan - 1; i++) store.recordAction(String(i), 'follow', 'ok', clock.now());
    expect(g.atOperatingRate()).toBe(false);
    store.recordAction('last', 'follow', 'ok', clock.now());
    expect(g.atOperatingRate()).toBe(true);
    expect(g.actionsToday()).toBeLessThan(cfg.dailyOperatingRate);
    store.close();
  });

  test('the hard ceiling is untouched by the plan', () => {
    const store = openTestStore(':memory:');
    const clock = new FakeClock(Date.parse('2026-08-12T12:00:00'));
    const g = new RateGovernor(store, clock, cfg);
    for (let i = 0; i < cfg.dailyHardCeiling - 1; i++)
      store.recordAction(String(i), 'follow', 'ok', clock.now());
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

test('hard ceiling blocks past 50 regardless of operating rate', () => {
  const store = openTestStore(':memory:');
  const clock = new FakeClock(Date.parse('2026-08-12T12:00:00'));
  const g = new RateGovernor(store, clock, cfg);
  for (let i = 0; i < 50; i++) store.recordAction(String(i), 'follow', 'ok', clock.now());
  expect(g.atHardCeiling()).toBe(true);
  store.close();
});

describe('withinActiveHours', () => {
  const at = (hour: number): FakeClock =>
    new FakeClock(Date.parse(`2026-08-12T${String(hour).padStart(2, '0')}:00:00`));
  const withWindow = (start: number, end: number, clock: FakeClock): RateGovernor =>
    new RateGovernor(openTestStore(':memory:'), clock, {
      ...cfg,
      activeHoursStart: start,
      activeHoursEnd: end,
    });

  test('normal same-day window: inside 9..17, outside otherwise', () => {
    expect(withWindow(9, 17, at(12)).withinActiveHours()).toBe(true);
    expect(withWindow(9, 17, at(9)).withinActiveHours()).toBe(true);
    expect(withWindow(9, 17, at(17)).withinActiveHours()).toBe(false); // end exclusive
    expect(withWindow(9, 17, at(8)).withinActiveHours()).toBe(false);
    expect(withWindow(9, 17, at(20)).withinActiveHours()).toBe(false);
  });

  test('overnight wrapping window 22..6 is active across midnight', () => {
    expect(withWindow(22, 6, at(23)).withinActiveHours()).toBe(true); // late night
    expect(withWindow(22, 6, at(2)).withinActiveHours()).toBe(true); // early morning
    expect(withWindow(22, 6, at(22)).withinActiveHours()).toBe(true); // start inclusive
    expect(withWindow(22, 6, at(6)).withinActiveHours()).toBe(false); // end exclusive
    expect(withWindow(22, 6, at(12)).withinActiveHours()).toBe(false); // midday, outside
  });

  test('degenerate start === end window is never active', () => {
    expect(withWindow(8, 8, at(8)).withinActiveHours()).toBe(false);
    expect(withWindow(8, 8, at(0)).withinActiveHours()).toBe(false);
  });
});

test('delay respects bounds with jitter off', () => {
  const store = openTestStore(':memory:');
  const g = new RateGovernor(store, new FakeClock(0), cfg);
  const d = g.nextDelayMs(() => 0.5);
  expect(d).toBe(1500);
  store.close();
});

test('equal positive action delays still vary and never undercut the configured interval', () => {
  const store = openTestStore(':memory:');
  const g = new RateGovernor(store, new FakeClock(0), { ...cfg, minDelayMs: 60_000, maxDelayMs: 60_000 });
  expect([0, 0.5, 1].map((draw) => g.nextDelayMs(() => draw))).toEqual([60_000, 73_500, 87_000]);
  store.close();
});
