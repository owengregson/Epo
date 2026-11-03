/**
 * Tier 2 — the lifecycle's statistical thresholds (ADR 0607, spec §5.14): every count the unfollow
 * lifecycle uses derives from the ordinary failure rate and a named confidence, never a literal.
 * `coldFailingThreshold`, `blockedStreakThreshold` and `driftConfirmThreshold` are D5 and live in
 * `derive.ts`; this module re-exports them beside `retryLimit` so consumers read one door.
 * Layering: `src/kernel/**` imports nothing from the rest of `src/`.
 */

import { EMPIRICAL } from './fundamentals';
import { PLAN_POLICY } from './tempo-policy';

export { blockedStreakThreshold, coldFailingThreshold, driftConfirmThreshold } from './derive';

/**
 * Retries per unfollow: the fewest that make an ordinary failure streak this long no likelier than
 * 1 − RETRY_CONFIDENCE — `min k: ORDINARY_FAIL_RATE^(k+1) ≤ 1 − RETRY_CONFIDENCE` = 3 today.
 */
export function retryLimit(failRate: number = EMPIRICAL.ORDINARY_FAIL_RATE.value,
  confidence: number = PLAN_POLICY.RETRY_CONFIDENCE): number {
  if (!(failRate > 0)) return 0;
  if (!(failRate < 1) || !(confidence < 1)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.ceil(Math.log(1 - confidence) / Math.log(failRate) - 1e-12) - 1);
}
