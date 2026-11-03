/**
 * The FROZEN v1 derivation (spec §6.10 †): the fourteen pattern-derived numbers as the snapshot-era
 * `derivePattern` made them, never the live kernel. Each depends on one ordinal knob, so a per-knob table
 * reproduces every pattern (pinned to the snapshot's 30 grid points and personas); the migration reads it.
 */
import type { PatternSettings, ResolvedPattern } from '../pattern-map';

export const V1_DERIVED = {
  activityLevel: {
    minimal: { dailyOperatingRate: 15, dailyHardCeiling: 20, dailyPlanSize: 18 },
    light: { dailyOperatingRate: 30, dailyHardCeiling: 39, dailyPlanSize: 36 },
    moderate: { dailyOperatingRate: 50, dailyHardCeiling: 65, dailyPlanSize: 60 },
    active: { dailyOperatingRate: 75, dailyHardCeiling: 98, dailyPlanSize: 90 },
    aggressive: { dailyOperatingRate: 100, dailyHardCeiling: 130, dailyPlanSize: 120 },
  },
  consistency: {
    clockwork: { dailyVolumeVariancePct: 12, restDayChancePct: 0 },
    natural: { dailyVolumeVariancePct: 28, restDayChancePct: 8 },
    erratic: { dailyVolumeVariancePct: 45, restDayChancePct: 18 },
  },
  rhythm: {
    trickle: { sessionsPerDayMin: 5, sessionsPerDayMax: 9, gapMedianSeconds: 180 },
    sessions: { sessionsPerDayMin: 3, sessionsPerDayMax: 6, gapMedianSeconds: 95 },
    bursts: { sessionsPerDayMin: 2, sessionsPerDayMax: 4, gapMedianSeconds: 55 },
  },
  caution: {
    cautious: { gapFloorSeconds: 60, hourlyVelocityCap: 14 },
    standard: { gapFloorSeconds: 45, hourlyVelocityCap: 22 },
    bold: { gapFloorSeconds: 35, hourlyVelocityCap: 30 },
  },
  cleanup: {
    off: { weaveEnabled: false, maxUnfollowFractionPerSession: 0 },
    trickle: { weaveEnabled: true, maxUnfollowFractionPerSession: 0.25 },
    steady: { weaveEnabled: true, maxUnfollowFractionPerSession: 0.5 },
    deep: { weaveEnabled: true, maxUnfollowFractionPerSession: 0.7 },
  },
  patience: {
    quick: { maxWaitForFollowbackDays: 2, holdAfterFollowbackDays: 1 },
    normal: { maxWaitForFollowbackDays: 4, holdAfterFollowbackDays: 2 },
    patient: { maxWaitForFollowbackDays: 7, holdAfterFollowbackDays: 4 },
  },
} as const;

/** The numbers v1 derived for `p` (the gap floor never above the median, as v1 clamped it). */
export function v1Derived(p: PatternSettings): ResolvedPattern {
  const out = {
    ...V1_DERIVED.activityLevel[p.activityLevel],
    ...V1_DERIVED.consistency[p.consistency],
    ...V1_DERIVED.rhythm[p.rhythm],
    ...V1_DERIVED.caution[p.caution],
    ...V1_DERIVED.cleanup[p.cleanup],
    ...V1_DERIVED.patience[p.patience],
  };
  return { ...out, gapFloorSeconds: Math.min(out.gapFloorSeconds, out.gapMedianSeconds) };
}
