import { FakeClock } from '@/governors/clock';
import { RateGovernor } from '@/governors/rate-governor';
import { KnowledgeStore } from '@/store/knowledge-store';
import { cyclePlan } from '@/timing/cycle-plan';

const cfg = { dailyHardCeiling: 50, dailyOperatingRate: 25, minDelayMs: 1000, maxDelayMs: 2000,
  jitterPercent: 0, activeHoursStart: 0, activeHoursEnd: 24 };

test('the day plan decrements with recorded actions', () => {
  const store = new KnowledgeStore(':memory:');
  const clock = new FakeClock(Date.parse('2026-08-12T12:00:00'));
  const g = new RateGovernor(store, clock, cfg);
  const plan = g.plannedToday();
  expect(g.remainingToday()).toBe(plan);
  store.recordAction('1', 'follow', 'ok', clock.now());
  expect(g.remainingToday()).toBe(plan - 1);
  store.close();
});

describe('per-cycle plan (fluctuates just under the operating rate)', () => {
  test('plannedToday is the cyclePlan draw under the operating rate', () => {
    const store = new KnowledgeStore(':memory:');
    const clock = new FakeClock(Date.parse('2026-08-12T12:00:00'));
    const g = new RateGovernor(store, clock, cfg);
    expect(g.plannedToday()).toBe(cyclePlan(cfg.dailyOperatingRate, g.cycleStartMs()));
    expect(g.plannedToday()).toBeLessThan(cfg.dailyOperatingRate);
    store.close();
  });

  test('atOperatingRate trips at the plan, before the configured rate', () => {
    const store = new KnowledgeStore(':memory:');
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
    const store = new KnowledgeStore(':memory:');
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
  const store = new KnowledgeStore(':memory:');
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
  const store = new KnowledgeStore(':memory:');
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
    new RateGovernor(new KnowledgeStore(':memory:'), clock, {
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

describe('active-hours cycle counting (actions reset when the window opens)', () => {
  const at = (iso: string): FakeClock => new FakeClock(Date.parse(iso));
  const govern = (start: number, end: number, clock: FakeClock, store: KnowledgeStore) =>
    new RateGovernor(store, clock, { ...cfg, activeHoursStart: start, activeHoursEnd: end });

  test('actions before the current cycle start do not count (normal 9→17 window)', () => {
    const store = new KnowledgeStore(':memory:');
    const clock = at('2026-08-15T12:00:00');
    // 08:00 today — BEFORE the window opened; belongs to the previous cycle.
    store.recordAction('a', 'follow', 'ok', Date.parse('2026-08-15T08:00:00'));
    // 09:30 today — inside the current cycle.
    store.recordAction('b', 'follow', 'ok', Date.parse('2026-08-15T09:30:00'));
    expect(govern(9, 17, clock, store).actionsToday()).toBe(1);
    store.close();
  });

  test("an overnight window's post-midnight tail stays in YESTERDAY's cycle (11→3)", () => {
    const store = new KnowledgeStore(':memory:');
    // Prune work at 00:30 — after midnight but inside the cycle that opened
    // yesterday 11:00. At 02:00 it still counts...
    store.recordPruneAction('p1', 'ok', Date.parse('2026-08-15T00:30:00'));
    expect(govern(11, 3, at('2026-08-15T02:00:00'), store).actionsToday()).toBe(1);
    // ...but once a FRESH cycle opens at 11:00, the counter has reset.
    expect(govern(11, 3, at('2026-08-15T12:00:00'), store).actionsToday()).toBe(0);
    expect(govern(11, 3, at('2026-08-15T22:22:00'), store).actionsToday()).toBe(0);
    store.close();
  });

  test('a degenerate start === end window falls back to local midnight', () => {
    const store = new KnowledgeStore(':memory:');
    store.recordAction('a', 'follow', 'ok', Date.parse('2026-08-14T23:00:00'));
    store.recordAction('b', 'follow', 'ok', Date.parse('2026-08-15T01:00:00'));
    expect(govern(8, 8, at('2026-08-15T02:00:00'), store).actionsToday()).toBe(1);
    store.close();
  });

  test('msUntilCycleReset points at the NEXT window opening', () => {
    const store = new KnowledgeStore(':memory:');
    // 22:22 with an 11→3 window: the counter resets tomorrow 11:00.
    const now = Date.parse('2026-08-15T22:22:00');
    const g = govern(11, 3, new FakeClock(now), store);
    expect(g.msUntilCycleReset()).toBe(Date.parse('2026-08-16T11:00:00') - now);
    store.close();
  });
});

test('delay respects bounds with jitter off', () => {
  const store = new KnowledgeStore(':memory:');
  const g = new RateGovernor(store, new FakeClock(0), cfg);
  const d = g.nextDelayMs(() => 0.5);
  expect(d).toBe(1500);
  store.close();
});
