/**
 * The gap model (ADR 0607, spec §5.10): rate-neutral and derived, no dial of its own. A session's
 * target mean is `3600 s · CEILING_HEADROOM / H · pace / BEAT_MIN` (the briskest session runs at
 * the cap's sustained rate); the reference shape is time-scaled by τ ≥ 1 until its mean meets it.
 * Layering: `src/kernel/**` imports nothing from the rest of `src/`.
 */

import { NOISE, SESSION, TAB } from '../derive';
import { POLICY } from '../policy';
import { fnv1a, mulberry32 } from '../rng';
import { resolve } from '../tempo/resolve';
import { REFERENCE_TEMPO } from '../tempo/source';
import { MS_PER_HOUR } from '../units';
import { PLAN_BOUNDS } from './policy';
import { inverseNormal } from './seed';
import type { GapShape, GapSpec, PlanIntent } from './types';

// Module-local aliases: the estimator runs thousands of draws per solve.
const { exp, floor, max, min, round } = Math;

/** The mean gap at which a session spends the hourly cap's sustained rate, at pace 1. */
export function sustainedGapMs(hourlyCap: number): number {
  return (MS_PER_HOUR * POLICY.CEILING_HEADROOM) / max(1, hourlyCap) / NOISE.BEAT_MIN_FACTOR;
}

/** A session's target mean gap: the derived rate-neutral gap or a slower override, times its pace. */
export function targetMeanMs(hourlyCap: number, pace: number, overrideMs: number | null): number {
  return max(sustainedGapMs(hourlyCap), overrideMs ?? 0) * pace;
}

const maxAtBeatMax = (key: 'dwell.visit' | 'dwell.before-press'): number => {
  const p = resolve(key, { ...REFERENCE_TEMPO, pace: NOISE.BEAT_MAX_FACTOR }).prior;
  return p.shape === 'band' || p.shape === 'logn' ? p.max : 0;
};

/** The longest gap a session may draw: a gap plus the slowest pre-action span never ends a session (law L4). */
export function gapCapMax(): number {
  return SESSION.SESSION_BOUNDARY_MS - (maxAtBeatMax('dwell.visit') + maxAtBeatMax('dwell.before-press') + TAB.GOTO_TIMEOUT_MS);
}

/** The reference shape time-scaled by τ: median, floor and Hawkes τ scale; the cap scales up to CAP_MAX. */
export function scaleShape(shape: GapShape, tau: number, capMax = gapCapMax()): GapShape {
  return {
    medianMs: round(shape.medianMs * tau),
    sigma: shape.sigma,
    floorMs: round(shape.floorMs * tau),
    capMs: round(min(shape.capMs * tau, capMax)),
    hawkesAlpha: shape.hawkesAlpha,
    hawkesTauMs: round(shape.hawkesTauMs * tau),
  };
}

/** A clamped log-normal from successive uniforms: bounded re-draws, then the nearer bound. */
function clampedLogNormal(shape: GapShape, uAt: (attempt: number) => number): number {
  const lo = min(shape.floorMs, shape.capMs);
  const hi = max(shape.floorMs, shape.capMs);
  let v = lo;
  for (let attempt = 0; attempt < PLAN_BOUNDS.CLAMP_REDRAWS; attempt += 1) {
    v = round(max(0, shape.medianMs) * exp(max(0, shape.sigma) * inverseNormal(uAt(attempt))));
    if (v >= lo && v <= hi) return v;
  }
  return v < lo ? lo : hi;
}

/** 1 + Σ α·e^{−(now − t)/τ_h} over the mutation times in the trailing hour, `now` included. */
export function excitationAt(shape: GapShape, recentTimes: readonly number[], now: number): number {
  let e = 1;
  for (const t of recentTimes) {
    if (t <= now && t > now - MS_PER_HOUR) e += shape.hawkesAlpha * exp(-(now - t) / max(1, shape.hawkesTauMs));
  }
  return e;
}

/** One gap at dispatch: the floor plus the clamped log-normal's excess, compressed by the excitation. */
export function drawGapMs(spec: GapShape, recentTimes: readonly number[], now: number, uAt: (attempt: number) => number): number {
  const base = clampedLogNormal(spec, uAt);
  return spec.floorMs + round(max(0, base - spec.floorMs) / excitationAt(spec, recentTimes, now));
}

const TWO_32 = 4294967296;
/** Memoized estimates; a bounded table so long-lived processes never grow it without limit. */
const MEMO_LIMIT = 512;
const memo = new Map<string, number>();
let uniforms: Float64Array | null = null;

/** The estimator's common random numbers: one fixed seeded stream, enough for every re-draw. */
function modelUniforms(): Float64Array {
  if (uniforms === null) {
    const raw = mulberry32(fnv1a('epo-gap-model'));
    uniforms = new Float64Array(PLAN_BOUNDS.GAP_MODEL_DRAWS * PLAN_BOUNDS.CLAMP_REDRAWS);
    for (let i = 0; i < uniforms.length; i += 1) uniforms[i] = (floor(raw() * TWO_32) + 0.5) / TWO_32;
  }
  return uniforms;
}

/**
 * The mean in-session gap a shape realizes for a session of `sessionBudget` actions: a deterministic
 * seeded simulation of the exact draw (the just-dispatched action excites the next gap), memoized.
 */
export function stationaryMeanGapMs(shape: GapShape, sessionBudget: number): number {
  const b = max(2, round(sessionBudget));
  const key = [shape.medianMs, shape.sigma, shape.floorMs, shape.capMs, shape.hawkesAlpha, shape.hawkesTauMs, b].join('|');
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  const us = modelUniforms();
  let next = 0;
  const open01 = (): number => us[next++ % us.length];
  let total = 0;
  let count = 0;
  while (count < PLAN_BOUNDS.GAP_MODEL_DRAWS) {
    const times = [0];
    for (let k = 1; k < b && count < PLAN_BOUNDS.GAP_MODEL_DRAWS; k += 1) {
      const now = times[times.length - 1];
      const gap = drawGapMs(shape, times, now, open01);
      total += gap;
      count += 1;
      times.push(now + gap);
    }
  }
  if (memo.size >= MEMO_LIMIT) memo.clear();
  memo.set(key, total / count);
  return total / count;
}

/** τ where the capped mean meets the target: a bracket from the uncapped τ, then Illinois regula falsi. */
function solveCapped(meanAt: (tau: number) => number, targetMs: number, tau0: number): number {
  let lo = tau0;
  let fLo = meanAt(lo) - targetMs;
  if (fLo >= 0) return lo;
  let hi = tau0 * 2;
  let fHi = meanAt(hi) - targetMs;
  for (let i = 0; i < PLAN_BOUNDS.GAP_SOLVE_ITERATIONS && fHi < 0; i += 1) {
    lo = hi;
    fLo = fHi;
    hi *= 2;
    fHi = meanAt(hi) - targetMs;
  }
  let side = 0;
  for (let i = 0; i < PLAN_BOUNDS.GAP_SOLVE_ITERATIONS && fHi - fLo > targetMs * PLAN_BOUNDS.GAP_SOLVE_TOLERANCE; i += 1) {
    const mid = (lo * fHi - hi * fLo) / (fHi - fLo);
    const fMid = meanAt(mid) - targetMs;
    if (fMid < 0) {
      lo = mid;
      fLo = fMid;
      if (side < 0) fHi /= 2;
      side = -1;
    } else {
      hi = mid;
      fHi = fMid;
      if (side > 0) fLo /= 2;
      side = 1;
    }
  }
  // The slower end of the bracket: the realized mean never undershoots the target.
  return hi;
}

/**
 * The session's gap spec: τ = max(1, target / mean at τ = 1) when the cap does not bind (the mean
 * is linear in τ), else a bracketed solve; the floor override only lengthens. `targetMeanMs` is the
 * mean the spec realizes: the target, or the organic shape's own mean when that is already slower.
 */
export function solveGapSpec(shape: GapShape, targetMs: number, sessionBudget: number, floorOverrideMs: number | null): GapSpec {
  const capMax = gapCapMax();
  const meanAt = (tau: number): number => stationaryMeanGapMs(scaleShape(shape, tau, capMax), sessionBudget);
  const mean1 = meanAt(1);
  let tau = max(1, targetMs / mean1);
  if (shape.capMs * tau > capMax) tau = solveCapped(meanAt, targetMs, tau);
  const scaled = scaleShape(shape, tau, capMax);
  const floorMs = max(scaled.floorMs, round(floorOverrideMs ?? 0));
  return { ...scaled, floorMs, timeScale: tau, targetMeanMs: max(targetMs, mean1) };
}

/** The instant the rolling hour drops below the cap again, or null while it has room. */
export function velocityWakeAt(recentTimes: readonly number[], hourlyCap: number, now: number): number | null {
  const cap = max(1, floor(hourlyCap));
  const inHour = recentTimes.filter((t) => t <= now && t > now - MS_PER_HOUR).sort((a, b) => a - b);
  if (inHour.length < cap) return null;
  return inHour[inHour.length - cap] + MS_PER_HOUR;
}

/** A session of the intent's typical size: the daily target over the mean session count. */
export function typicalSessionBudget(intent: PlanIntent): number {
  return max(2, round(intent.operatingRate / ((intent.sessions.min + intent.sessions.max) / 2)));
}

/**
 * The gap rows on the effective scale at pace 1 (spec §5.10): the average pause the plan aims for
 * and the shortest pause it allows, both after the slower-only overrides. Settings recommends these.
 */
export function effectiveGapAtPace1(intent: PlanIntent): { readonly typicalMs: number; readonly minimumMs: number } {
  const spec = solveGapSpec(intent.gap, targetMeanMs(intent.hourlyCap, 1, intent.gapTargetOverrideMs),
    typicalSessionBudget(intent), intent.gapFloorOverrideMs);
  return { typicalMs: spec.targetMeanMs, minimumMs: spec.floorMs };
}
