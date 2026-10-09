/**
 * The pacing models, behind one port.
 *
 * Gating is now a PURE function of facts: {@link pacingVerdict} answers "may I
 * act now, and if not, what park does this model demand?" without awaiting,
 * sleeping or reading a clock — the conductor's `pacing` rule turns its
 * `ParkSpec` into the single wait the step performs. Only the post-action gap
 * still needs an object, because the organic planner is stateful.
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
  switch (f.pacing.model) {
    case 'organic':
      return organicVerdict(f);
    case 'legacy':
      return legacyVerdict(f);
    default:
      return absurd(f.pacing.model);
  }
}

/**
 * The organic model: circadian sessions, log-normal gaps, a daily-volume draw.
 * The hard ceiling is the only daily CAP left — the planner's own volume
 * distribution closes the session once the day's target is spent.
 */
function organicVerdict(f: PacingInputs): ParkSpec | null {
  if (f.ledger.atHardCeiling) {
    return {
      key: 'engine:daily-ceiling-park',
      delay: f.ledger.msUntilCycleReset,
      step: 'waited-ceiling',
    };
  }
  // The session gate subsumes active hours: overnight intensity tapers to ~0,
  // so no session is scheduled there — reads are session-gated for free.
  if (!f.pacing.sessionOpen) {
    return {
      key: 'engine:session-park',
      delay: Math.max(0, f.pacing.nextSessionStartAt - f.clock.now),
      step: 'waited-session',
    };
  }
  // Velocity backstop: a ledger-backed rolling-hour cap that survives even a
  // lost planner snapshot (defense-in-depth with the planner's own ring).
  if (f.ledger.actionsInLastHour >= f.pacing.hourlyVelocityCap) {
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
function legacyVerdict(f: PacingInputs): ParkSpec | null {
  if (!f.ledger.withinActiveHours) {
    return {
      key: 'engine:active-hours-park',
      delay: msUntilActiveWindow(f.clock.now, f.pacing.activeHoursStart),
      step: 'waited-active-hours',
    };
  }
  // The operating rate is the real daily stop; the hard ceiling is the
  // uncrossable backstop behind it.
  if (f.ledger.atHardCeiling || f.ledger.atOperatingRate) {
    return {
      key: 'engine:daily-ceiling-park',
      delay: f.ledger.msUntilCycleReset,
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

/** Organic: the planner owns both the record and the next gap. */
export class OrganicPacer implements Pacer {
  constructor(private readonly pacing: EnginePacing) {}

  noteAction(at: number, kind: 'follow' | 'unfollow'): number {
    this.pacing.recordAction(at, kind);
    return this.pacing.nextActionGapMs(at);
  }
}

/** Legacy: the rate governor's jittered metronome. */
export class LegacyPacer implements Pacer {
  constructor(private readonly rate: EngineRate) {}

  noteAction(_at: number, _kind: 'follow' | 'unfollow'): number {
    return this.rate.nextDelayMs();
  }
}
