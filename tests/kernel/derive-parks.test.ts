/**
 * The kept re-check schedule (spec §7.5): an unreadable record waits 1, 2, 4, then 8 plan-days
 * between reads, never longer, so at most one visit per record per window.
 */
import fc from 'fast-check';
import { keptRecheckPlanDays } from '@/kernel/derive-parks';
import { SETTINGS_POLICY } from '@/kernel/settings-policy';

test('1/2/4/8 plan-days, then capped at 2^KEEP_RECHECK_DOUBLINGS', () => {
  expect([1, 2, 3, 4, 5, 9].map(keptRecheckPlanDays)).toEqual([1, 2, 4, 8, 8, 8]);
  expect(keptRecheckPlanDays(99)).toBe(2 ** SETTINGS_POLICY.KEEP_RECHECK_DOUBLINGS);
});

test('a count below one reads as the first re-check', () => {
  expect(keptRecheckPlanDays(0)).toBe(1);
  expect(keptRecheckPlanDays(-3)).toBe(1);
});

test('law: monotone non-decreasing, a whole number of plan-days, within [1, 2^doublings]', () => {
  const cap = 2 ** SETTINGS_POLICY.KEEP_RECHECK_DOUBLINGS;
  fc.assert(fc.property(fc.integer({ min: -5, max: 60 }), fc.integer({ min: 0, max: 10 }), (n, step) => {
    const a = keptRecheckPlanDays(n);
    const b = keptRecheckPlanDays(n + step);
    expect(Number.isInteger(a)).toBe(true);
    expect(a).toBeGreaterThanOrEqual(1);
    expect(a).toBeLessThanOrEqual(cap);
    expect(b).toBeGreaterThanOrEqual(a);
  }), { numRuns: 300 });
});
