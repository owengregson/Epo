/**
 * The circadian intensity field λ(t) and session-start scheduling.
 *
 * Replaces the hard `activeHoursStart/End` wall (identical on/off minute every day —
 * a machine signature) with a smooth diurnal-weekly field: activity ramps in through
 * the morning, has morning/lunch/evening peaks, and tapers overnight to a small floor
 * (peak ~16:00–18:00, trough ~04:00–06:00; see the plan §2). Session start times are
 * drawn from a non-homogeneous Poisson process with this intensity via Lewis thinning.
 *
 * Pure and renderer-safe. Local time is read via `Date`, so the curve follows the
 * user's own day. `rng` is injected for deterministic tests.
 */

import type { Rng } from './primitives';
import { MS_PER_DAY } from './units';

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
  /** Baseline intensity so λ is never exactly 0 (a rare odd-hour action is human). */
  overnightFloor: number;
  /** Length-7 multipliers indexed by `Date.getDay()` (0=Sun … 6=Sat) — weekly seasonality. */
  dayOfWeekWeights: number[];
  /** On Sat/Sun the whole curve shifts this many hours LATER in local time. */
  weekendShiftHours: number;
  /** Per-install horizontal jitter (hours), drawn once and persisted. */
  phaseOffsetHours: number;
}

/** Circular distance between two hours on the 24-hour clock. */
function hourDistance(a: number, b: number): number {
  const d = Math.abs(a - b);
  return Math.min(d, 24 - d);
}

/**
 * Normalized activity intensity in [0,1] at epoch-ms `nowMs`, read in LOCAL time.
 * `raw` (floor + Gaussian bumps) is capped at 1, then scaled by the day-of-week
 * weight and clamped back into [0,1].
 */
export function intensityAt(nowMs: number, profile: CircadianProfile): number {
  const d = new Date(nowMs);
  const dow = d.getDay();
  const isWeekend = dow === 0 || dow === 6;
  const local = d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
  const shifted = local + profile.phaseOffsetHours - (isWeekend ? profile.weekendShiftHours : 0);
  const h = ((shifted % 24) + 24) % 24;

  let raw = profile.overnightFloor;
  for (const b of profile.bumps) {
    const dist = hourDistance(h, b.centerHour);
    raw += b.amplitude * Math.exp(-(dist * dist) / (2 * b.widthHours * b.widthHours));
  }
  const weight = profile.dayOfWeekWeights[dow] ?? 1;
  return Math.min(1, Math.max(0, Math.min(1, raw) * weight));
}

/**
 * The next session start after `fromMs`, drawn from the non-homogeneous process with
 * intensity `peakRatePerDay · intensityAt(t)` via Lewis thinning: propose the next
 * candidate from a homogeneous process at the peak rate, accept it with probability
 * `intensityAt(t)`. Always strictly future. If 10 000 candidates are all rejected
 * (a near-dead profile), falls back to `fromMs + 24h` so the caller never stalls.
 */
export function sampleNextSessionStart(
  fromMs: number,
  profile: CircadianProfile,
  peakRatePerDay: number,
  rng: Rng,
): number {
  const lambdaMax = Math.max(1e-12, peakRatePerDay) / MS_PER_DAY; // candidates per ms at intensity 1
  let t = fromMs;
  for (let i = 0; i < 10_000; i += 1) {
    t += -Math.log(Math.max(1e-12, 1 - rng())) / lambdaMax;
    if (rng() < intensityAt(t, profile)) return Math.round(t);
  }
  return fromMs + MS_PER_DAY;
}

/** Draw a per-install phase offset uniformly in [-maxHours, +maxHours]. */
export function samplePhaseOffset(maxHours: number, rng: Rng): number {
  return (rng() * 2 - 1) * maxHours;
}
