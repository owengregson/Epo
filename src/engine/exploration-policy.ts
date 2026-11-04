/** Shim: the exploration policy lives in the kernel (tier 1) so the read allowance can derive from it. */

import { WEEKLY_CYCLE } from '@/kernel/derive-reentry';
import type { PlanDayWindow } from '@/kernel/plan';

export { EXPLORATION_POLICY } from '@/kernel/exploration-policy';

/** The start of the plan-day `back` plan-days before the one holding `t` (0: its own), through the one boundary. */
export function planDayStartBefore(window: (t: number) => PlanDayWindow, t: number, back: number): number {
  let w = window(t);
  for (let k = 0; k < back; k += 1) w = window(w.startsAt - 1);
  return w.startsAt;
}

/**
 * The freshness windows in plan-days (spec §5.16): a fact observed at or after this instant is within today and the
 * six plan-days before it, so it lapses as `planDayStartAfter(WEEKLY_CYCLE)` of its own plan-day begins.
 */
export function weeklyCycleSince(window: (t: number) => PlanDayWindow, now: number): number {
  return planDayStartBefore(window, now, WEEKLY_CYCLE - 1);
}
