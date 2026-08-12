import { FakeClock } from '@/governors/clock';
import { RateGovernor } from '@/governors/rate-governor';
import { RequestBudget } from '@/governors/request-budget';
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

test('hard ceiling blocks past 50 regardless of operating rate', () => {
  const store = new KnowledgeStore(':memory:');
  const clock = new FakeClock(Date.parse('2026-08-12T12:00:00'));
  const g = new RateGovernor(store, clock, cfg);
  for (let i = 0; i < 50; i++) store.recordAction(String(i), 'follow', 'ok', clock.now());
  expect(g.atHardCeiling()).toBe(true);
  store.close();
});

test('request budget refills after window', () => {
  const store = new KnowledgeStore(':memory:');
  const clock = new FakeClock(1_000_000);
  const b = new RequestBudget(store, clock, { maxRequestsPerWindow: 2, windowMs: 60_000 });
  b.spend(); b.spend();
  expect(b.canSpend()).toBe(false);
  clock.advance(60_001);
  expect(b.canSpend()).toBe(true);
  store.close();
});

test('delay respects bounds with jitter off', () => {
  const store = new KnowledgeStore(':memory:');
  const g = new RateGovernor(store, new FakeClock(0), cfg);
  const d = g.nextDelayMs(() => 0.5);
  expect(d).toBe(1500);
  store.close();
});
