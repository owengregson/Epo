/**
 * Heavy-tailed delay samplers — the shape-correct companions to `primitives.ts`.
 *
 * The `uniform`/`jittered` policies are flat bands with hard floors and ceilings; a
 * timeline built from them has a distributional signature no amount of range-widening
 * removes (see docs/superpowers/plans/2026-08-15-macro-timing-realism.md §2). Real
 * human/organic inter-event times are log-normal within a session and heavy-tailed
 * overall (Barabási 2005; PNAS 2010 bimodal log-normal; Blasius 2016). These
 * constructors return the same `DelayPolicy` shape as `primitives`, so `sample()` and
 * `DelayManager.wait()` consume them unchanged.
 *
 * Pure and dependency-free (no Node, no Electron): the renderer imports these for the
 * settings live-preview. All randomness is injected via `Rng` and every draw is a
 * rounded, non-negative integer of milliseconds.
 */

import { PLAN_BOUNDS } from '../kernel/plan/policy';
import type { DelayPolicy, Rng } from './primitives';

/**
 * One standard-normal draw via the Box–Muller transform. Consumes the rng EXACTLY
 * twice (a fixed draw count keeps seeded tests deterministic, mirroring `jittered`).
 * `u1 = 1 - rng()` maps [0,1) → (0,1], so `ln(u1)` is always finite.
 */
export function normal01(rng: Rng): number {
  const u1 = 1 - rng();
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Log-normal by MEDIAN: `X = medianMs · exp(sigma · Z)`, Z ~ N(0,1). Median-
 * parameterized because the config reasons in medians (the mean is
 * `medianMs · exp(sigma²/2)`). `sigma` is the log-space spread; larger = heavier tail.
 */
export function logNormal(medianMs: number, sigma: number): DelayPolicy {
  const median = Math.max(0, medianMs);
  const s = Math.max(0, sigma);
  return {
    kind: 'log-normal',
    sample: (rng) => Math.round(median * Math.exp(s * normal01(rng))),
  };
}

/**
 * Bound another policy into `[minMs, maxMs]` by BOUNDED RE-DRAW: up to `CLAMP_REDRAWS` attempts,
 * returning the first sample in range. A pure projection would pile a detectable
 * spike of probability mass exactly at the bound (the very fingerprint we remove);
 * re-drawing preserves the interior shape and leaves only a tiny residual bound-mass.
 * After the last miss it projects onto the nearer bound (a hard safety fallback).
 */
export function clamp(inner: DelayPolicy, minMs: number, maxMs: number): DelayPolicy {
  const lo = Math.min(minMs, maxMs);
  const hi = Math.max(minMs, maxMs);
  return {
    kind: `clamp(${inner.kind})`,
    sample: (rng) => {
      let v = lo;
      for (let i = 0; i < PLAN_BOUNDS.CLAMP_REDRAWS; i += 1) {
        v = inner.sample(rng);
        if (v >= lo && v <= hi) return v;
      }
      return v < lo ? lo : hi;
    },
  };
}
