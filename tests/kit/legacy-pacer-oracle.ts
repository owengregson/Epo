/**
 * The retired legacy pacer's draw, frozen as a test oracle (spec §5.13: "the legacy oracle mean computed
 * in-test from `jittered(3, 7, 30 %)`"): a base uniform in [min, max], then ± `jitterPercent` of it,
 * clamped to ±95 %, rng consumed twice (base, then jitter); and the legacy day law `min(planner volume,
 * cyclePlan)`. Production no longer carries either.
 */
import { PATTERN } from '@/kernel/derive';
import { mulberry32 } from '@/kernel/rng';
import { normal01 } from '@/timing/distributions';
import type { DelayPolicy } from '@/timing/primitives';

export function legacyJittered(minMs: number, maxMs: number, jitterPercent: number): DelayPolicy {
  const j = Math.min(95, Math.max(0, jitterPercent));
  return {
    kind: 'legacy-jittered',
    sample: (rng) => {
      const base = minMs + rng() * (maxMs - minMs);
      const jitter = base * (j / 100) * (rng() * 2 - 1);
      return Math.max(0, Math.round(base + jitter));
    },
  };
}

/** The legacy oracle's mean gap: the jitter term is symmetric, so the mean is the band's midpoint. */
export const legacyMeanGapMs = (minMs: number, maxMs: number): number => (minMs + maxMs) / 2;

/** The legacy per-cycle plan, verbatim (its module retired once the plan drew the day). */
export function legacyCyclePlan(cap: number, cycleStartMs: number): number {
  if (cap < PATTERN.CYCLE_PLAN_MIN_CAP) return Math.max(1, Math.round(cap));
  const seed = Math.imul(Math.floor(cycleStartMs / 60_000) >>> 0, 0x9e3779b1) ^ Math.imul(cap, 0x85ebca6b);
  const u = mulberry32(seed)();
  const { CYCLE_PLAN_MIN_FRACTION: lo, CYCLE_PLAN_MAX_FRACTION: hi } = PATTERN;
  return Math.min(cap - 1, Math.max(1, Math.round(cap * (lo + u * (hi - lo)))));
}

/** The legacy realized automatic day: the planner's volume draw capped by the cycle plan (spec §5.4). */
export function legacyDay(p0: number, ceiling: number, sigma: number, restP: number, rng: () => number, cycleAt: number): number {
  const target = rng() < restP ? Math.round(p0 * (rng() * PATTERN.REST_DAY_MAX_FRACTION)) : Math.round(p0 * Math.exp(sigma * normal01(rng)));
  return Math.min(Math.max(0, Math.min(ceiling, target)), legacyCyclePlan(p0, cycleAt));
}
