/**
 * The lifecycle thresholds (spec §5.14): retries derive from the ordinary failure rate and the named
 * confidence (3 today); the cold-failing breaker is the derived 7 (not the advisory 8); one door.
 */
import fc from 'fast-check';
import * as derive from '@/kernel/derive';
import { blockedStreakThreshold, coldFailingThreshold, driftConfirmThreshold, retryLimit } from '@/kernel/derive-lifecycle';
import { EMPIRICAL } from '@/kernel/fundamentals';
import { PLAN_POLICY } from '@/kernel/tempo-policy';

test('retryLimit() = 3: the fewest retries that make an ordinary failure streak at most 1 % likely', () => {
  expect(retryLimit()).toBe(3);
  const k = retryLimit();
  expect(EMPIRICAL.ORDINARY_FAIL_RATE.value ** (k + 1)).toBeLessThanOrEqual(1 - PLAN_POLICY.RETRY_CONFIDENCE);
  expect(EMPIRICAL.ORDINARY_FAIL_RATE.value ** k).toBeGreaterThan(1 - PLAN_POLICY.RETRY_CONFIDENCE);
});

test('retryLimit is the minimal k at every rate and confidence', () => {
  fc.assert(fc.property(fc.double({ min: 0.01, max: 0.9, noNaN: true }), fc.double({ min: 0.5, max: 0.999, noNaN: true }), (p, c) => {
    const k = retryLimit(p, c);
    return p ** (k + 1) <= 1 - c + 1e-12 && (k === 0 || p ** k > 1 - c - 1e-12);
  }));
  expect(retryLimit(0, 0.99)).toBe(0);
});

test('the D5 thresholds are re-exported, unchanged: the cold-failing breaker is the derived 7', () => {
  expect(coldFailingThreshold()).toBe(7);
  expect(coldFailingThreshold).toBe(derive.coldFailingThreshold);
  expect(blockedStreakThreshold).toBe(derive.blockedStreakThreshold);
  expect(driftConfirmThreshold).toBe(derive.driftConfirmThreshold);
});
