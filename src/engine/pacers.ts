/**
 * The pacing models, behind one port.
 *
 * Gating is a PURE function of facts: {@link pacingVerdict} answers "may I act
 * now, and if not, what park does this model demand?" without awaiting,
 * sleeping or reading a clock — the conductor's `pacing` rule turns its
 * `ParkSpec` into the single wait the step performs. The plan model parks
 * exactly where the plan says; the post-action gap still needs an object.
 *
 * See `docs/adr/0202-pacing-models.md` for why both models exist, and
 * `docs/adr/0901-delete-the-legacy-pacer.md` for the deletion list: the legacy
 * model is confined to {@link legacyVerdict} + {@link LegacyPacer} in this file
 * and the one `pacing` rule, so removing it is a local edit plus settings.
 */

import { ENGINE as ENGINE_TIMING } from '../timing/config';
import { clamp, logNormal } from '../timing/distributions';
import { absurd } from './absurd';
import { msUntilActiveWindow } from './decisions';
import type { ClockFacts, LedgerFacts, PacingFacts } from './facts';
import type { PlanFacts } from './plan-port';
import type { EnginePacing, EngineRate } from './ports';
import type { ParkSpec } from './rules';

/** Exactly the facts a pacing verdict may read. */
export type PacingInputs = { clock: ClockFacts; ledger: LedgerFacts; pacing: PacingFacts };

/**
 * The park this model demands now, or null to proceed. PURE — the caller
 * performs the wait, so a burst is unrepresentable and the model can be
 * property-tested without a clock.
 */
export function pacingVerdict(f: PacingInputs): ParkSpec | null {
  const pacing = f.pacing;
  switch (pacing.model) {
    case 'plan':
      return planVerdict(f.clock, f.ledger, pacing);
    case 'legacy':
      return legacyVerdict(f.clock, f.ledger, pacing.activeHoursStart);
    default:
      return absurd(pacing);
  }
}

/** The step each plan park reports. */
const PARK_STEP = {
  'engine:session-park': 'waited-session',
  'engine:daily-ceiling-park': 'waited-ceiling',
  'engine:velocity-park': 'waited-session',
  'engine:read-budget-park': 'waited-session',
} as const satisfies Record<NonNullable<PlanFacts['park']>['key'], ParkSpec['step']>;

/**
 * The plan model: the plan's own parks, exact (the day done, a closed session), then the
 * ledger-backed rolling-hour backstop. Sessions subsume active hours: none is placed overnight.
 */
function planVerdict(clock: ClockFacts, ledger: LedgerFacts, p: PlanFacts & { readonly hourlyCap: number }): ParkSpec | null {
  if (p.park !== null) {
    return { key: p.park.key, delay: Math.max(0, p.park.until - clock.now), step: PARK_STEP[p.park.key] };
  }
  if (ledger.actionsInLastHour >= p.hourlyCap) {
    return {
      key: 'engine:velocity-park',
      delay: clamp(
        logNormal(ENGINE_TIMING.VELOCITY_PARK_MEDIAN_MS, ENGINE_TIMING.VELOCITY_PARK_SIGMA),
        ENGINE_TIMING.VELOCITY_PARK_MIN_MS,
        ENGINE_TIMING.VELOCITY_PARK_MAX_MS,
      ),
      step: 'waited-session',
    };
  }
  return null;
}

/** The legacy model: a flat active-hours window plus an operating-rate metronome. */
function legacyVerdict(clock: ClockFacts, ledger: LedgerFacts, activeHoursStart: number): ParkSpec | null {
  if (!ledger.withinActiveHours) {
    return {
      key: 'engine:active-hours-park',
      delay: msUntilActiveWindow(clock.now, activeHoursStart),
      step: 'waited-active-hours',
    };
  }
  // The operating rate is the real daily stop; the hard ceiling is the
  // uncrossable backstop behind it.
  if (ledger.atHardCeiling || ledger.atOperatingRate) {
    return {
      key: 'engine:daily-ceiling-park',
      delay: ledger.msUntilCycleReset,
      step: 'waited-ceiling',
    };
  }
  return null;
}

/**
 * The stateful half of a pacing model: record the action just performed and
 * return the gap owed before the next one. Called exactly once per action,
 * immediately after it lands.
 */
export interface Pacer {
  noteAction(at: number, kind: 'follow' | 'unfollow'): number;
}

/** The plan: its reference gap at time-scale 1, drawn over the ledger's trailing hour. */
export class PlanPacer implements Pacer {
  constructor(private readonly plan: EnginePacing) {}

  noteAction(at: number, _kind: 'follow' | 'unfollow'): number {
    return this.plan.gapAfter(at);
  }
}

/** Legacy: the rate governor's jittered metronome. */
export class LegacyPacer implements Pacer {
  constructor(private readonly rate: EngineRate) {}

  noteAction(_at: number, _kind: 'follow' | 'unfollow'): number {
    return this.rate.nextDelayMs();
  }
}
