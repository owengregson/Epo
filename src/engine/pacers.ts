/**
 * The plan's pacing gate (ADR 0607, spec §5.16): a PURE verdict over the plan's facts — the day
 * done, a closed session, a full rolling hour and a spent read allowance each park exactly until the
 * instant the plan names. The gap between actions is armed at dispatch by the mutation cadence and
 * served by the action step; nothing here draws one. ADR 0901 (the legacy pacer's deletion) is executed.
 */

import type { ClockFacts, PacingFacts } from './facts';
import type { PlanFacts } from './plan-port';
import type { ParkSpec } from './rules';

/** Exactly the facts a pacing verdict may read. */
export type PacingInputs = { clock: ClockFacts; pacing: PacingFacts };

/** The step each plan park reports. */
const PARK_STEP = {
  'engine:session-park': 'waited-session',
  'engine:daily-ceiling-park': 'waited-ceiling',
  'engine:velocity-park': 'waited-session',
  'engine:read-budget-park': 'waited-session',
} as const satisfies Record<NonNullable<PlanFacts['park']>['key'], ParkSpec['step']>;

/**
 * The park the plan demands now, or null to proceed. PURE — the caller performs the wait, so a burst is
 * unrepresentable and the gate can be property-tested without a clock.
 */
export function pacingVerdict(f: PacingInputs): ParkSpec | null {
  const park = f.pacing.park;
  if (park === null) return null;
  return { key: park.key, delay: Math.max(0, park.until - f.clock.now), step: PARK_STEP[park.key] };
}
