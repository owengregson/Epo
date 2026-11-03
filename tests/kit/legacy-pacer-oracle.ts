/**
 * The retired legacy pacer's draw, frozen as a test oracle (spec §5.13: "the legacy oracle mean computed
 * in-test from `jittered(3, 7, 30 %)`"): a base uniform in [min, max], then ± `jitterPercent` of it,
 * clamped to ±95 %, rng consumed twice (base, then jitter). Production no longer carries it.
 */
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
