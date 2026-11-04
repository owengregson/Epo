/** The current engine settings, resolved from intent and Advanced overrides. Frozen v1 inputs are migration-only. */
import { SCORER_DEFAULTS } from '@/engine/scorer';
import { derivePattern } from '@/kernel/derive';
import { ENVELOPE } from '@/kernel/derive-envelope';
import { deriveQuietHours, type QuietWindow } from '@/kernel/derive-schedule';
import { SETTINGS_GUARDS, SETTINGS_POLICY } from '@/kernel/settings-policy';
import type { TempoKey } from '@/kernel/tempo';
import { MS_PER_HOUR, MS_PER_MINUTE } from '@/kernel/units';
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
}

/**
 * Every engine number as v1 resolved it: what today's engine keeps running on,
 * and what a refused migration serves from the readable v1 file.
 */
export function effectiveFromV1(v1: Settings): EffectiveSettings {
  const historical = SETTINGS_POLICY.V1_MIGRATION;
  const scanFactor = (v1.pruneScanMinSeconds + v1.pruneScanMaxSeconds)
    / (DEFAULT_SETTINGS.pruneScanMinSeconds + DEFAULT_SETTINGS.pruneScanMaxSeconds);
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
    quietHours: quietWindowOf(quietHoursOfActive(v1.activeHoursStart, v1.activeHoursEnd), v1.pattern.dayShape), daysOff: [],
    // Retired fields constrain the plan on refusal. Safe-side legacy waits must not shrink before recovery.
    checkSpacingHoursOverride: v1.followbackSweepHours !== historical.followbackSweepHours
      && v1.followbackSweepHours >= ENVELOPE.checksEveryHours.min ? v1.followbackSweepHours : null,
    cleanupPerDayOverride: v1.pruneDailyLimit === historical.pruneDailyLimit ? null : Math.min(v1.pruneDailyLimit, v1.dailyHardCeiling),
    censusEveryDaysOverride: v1.pruneScheduleDays > 0 && v1.pruneScheduleDays !== historical.pruneScheduleDays
      ? Math.max(SETTINGS_GUARDS.censusEveryDays.min, v1.pruneScheduleDays) : null,
    tempoOverrides: scanFactor > 1 ? { 'walk.page': Math.min(scanFactor, SETTINGS_POLICY.TEMPO_OVERRIDE_MAX_FACTOR) } : {},
    weaveEnabled: v1.weaveEnabled, maxUnfollowFractionPerSession: v1.maxUnfollowFractionPerSession,
    lowWaterCandidates: v1.lowWaterCandidates, minFollowBackRate: v1.minFollowBackRate, minPoolSize: v1.minPoolSize,
    dryRun: v1.dryRun,
    // v1 has no Boost; its preferences read as the defaults until a v2 document exists.
    boost: { hours: SETTINGS_POLICY.BOOST.DEFAULT_HOURS, acceptRequests: true },
  };
}

/** The shared migration/refusal mapping: default active hours derive; custom [start, end) becomes [end, start) quiet. */
export function quietHoursOfActive(start: number, end: number): QuietHours {
  if (start === DEFAULT_SETTINGS.activeHoursStart && end === DEFAULT_SETTINGS.activeHoursEnd) return { kind: 'derived' };
  const minutesPerHour = MS_PER_HOUR / MS_PER_MINUTE;
  return start === end ? { kind: 'none' } : { kind: 'custom', startMinute: end * minutesPerHour, endMinute: start * minutesPerHour };
}

// Finite ordinal inputs; copies keep callers from mutating a cached window.
const quietByShape: Partial<Record<DayShape, QuietWindow>> = {};

/** The window a quiet-hours choice resolves to (null: none). */
export function quietWindowOf(q: QuietHours, dayShape: DayShape): QuietWindow | null {
  if (q.kind === 'none') return null;
  if (q.kind === 'custom') return { startMinute: q.startMinute, endMinute: q.endMinute };
  const window = quietByShape[dayShape] ?? deriveQuietHours(dayShape);
  quietByShape[dayShape] = window;
  return { ...window };
}

const TEMPO_PREFIX = 'tempo.';

/** What the engine consumes, from the document and its resolved parameters (spec §6.9). */
export function effectiveFrom(doc: SettingsDocV2, r: ResolvedParams): EffectiveSettings {
  const n = (k: ParamKey): number => numberOf(r, k);
  const overridden = (k: ParamKey): number | null => (r[k].override === null ? null : n(k));
  const { intent, prefs } = doc;
  const pattern = patternOf(intent);
  const shape = derivePattern(pattern);
  const curve = r['audience.ratioCurve'].value as RatioCurve;
  const range = r['audience.followerRange'].value as { min: number; max: number };
  const cleanupOn = intent.cleanup !== 'off';
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
  };
}
