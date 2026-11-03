/**
 * The protection port (spec §7.5, Appendix B.8): the live protection index and the plan-derived
 * wait before an unreadable kept record is read again. Main wires the settings service's index.
 */

import type { Clock } from '../governors/clock';
import { calendarPlanDayClock } from '../governors/plan-day-clock';
import { keptRecheckPlanDays } from '../kernel/derive-parks';
import type { PlanDayClock } from '../kernel/plan';
import { compileProtection, type ProtectionIndex } from '../shared/unfollow-protection';

export interface ProtectionPort {
  /** The live index: read on every call, never a constructor snapshot. */
  index(): ProtectionIndex;
  /** The plan-day's length x 2^min(n-1, KEEP_RECHECK_DOUBLINGS): 1, 2, 4, 8 plan-days. */
  recheckDelayMs(consecutiveUnreadable: number): number;
}

export interface ProtectionPortDeps {
  index(): ProtectionIndex;
  clock: Clock;
  /** The one plan-day boundary (its default is local midnight until the plan's clock is swapped in). */
  dayClock: PlanDayClock;
}

export function createProtectionPort(d: ProtectionPortDeps): ProtectionPort {
  return {
    index: () => d.index(),
    recheckDelayMs: (n) => {
      const day = d.dayClock.window(d.clock.now());
      return (day.endsAt - day.startsAt) * keptRecheckPlanDays(n);
    },
  };
}

/** No rule configured and nothing paused: what a rig without the settings service runs on. */
export const UNCONFIGURED_PROTECTION: ProtectionIndex = compileProtection(
  { accounts: [], words: [], wordMatch: 'anywhere', keepVerified: false }, 'ready', 0,
);

/** The port over {@link UNCONFIGURED_PROTECTION}; main always wires the settings service's index instead. */
export function unconfiguredProtection(clock: Clock): ProtectionPort {
  return createProtectionPort({
    index: () => UNCONFIGURED_PROTECTION, clock, dayClock: calendarPlanDayClock({ now: () => clock.now() }),
  });
}
