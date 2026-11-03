/**
 * What the engine consumes (spec §6.9, Appendix B.3): a flat record that keeps
 * the v1 field names wherever the meaning is unchanged, so the `toXConfig`
 * mappers and engine call sites barely move. There is no alias: the renderer
 * keeps the frozen v1 `Settings` until the Settings stage replaces it.
 */
import { SCORER_DEFAULTS } from '@/engine/scorer';
import { SETTINGS_POLICY } from '@/kernel/settings-policy';
import type { TempoKey } from '@/kernel/tempo';
import type { DayOfWeek } from '@/shared/settings-intent';
import type { PatternSettings } from './pattern-map';
import type { Settings } from './v1/settings-v1-types';

export interface EffectiveSettings {
  seed: string;
  // scorer
  bandLow: number; bandHigh: number; peakLow: number; peakHigh: number; hardLow: number; hardHigh: number;
  minFollowers: number; maxFollowers: number; privateBoost: number;
  mutualWeight: number; mutualCap: number; bandEdgeScore: number;
  // lifecycle
  maxWaitForFollowbackDays: number; holdAfterFollowbackDays: number; rotateMutuals: boolean; maxRetries: number;
  autoAcceptFollowRequests: boolean;
  // plan inputs (the intent ordinals and cleanup)
  pattern: PatternSettings;
  dailyOperatingRate: number; dailyHardCeiling: number; dailyPlanSize: number;
  dailyVolumeVariancePct: number; restDayChancePct: number;
  sessionsPerDayMin: number; sessionsPerDayMax: number;
  /** The reference gap shape (internal). */
  gapMedianSeconds: number; gapFloorSeconds: number;
  /** Effective scale, slower only. */
  gapTargetOverrideSeconds: number | null; gapFloorOverrideSeconds: number | null;
  hourlyVelocityCap: number;
  /** Resolved; null when there are no quiet hours. */
  quietHours: { readonly startMinute: number; readonly endMinute: number } | null;
  daysOff: readonly DayOfWeek[];
  checkSpacingHoursOverride: number | null; cleanupPerDayOverride: number | null; censusEveryDaysOverride: number | null;
  /** The `tempo.<key>` overrides: reference factors in [1, TEMPO_OVERRIDE_MAX_FACTOR], slower only. */
  tempoOverrides: Readonly<Partial<Record<TempoKey, number>>>;
  // cleanup of own follows
  weaveEnabled: boolean; maxUnfollowFractionPerSession: number;
  // exploration
  lowWaterCandidates: number; minFollowBackRate: number; minPoolSize: number;
  // prefs
  dryRun: boolean;
  boost: { readonly hours: number; readonly acceptRequests: boolean };
  /** @transitional — deleted with the legacy pacer. */
  pacingModel: 'legacy' | 'organic'; minDelayMinutes: number; maxDelayMinutes: number; jitterPercent: number;
  activeHoursStart: number; activeHoursEnd: number;
  /** @transitional — deleted once every unfollow path reads the protection port. */
  pruneWhitelist: string[]; pruneBioFilterWords: string[];
  /** @transitional — the sweep cadence moves to plan checks. */
  followbackSweepHours: number;
  /** @transitional — the prune daily plan and the scheduled prune are deleted. */
  pruneDailyLimit: number; pruneScheduleDays: number;
  /** @transitional — superseded by the walk.page tempo. */
  pruneScanMinSeconds: number; pruneScanMaxSeconds: number;
}

/**
 * Every engine number as v1 resolved it: what today's engine keeps running on,
 * and what a refused migration serves from the readable v1 file.
 */
export function effectiveFromV1(v1: Settings): EffectiveSettings {
  return {
    seed: v1.seed,
    bandLow: v1.bandLow, bandHigh: v1.bandHigh, peakLow: v1.peakLow, peakHigh: v1.peakHigh,
    hardLow: v1.hardLow, hardHigh: v1.hardHigh,
    minFollowers: v1.minFollowers, maxFollowers: v1.maxFollowers, privateBoost: v1.privateBoost,
    mutualWeight: SCORER_DEFAULTS.mutualWeight, mutualCap: SCORER_DEFAULTS.mutualCap,
    bandEdgeScore: SCORER_DEFAULTS.bandEdgeScore,
    maxWaitForFollowbackDays: v1.maxWaitForFollowbackDays, holdAfterFollowbackDays: v1.holdAfterFollowbackDays,
    rotateMutuals: true, maxRetries: v1.maxRetries, autoAcceptFollowRequests: v1.autoAcceptFollowRequests,
    pattern: { ...v1.pattern },
    dailyOperatingRate: v1.dailyOperatingRate, dailyHardCeiling: v1.dailyHardCeiling, dailyPlanSize: v1.dailyPlanSize,
    dailyVolumeVariancePct: v1.dailyVolumeVariancePct, restDayChancePct: v1.restDayChancePct,
    sessionsPerDayMin: v1.sessionsPerDayMin, sessionsPerDayMax: v1.sessionsPerDayMax,
    gapMedianSeconds: v1.gapMedianSeconds, gapFloorSeconds: v1.gapFloorSeconds,
    gapTargetOverrideSeconds: null, gapFloorOverrideSeconds: null,
    hourlyVelocityCap: v1.hourlyVelocityCap,
    quietHours: null, daysOff: [],
    checkSpacingHoursOverride: null, cleanupPerDayOverride: null, censusEveryDaysOverride: null,
    // Today's engine paces the scan from pruneScan*Seconds itself, so no walk.page factor here.
    tempoOverrides: {},
    weaveEnabled: v1.weaveEnabled, maxUnfollowFractionPerSession: v1.maxUnfollowFractionPerSession,
    lowWaterCandidates: v1.lowWaterCandidates, minFollowBackRate: v1.minFollowBackRate, minPoolSize: v1.minPoolSize,
    dryRun: v1.dryRun,
    // v1 has no Boost; its preferences read as the defaults until a v2 document exists.
    boost: { hours: SETTINGS_POLICY.BOOST.DEFAULT_HOURS, acceptRequests: true },
    pacingModel: v1.pacingModel, minDelayMinutes: v1.minDelayMinutes, maxDelayMinutes: v1.maxDelayMinutes,
    jitterPercent: v1.jitterPercent, activeHoursStart: v1.activeHoursStart, activeHoursEnd: v1.activeHoursEnd,
    pruneWhitelist: [...v1.pruneWhitelist], pruneBioFilterWords: [...v1.pruneBioFilterWords],
    followbackSweepHours: v1.followbackSweepHours,
    pruneDailyLimit: v1.pruneDailyLimit, pruneScheduleDays: v1.pruneScheduleDays,
    pruneScanMinSeconds: v1.pruneScanMinSeconds, pruneScanMaxSeconds: v1.pruneScanMaxSeconds,
  };
}
