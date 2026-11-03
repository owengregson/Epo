/**
 * Tier 2 — plan-derived re-evaluation schedules (spec §7.5, §9.9), in plan-days and plan slots. The
 * caller turns plan-days into time through the one plan-day boundary (`PlanDayClock`). Kernel siblings only.
 */

import { driftConfirmThreshold } from './derive';
import { EMPIRICAL } from './fundamentals';
import { SETTINGS_POLICY } from './settings-policy';
import { PLAN_POLICY } from './tempo-policy';

/** Plan-days an unreadable kept record waits before its next read: 1, 2, 4, 8, then 8 (spec §7.5). */
export function keptRecheckPlanDays(consecutiveUnreadable: number): number {
  const n = Math.max(1, Math.floor(consecutiveUnreadable));
  return 2 ** Math.min(n - 1, SETTINGS_POLICY.KEEP_RECHECK_DOUBLINGS);
}

/** Why a record or a journal intent waits for its next read: the account is gone, or its page was unreadable. */
export type ParkKind = 'unreachable' | 'unreadable';

/** The plan's slots a park lands on: the next session (null: none left), and the start of a later plan-day. */
export interface ParkSlots {
  readonly nextSessionAt: number | null;
  /** The start of plan-day today + k. */
  planDayStartAfter(k: number): number;
}

/** Gone or renamed on this many plan-days and the account is no longer available (spec §9.9; = 2). */
export function goneConfirmations(): number {
  return driftConfirmThreshold();
}

/**
 * Unreadable re-reads before the terminal: `min k: ORDINARY_FAIL_RATE^(k+1) ≤ 1 − RETRY_CONFIDENCE` (= 3),
 * the same derivation as the plan core's `retryLimit()` (spec §5.14).
 */
function unreadableRetries(): number {
  const miss = 1 - PLAN_POLICY.RETRY_CONFIDENCE;
  let k = 0;
  while (EMPIRICAL.ORDINARY_FAIL_RATE.value ** (k + 1) > miss) k += 1;
  return k;
}

/**
 * The k-th re-evaluation (spec §9.9): `unreachable` at the start of plan-day today + k; `unreadable`
 * at the next session (never the same one), then plan-day today + (k − 1). Non-decreasing in k.
 */
export function parkUntil(kind: ParkKind, k: number, slots: ParkSlots): number {
  const n = Math.max(1, Math.floor(k));
  if (kind === 'unreachable') return slots.planDayStartAfter(n);
  const first = slots.nextSessionAt ?? slots.planDayStartAfter(1);
  return n === 1 ? first : Math.max(first, slots.planDayStartAfter(n - 1));
}

/** Whether the k-th reading ends the parks: unreachable at `goneConfirmations()`, unreadable past the retries. */
export function parkTerminal(kind: ParkKind, k: number): boolean {
  return kind === 'unreachable' ? k >= goneConfirmations() : k > unreadableRetries();
}
