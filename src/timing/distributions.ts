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

/** One weighted component of a {@link logNormalMixture}. */
export interface LogNormalComponent {
  weight: number;
  medianMs: number;
  sigma: number;
}

/**
 * A mixture of log-normals — the empirically-correct bimodal shape for human
 * inter-activity (a fast within-session component + a slow between-session one).
 * One rng draw selects a component (by normalized weight), then a log-normal draw
 * from it (three draws total). Non-positive weights are ignored; an all-zero set
 * falls back to the first component.
 */
export function logNormalMixture(components: LogNormalComponent[]): DelayPolicy {
  const comps = components.length > 0 ? components : [{ weight: 1, medianMs: 0, sigma: 0 }];
  const total = comps.reduce((a, c) => a + Math.max(0, c.weight), 0);
  return {
    kind: 'log-normal-mixture',
    sample: (rng) => {
      const target = total > 0 ? rng() * total : 0;
      let acc = 0;
      let chosen = comps[0];
      for (const c of comps) {
        acc += Math.max(0, c.weight);
        if (target < acc) {
          chosen = c;
          break;
        }
      }
      return Math.round(chosen.medianMs * Math.exp(Math.max(0, chosen.sigma) * normal01(rng)));
    },
  };
}

/**
 * Weibull via inverse-CDF: `X = scaleMs · (−ln(1−u))^(1/shape)`. A `shape < 1`
 * gives a heavy tail (many small draws, a few very large) — the shape web-session
 * dwell/length fits. `shape` is floored at 0.05 and `1−u` at 1e-12 so the draw is
 * always finite and non-negative.
 */
export function weibull(scaleMs: number, shape: number): DelayPolicy {
  const scale = Math.max(0, scaleMs);
  const k = Math.max(0.05, shape);
  return {
    kind: 'weibull',
    sample: (rng) => Math.round(scale * (-Math.log(Math.max(1e-12, 1 - rng()))) ** (1 / k)),
  };
}

/**
 * Bounded Pareto (power law) via inverse-CDF over `[xMinMs, xMaxMs]`. Models the
 * heavy between-session/long-gap tail (web-browsing exponent α≈1.2, email≈1.0). The
 * result is always within the bounds by construction.
 */
export function pareto(xMinMs: number, alpha: number, xMaxMs: number): DelayPolicy {
  const xMin = Math.max(1, xMinMs);
  const xMax = Math.max(xMin, xMaxMs);
  const a = Math.max(0.01, alpha);
  const ratio = (xMin / xMax) ** a;
  return {
    kind: 'pareto',
    sample: (rng) => {
      const u = rng();
      const x = xMin / (1 - u * (1 - ratio)) ** (1 / a);
      return Math.round(Math.min(xMax, Math.max(xMin, x)));
    },
  };
}

/**
 * Bound another policy into `[minMs, maxMs]` by BOUNDED RE-DRAW: up to four attempts,
 * returning the first sample in range. A pure projection would pile a detectable
 * spike of probability mass exactly at the bound (the very fingerprint we remove);
 * re-drawing preserves the interior shape and leaves only a tiny residual bound-mass.
 * After four misses it projects onto the nearer bound (a hard safety fallback).
 */
export function clamp(inner: DelayPolicy, minMs: number, maxMs: number): DelayPolicy {
  const lo = Math.min(minMs, maxMs);
  const hi = Math.max(minMs, maxMs);
  return {
    kind: `clamp(${inner.kind})`,
    sample: (rng) => {
      let v = lo;
      for (let i = 0; i < 4; i += 1) {
        v = inner.sample(rng);
        if (v >= lo && v <= hi) return v;
      }
      return v < lo ? lo : hi;
    },
  };
}
