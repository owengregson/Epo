import { planDayStartAfter, weeklyCycleSince } from '@/engine/exploration-policy';
import { SourceFrontier } from '@/engine/source-frontier';
import { FakeClock } from '@/governors/clock';
import type { PlanDayWindow } from '@/kernel/plan';
import { openTestStore } from '../kit/store';

// Unequal plan-days model a shifted quiet boundary and a DST transition.
const boundaries = [0, 100, 210, 300, 420, 500, 630, 700, 830];
const window = (at: number): PlanDayWindow => {
  const idx = boundaries.findIndex((b, i) => b <= at && at < (boundaries[i + 1] ?? Infinity));
  return { key: String(idx), startsAt: boundaries[idx], endsAt: boundaries[idx + 1], quietMinute: 0 };
};

test('weekly freshness and revisits count actual plan boundaries', () => {
  expect(planDayStartAfter(window, 50)).toBe(700);
  expect(weeklyCycleSince(window, 699)).toBe(0);
  expect(weeklyCycleSince(window, 700)).toBe(100);
  const store = openTestStore(':memory:');
  const clock = new FakeClock(50);
  const frontier = new SourceFrontier({ store, clock, planDay: { window } });
  store.observe({ accountPk: 'a', observedAt: 1, source: 'profile', fields: { username: 'a' } });
  frontier.beginVisit('a');
  frontier.endVisit('a', 'verified-ended');
  expect(frontier.nextResumeAt()).toBe(700);
  clock.advance(649);
  expect(frontier.next()).toBeNull();
  clock.advance(1);
  expect(frontier.next()?.pk).toBe('a');
  frontier.beginVisit('a');
  frontier.endVisit('a', 'low-yield');
  expect(frontier.nextResumeAt()).toBe(830);
  store.close();
});
