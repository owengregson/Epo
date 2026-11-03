/**
 * Tier 2 — plan-derived re-evaluation schedules (spec §7.5, §9.9), in plan-days. The caller turns
 * plan-days into time through the one plan-day boundary (`PlanDayClock`). Kernel siblings only.
 */

import { SETTINGS_POLICY } from './settings-policy';

/** Plan-days an unreadable kept record waits before its next read: 1, 2, 4, 8, then 8 (spec §7.5). */
export function keptRecheckPlanDays(consecutiveUnreadable: number): number {
  const n = Math.max(1, Math.floor(consecutiveUnreadable));
  return 2 ** Math.min(n - 1, SETTINGS_POLICY.KEEP_RECHECK_DOUBLINGS);
}
