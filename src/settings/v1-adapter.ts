/**
 * @transitional — the v1 window onto the v2 document (spec §6.10 "Rollout compatibility"), deleted with
 * the old Settings UI: `toV1Settings` fills the frozen v1 `Settings` from the effective record, and
 * `opsFromV1Partial` turns an old renderer's partial into keyed v2 ops (lists diffed, never replaced).
 */
import type { ParamValue, RatioCurve } from '@/shared/settings-model';
import type { SettingsOp } from '@/shared/settings-ops';
import type { ParamKey } from '@/shared/settings-params';
import type { SettingsDocV2 } from './doc';
import type { EffectiveSettings } from './effective';
import { sameValue } from './params-spec';
import { type PatternSettings, PERSONAS, type PersonaId } from './pattern-map';
import type { ResolvedParams } from './resolve';
import { DEFAULT_SETTINGS } from './v1/settings-v1';
import type { Settings } from './v1/settings-v1-types';

/** The v1 run stamps the transitional engine readers still keep, carried in the migration record. */
export interface V1Bookkeeping {
  readonly sweepLastRunAt: number | null;
  readonly sweepIntervalFactor: number | null;
  readonly pruneLastRunAt: number | null;
}

export function toV1Settings(e: EffectiveSettings, doc: SettingsDocV2, bk: V1Bookkeeping | null): Settings {
  return {
    seed: e.seed, bandLow: e.bandLow, bandHigh: e.bandHigh, peakLow: e.peakLow, peakHigh: e.peakHigh, hardLow: e.hardLow,
    hardHigh: e.hardHigh, minFollowers: e.minFollowers, maxFollowers: e.maxFollowers, privateBoost: e.privateBoost,
    maxWaitForFollowbackDays: e.maxWaitForFollowbackDays, holdAfterFollowbackDays: e.holdAfterFollowbackDays,
    maxRetries: e.maxRetries, dailyHardCeiling: e.dailyHardCeiling, dailyOperatingRate: e.dailyOperatingRate,
    minDelayMinutes: e.minDelayMinutes, maxDelayMinutes: e.maxDelayMinutes, jitterPercent: e.jitterPercent,
    activeHoursStart: e.activeHoursStart, activeHoursEnd: e.activeHoursEnd, followbackSweepHours: e.followbackSweepHours,
    sweepLastRunAt: bk?.sweepLastRunAt ?? null, sweepIntervalFactor: bk?.sweepIntervalFactor ?? DEFAULT_SETTINGS.sweepIntervalFactor,
    autoAcceptFollowRequests: e.autoAcceptFollowRequests, dailyPlanSize: e.dailyPlanSize,
    lowWaterCandidates: e.lowWaterCandidates, minFollowBackRate: e.minFollowBackRate, minPoolSize: e.minPoolSize,
    dryRun: e.dryRun, pruneWhitelist: [...e.pruneWhitelist], pruneBioFilterWords: [...e.pruneBioFilterWords],
    pruneDailyLimit: e.pruneDailyLimit, pruneScheduleDays: e.pruneScheduleDays, pruneLastRunAt: bk?.pruneLastRunAt ?? null,
    pruneScanMinSeconds: e.pruneScanMinSeconds, pruneScanMaxSeconds: e.pruneScanMaxSeconds, pacingModel: e.pacingModel,
    dailyVolumeVariancePct: e.dailyVolumeVariancePct, restDayChancePct: e.restDayChancePct,
    sessionsPerDayMin: e.sessionsPerDayMin, sessionsPerDayMax: e.sessionsPerDayMax, gapMedianSeconds: e.gapMedianSeconds,
    gapFloorSeconds: e.gapFloorSeconds, hourlyVelocityCap: e.hourlyVelocityCap, weaveEnabled: e.weaveEnabled,
    maxUnfollowFractionPerSession: e.maxUnfollowFractionPerSession, persona: 'custom', pattern: { ...e.pattern },
    tourCompletedAt: doc.app.tourCompletedAt,
  };
}

/** A v1 number knob and the parameter that now holds it. */
const NUMBER_ROWS: ReadonlyArray<readonly [keyof Settings, ParamKey]> = [
  ['dailyOperatingRate', 'pace.dailyVolume'], ['dailyHardCeiling', 'pace.dailyCeiling'], ['dailyPlanSize', 'pace.candidateBuffer'],
  ['dailyVolumeVariancePct', 'pace.dayVariation'], ['restDayChancePct', 'pace.restDayChance'],
  ['sessionsPerDayMin', 'sessions.perDayMin'], ['sessionsPerDayMax', 'sessions.perDayMax'], ['hourlyVelocityCap', 'pace.hourlyCap'],
  ['maxUnfollowFractionPerSession', 'unfollow.cleanupShare'], ['maxWaitForFollowbackDays', 'unfollow.waitDays'],
  ['holdAfterFollowbackDays', 'unfollow.holdDays'], ['maxRetries', 'unfollow.attempts'], ['followbackSweepHours', 'checks.everyHours'],
  ['pruneDailyLimit', 'unfollow.cleanupPerDay'], ['lowWaterCandidates', 'explore.refillBelow'],
  ['minFollowBackRate', 'explore.moveOnRate'], ['minPoolSize', 'explore.moveOnPool'], ['privateBoost', 'audience.privateBoost'],
];
const ALL_DIGITS = /^\d+$/;
const meanOf = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const CURVE_KEYS = ['hardLow', 'bandLow', 'peakLow', 'peakHigh', 'bandHigh', 'hardHigh'] as const;
const INTENT_OF = {
  activityLevel: 'activity', consistency: 'consistency', rhythm: 'rhythm', dayShape: 'dayShape', weeklyShape: 'weeklyShape',
  caution: 'caution', patience: 'patience',
} as const;
/** Knobs v2 derives or no longer has: an old renderer's write of them is dropped (and logged by the caller). */
const DROPPED = new Set<keyof Settings>(['minDelayMinutes', 'maxDelayMinutes', 'jitterPercent', 'activeHoursStart',
  'activeHoursEnd', 'pacingModel', 'gapMedianSeconds', 'gapFloorSeconds']);

export interface V1Translation {
  readonly ops: readonly SettingsOp[];
  readonly dropped: readonly string[];
  readonly bookkeeping: Partial<V1Bookkeeping>;
}

/** Translate an old renderer's partial into keyed ops against the current state (unchanged keys emit nothing). */
export function opsFromV1Partial(partial: Partial<Settings>, current: Settings, r: ResolvedParams): V1Translation {
  const ops: SettingsOp[] = [];
  const dropped: string[] = [];
  const bookkeeping: { -readonly [K in keyof V1Bookkeeping]?: V1Bookkeeping[K] } = {};
  /** The partial's value for `k` when it differs from the current one, else undefined. */
  const got = <K extends keyof Settings>(k: K): Settings[K] | undefined =>
    partial[k] !== undefined && JSON.stringify(partial[k]) !== JSON.stringify(current[k]) ? partial[k] : undefined;
  const changed = (k: keyof Settings): boolean => got(k) !== undefined;
  const param = (key: ParamKey, value: ParamValue): void => {
    ops.push(sameValue(value, r[key].recommended) ? { op: 'clear-override', key } : { op: 'override', key, value });
  };
  const seed = got('seed');
  if (seed !== undefined) ops.push({ op: 'seed', handle: seed });
  const persona = partial.persona;
  const named = typeof persona === 'string' && persona !== 'custom' && persona in PERSONAS
    ? PERSONAS[persona as Exclude<PersonaId, 'custom'>] : null;
  const pattern: PatternSettings | null = named ?? got('pattern') ?? null;
  if (pattern !== null) {
    for (const [knob, key] of Object.entries(INTENT_OF) as [keyof typeof INTENT_OF, (typeof INTENT_OF)[keyof typeof INTENT_OF]][]) {
      if (pattern[knob] !== current.pattern[knob]) ops.push({ op: 'intent', key, value: pattern[knob] } as SettingsOp);
    }
  }
  const dryRun = got('dryRun');
  if (dryRun !== undefined) ops.push({ op: 'pref', key: 'practice', value: dryRun });
  const accept = got('autoAcceptFollowRequests');
  if (accept !== undefined) ops.push({ op: 'pref', key: 'acceptRequests', value: accept });
  const tour = got('tourCompletedAt');
  if (tour !== undefined && tour !== null) ops.push({ op: 'tour-completed', at: tour });
  const whitelist = got('pruneWhitelist');
  if (whitelist !== undefined) {
    const now = new Set(current.pruneWhitelist.map((s) => s.toLowerCase()));
    const next = new Set(whitelist.map((s) => s.toLowerCase()));
    const added = [...next].filter((s) => !now.has(s));
    if (added.length > 0) ops.push({ op: 'protect-add', entries: added.map((username) => ({ username })), source: 'you' });
    for (const s of now) if (!next.has(s)) ops.push({ op: 'protect-remove', match: ALL_DIGITS.test(s) ? { pk: s } : { username: s } });
  }
  const words = got('pruneBioFilterWords');
  if (words !== undefined) {
    const added = words.filter((w) => !current.pruneBioFilterWords.includes(w));
    if (added.length > 0) ops.push({ op: 'word-add', texts: added });
    for (const w of current.pruneBioFilterWords) if (!words.includes(w)) ops.push({ op: 'word-remove', text: w });
  }
  const cleanupFrom = (on: boolean): void => {
    const level = (pattern ?? current.pattern).cleanup;
    const want = on ? (level === 'off' ? 'trickle' : level === 'deep' ? 'steady' : level) : 'off';
    ops.push({ op: 'intent', key: 'cleanup', value: want });
  };
  const weave = got('weaveEnabled');
  if (weave !== undefined) cleanupFrom(weave);
  const schedule = got('pruneScheduleDays');
  if (schedule !== undefined) {
    cleanupFrom(schedule > 0);
    if (schedule > 0) param('unfollow.censusEveryDays', schedule);
  }
  for (const [knob, key] of NUMBER_ROWS) {
    const v = got(knob);
    if (typeof v === 'number') param(key, v);
  }
  if (changed('minFollowers') || changed('maxFollowers')) {
    param('audience.followerRange', { min: partial.minFollowers ?? current.minFollowers, max: partial.maxFollowers ?? current.maxFollowers });
  }
  if (CURVE_KEYS.some((k) => changed(k))) {
    param('audience.ratioCurve', Object.fromEntries(CURVE_KEYS.map((k) => [k, partial[k] ?? current[k]])) as unknown as RatioCurve);
  }
  if (changed('pruneScanMinSeconds') || changed('pruneScanMaxSeconds')) {
    const mean = meanOf([partial.pruneScanMinSeconds ?? current.pruneScanMinSeconds, partial.pruneScanMaxSeconds ?? current.pruneScanMaxSeconds]);
    param('tempo.walk.page', mean / meanOf([DEFAULT_SETTINGS.pruneScanMinSeconds, DEFAULT_SETTINGS.pruneScanMaxSeconds]));
  }
  if ('sweepLastRunAt' in partial) bookkeeping.sweepLastRunAt = partial.sweepLastRunAt ?? null;
  if ('sweepIntervalFactor' in partial) bookkeeping.sweepIntervalFactor = partial.sweepIntervalFactor ?? null;
  if ('pruneLastRunAt' in partial) bookkeeping.pruneLastRunAt = partial.pruneLastRunAt ?? null;
  for (const k of DROPPED) if (changed(k)) dropped.push(k);
  return { ops, dropped, bookkeeping };
}
