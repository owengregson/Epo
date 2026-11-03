/**
 * The circadian intensity field λ(t), in the profile shape today's planner and Settings preview read.
 * The field itself lives in the day plan (`kernel/plan/circadian.ts`, ADR 0607); this module only
 * adapts the profile shape to it. Pure and renderer-safe.
 */

import { intensityAt as planIntensityAt } from '../kernel/plan/circadian';
import { phaseFromUniform } from '../kernel/plan/seed';
import type { Rng } from './primitives';

/** One Gaussian bump on the 24-hour circle. */
export interface CircadianBump {
  centerHour: number;
  amplitude: number;
  widthHours: number;
}

/** The diurnal-weekly shape of activity. */
export interface CircadianProfile {
  /** Sum-of-Gaussians daily shape (morning/lunch/evening). */
  bumps: CircadianBump[];
  /** Baseline intensity so λ is never exactly 0. */
  overnightFloor: number;
  /** Length-7 multipliers indexed by `Date.getDay()` (0=Sun … 6=Sat) — weekly seasonality. */
  dayOfWeekWeights: number[];
  /** On Sat/Sun the whole curve shifts this many hours LATER in local time. */
  weekendShiftHours: number;
  /** Per-install horizontal shift (hours). */
  phaseOffsetHours: number;
}

/** Normalized activity intensity in [0, 1] at epoch-ms `nowMs`, read in local time. */
export function intensityAt(nowMs: number, profile: CircadianProfile): number {
  const shape = {
    bumps: profile.bumps,
    overnightFloor: profile.overnightFloor,
    weekdayWeights: profile.dayOfWeekWeights,
    weekendShiftHours: profile.weekendShiftHours,
  };
  return planIntensityAt(nowMs, shape, profile.phaseOffsetHours);
}

/**
 * A phase offset drawn from `rng` in [-maxHours, +maxHours].
 * @transitional — the legacy planner wiring draws here until the install-seeded plan phase replaces it.
 */
export function samplePhaseOffset(maxHours: number, rng: Rng): number {
  return phaseFromUniform(rng(), maxHours);
}
