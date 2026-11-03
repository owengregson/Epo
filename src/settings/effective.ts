/**
 * What the engine consumes (spec §6.9, Appendix B.3): a flat record keeping the v1 field names wherever the
 * meaning is unchanged, so the `toXConfig` mappers and engine call sites barely move. There is no alias: the
 * renderer keeps the frozen v1 `Settings` until the Settings stage replaces it.
 */
import { SCORER_DEFAULTS } from '@/engine/scorer';
import { derivePattern } from '@/kernel/derive';
import { deriveQuietHours, type QuietWindow } from '@/kernel/derive-schedule';
import { SETTINGS_POLICY } from '@/kernel/settings-policy';
import type { TempoKey } from '@/kernel/tempo';
import type { DayOfWeek, DayShape, QuietHours } from '@/shared/settings-intent';
import type { RatioCurve } from '@/shared/settings-model';
import { type ParamKey, TEMPO_PARAM_KEYS } from '@/shared/settings-params';
import { patternOf } from './basis';
import type { SettingsDocV2 } from './doc';
import type { PatternSettings } from './pattern-map';
import { numberOf, type ResolvedParams } from './resolve';
import { DEFAULT_SETTINGS } from './v1/settings-v1';
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
    followbackSweepHours: v1.followbackSweepHours,
    pruneDailyLimit: v1.pruneDailyLimit, pruneScheduleDays: v1.pruneScheduleDays,
    pruneScanMinSeconds: v1.pruneScanMinSeconds, pruneScanMaxSeconds: v1.pruneScanMaxSeconds,
  };
}

/** The window a quiet-hours choice resolves to (null: none). */
export function quietWindowOf(q: QuietHours, dayShape: DayShape): QuietWindow | null {
  if (q.kind === 'none') return null;
  return q.kind === 'derived' ? deriveQuietHours(dayShape) : { startMinute: q.startMinute, endMinute: q.endMinute };
}

const TEMPO_PREFIX = 'tempo.';

/** What the engine consumes, from the document and its resolved parameters (spec §6.9). */
export function effectiveFrom(doc: SettingsDocV2, r: ResolvedParams): EffectiveSettings {
  const n = (k: ParamKey): number => numberOf(r, k);
  const overridden = (k: ParamKey): number | null => (r[k].override === null ? null : n(k));
  const { intent, prefs, legacyCarry: carry } = doc;
  const pattern = patternOf(intent);
  const shape = derivePattern(pattern);
  const curve = r['audience.ratioCurve'].value as RatioCurve;
  const range = r['audience.followerRange'].value as { min: number; max: number };
  const cleanupOn = intent.cleanup !== 'off';
  const scanFactor = overridden('tempo.walk.page') ?? 1;
  return {
    seed: doc.seed,
    ...curve, minFollowers: range.min, maxFollowers: range.max, privateBoost: n('audience.privateBoost'),
    mutualWeight: n('audience.mutualWeight'), mutualCap: n('audience.mutualCap'), bandEdgeScore: n('audience.bandEdgeScore'),
    maxWaitForFollowbackDays: n('unfollow.waitDays'), holdAfterFollowbackDays: n('unfollow.holdDays'),
    rotateMutuals: intent.mutuals === 'rotate', maxRetries: n('unfollow.attempts'),
    autoAcceptFollowRequests: prefs.acceptRequests,
    pattern,
    dailyOperatingRate: n('pace.dailyVolume'), dailyHardCeiling: n('pace.dailyCeiling'), dailyPlanSize: n('pace.candidateBuffer'),
    dailyVolumeVariancePct: n('pace.dayVariation'), restDayChancePct: n('pace.restDayChance'),
    sessionsPerDayMin: n('sessions.perDayMin'), sessionsPerDayMax: n('sessions.perDayMax'),
    gapMedianSeconds: shape.gapMedianSeconds, gapFloorSeconds: shape.gapFloorSeconds,
    gapTargetOverrideSeconds: overridden('sessions.gapTypical'), gapFloorOverrideSeconds: overridden('sessions.gapMinimum'),
    hourlyVelocityCap: n('pace.hourlyCap'),
    quietHours: quietWindowOf(intent.quietHours, intent.dayShape),
    daysOff: [...intent.daysOff],
    checkSpacingHoursOverride: overridden('checks.everyHours'),
    cleanupPerDayOverride: overridden('unfollow.cleanupPerDay'),
    censusEveryDaysOverride: overridden('unfollow.censusEveryDays'),
    tempoOverrides: Object.fromEntries(TEMPO_PARAM_KEYS.filter((k) => r[k].override !== null)
      .map((k) => [k.slice(TEMPO_PREFIX.length) as TempoKey, n(k)])),
    weaveEnabled: cleanupOn, maxUnfollowFractionPerSession: cleanupOn ? n('unfollow.cleanupShare') : 0,
    lowWaterCandidates: n('explore.refillBelow'), minFollowBackRate: n('explore.moveOnRate'), minPoolSize: n('explore.moveOnPool'),
    dryRun: prefs.practice,
    boost: { ...prefs.boost },
    pacingModel: carry?.pacingModel ?? DEFAULT_SETTINGS.pacingModel,
    minDelayMinutes: carry?.minDelayMinutes ?? DEFAULT_SETTINGS.minDelayMinutes,
    maxDelayMinutes: carry?.maxDelayMinutes ?? DEFAULT_SETTINGS.maxDelayMinutes,
    jitterPercent: carry?.jitterPercent ?? DEFAULT_SETTINGS.jitterPercent,
    activeHoursStart: carry?.activeHoursStart ?? DEFAULT_SETTINGS.activeHoursStart,
    activeHoursEnd: carry?.activeHoursEnd ?? DEFAULT_SETTINGS.activeHoursEnd,
    followbackSweepHours: n('checks.everyHours'),
    pruneDailyLimit: n('unfollow.cleanupPerDay'), pruneScheduleDays: cleanupOn ? n('unfollow.censusEveryDays') : 0,
    pruneScanMinSeconds: DEFAULT_SETTINGS.pruneScanMinSeconds * scanFactor,
    pruneScanMaxSeconds: DEFAULT_SETTINGS.pruneScanMaxSeconds * scanFactor,
  };
}
