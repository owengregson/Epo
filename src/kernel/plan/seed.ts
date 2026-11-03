/**
 * Counter-based seeding for the day plan (ADR 0607, spec §5.2): every draw is one mulberry32 step
 * at `seed ^ fnv1a(coords)`, so draws are order independent (a new draw site shifts no other) and a
 * lost plan re-derives the identical ideal plan. The phase is install-seeded, never day-seeded.
 * Layering: `src/kernel/**` imports nothing from the rest of `src/`.
 */

import { BOUNDS } from '../policy';
import { fnv1a, mulberry32 } from '../rng';
import type { PlanDayKey } from './types';

const TWO_32 = 4294967296;

/** The plan-day's seed: the install entropy mixed with the day key. */
export function planSeed(installEntropy: number, key: PlanDayKey): number {
  return (installEntropy ^ fnv1a(`epo-plan|${key}`)) >>> 0;
}

/** One uniform draw in (0, 1) at a coordinate; the same coordinate always draws the same value. */
export function u(seed: number, ...coords: readonly (string | number)[]): number {
  const k = Math.floor(mulberry32((seed ^ fnv1a(coords.join('|'))) >>> 0)() * TWO_32);
  return (k + 0.5) / TWO_32;
}

/** One standard-normal draw at a coordinate: Φ⁻¹ of `u`. */
export function z(seed: number, ...coords: readonly (string | number)[]): number {
  return inverseNormal(u(seed, ...coords));
}

// Acklam's rational approximation of Φ⁻¹ (relative error < 1.15e-9 over (0, 1)).
const A = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1,
  2.506628277459239];
const B = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
const C = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968,
  2.938163982698783];
const D = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
const P_LOW = 0.02425;

const tail = (q: number): number =>
  (((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) / ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1);

/** Φ⁻¹(p) for p in (0, 1) (Acklam); the ends map to ∓∞. */
export function inverseNormal(p: number): number {
  if (!(p > 0)) return Number.NEGATIVE_INFINITY;
  if (!(p < 1)) return Number.POSITIVE_INFINITY;
  if (p < P_LOW) return tail(Math.sqrt(-2 * Math.log(p)));
  if (p > 1 - P_LOW) return -tail(Math.sqrt(-2 * Math.log(1 - p)));
  const q = p - 0.5;
  const r = q * q;
  return ((((((A[0] * r + A[1]) * r + A[2]) * r + A[3]) * r + A[4]) * r + A[5]) * q) /
    (((((B[0] * r + B[1]) * r + B[2]) * r + B[3]) * r + B[4]) * r + 1);
}

/** A uniform in [0, 1) mapped onto the symmetric phase band [−max, +max] hours. */
export function phaseFromUniform(unit: number, maxHours: number): number {
  return (2 * unit - 1) * maxHours;
}

/** The install's circadian phase offset: seeded by the install alone, so the boundary never moves on repair. */
export function phaseOffsetHours(installEntropy: number): number {
  return phaseFromUniform(u(installEntropy >>> 0, 'phase'), BOUNDS.CIRCADIAN.PHASE_JITTER_MAX_HOURS);
}
