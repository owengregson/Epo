import { FakeClock } from '@/governors/clock';
import { RateGovernor } from '@/governors/rate-governor';
import { KnowledgeStore } from '@/store/knowledge-store';

const cfg = { dailyHardCeiling: 50, dailyOperatingRate: 25, minDelayMs: 1000, maxDelayMs: 2000,
  jitterPercent: 0, activeHoursStart: 0, activeHoursEnd: 24 };

test('operating rate decrements with recorded actions', () => {
  const store = new KnowledgeStore(':memory:');
  const clock = new FakeClock(Date.parse('2026-08-12T12:00:00'));
  const g = new RateGovernor(store, clock, cfg);
  expect(g.remainingToday()).toBe(25);
  store.recordAction('1', 'follow', 'ok', clock.now());
  expect(g.remainingToday()).toBe(24);
  store.close();
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

test('delay respects bounds with jitter off', () => {
  const store = new KnowledgeStore(':memory:');
  const g = new RateGovernor(store, new FakeClock(0), cfg);
  const d = g.nextDelayMs(() => 0.5);
  expect(d).toBe(1500);
  store.close();
});
