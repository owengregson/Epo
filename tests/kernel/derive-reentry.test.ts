/**
 * The reopen derivations' Phase F skeleton: the weekly cycle is derived, not a
 * new number, and equals today's seven-day revisit and freshness windows.
 */
import { WEEKLY_CYCLE } from '@/kernel/derive-reentry';
import { EXPLORATION_POLICY } from '@/kernel/exploration-policy';
import { EMPIRICAL } from '@/kernel/fundamentals';
import { BOUNDS_REENTRY } from '@/kernel/reentry-policy';
import { MS_PER_DAY } from '@/kernel/units';

test('WEEKLY_CYCLE is the period of the weekly activity shape', () => {
  expect(WEEKLY_CYCLE).toBe(EMPIRICAL.HUMAN_CIRCADIAN.dayOfWeek.length);
  expect(WEEKLY_CYCLE).toBe(7);
});

test('identity: the seven-day windows today are exactly one weekly cycle', () => {
  for (const ms of [EXPLORATION_POLICY.endedRevisitMs, EXPLORATION_POLICY.profileFreshMs,
    EXPLORATION_POLICY.enrichmentRetryMs]) {
    expect(ms).toBe(WEEKLY_CYCLE * MS_PER_DAY);
  }
});

test('the reentry bounds are the spec values', () => {
  expect(BOUNDS_REENTRY).toEqual({ MIN_ROWS_PER_PAGE: 10, FRONTIER_PAGES_MAX: 5 });
});
