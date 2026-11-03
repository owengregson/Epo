/**
 * @transitional — the v1 window onto the v2 document (spec §6.10 "Rollout compatibility"), deleted with
 * the old Settings UI: `toV1Settings` fills the frozen v1 `Settings` from the effective record, and
 * `opsFromV1Partial` turns an old renderer's partial into keyed v2 ops (lists diffed, never replaced).
 */
import { MS_PER_HOUR, MS_PER_MINUTE } from '@/kernel/units';
import type { ParamValue, RatioCurve } from '@/shared/settings-model';
import type { SettingsOp } from '@/shared/settings-ops';
import type { ParamKey } from '@/shared/settings-params';
import { DEFAULT_DOC, type SettingsDocV2 } from './doc';
import type { EffectiveSettings } from './effective';
import { RETIRED_PACER_KEYS } from './legacy-pacing-migration';
import { quietHoursOfActive } from './migrate-v1';
import { migrateAccountList, migrateWordList } from './migrate-v1-lists';
import { sameValue } from './params-spec';
import { type PatternSettings, PERSONAS, type PersonaId } from './pattern-map';
import type { ResolvedParams } from './resolve';
import { DEFAULT_SETTINGS, migrateLegacyPattern, sanitizeSettings } from './v1/settings-v1';
import type { Settings } from './v1/settings-v1-types';

/** The v1 run stamps the transitional engine readers still keep, carried in the migration record. */
export interface V1Bookkeeping {
  readonly sweepLastRunAt: number | null;
  readonly sweepIntervalFactor: number | null;
  readonly pruneLastRunAt: number | null;
}

const MINUTES_PER_HOUR = MS_PER_HOUR / MS_PER_MINUTE;

/** v1's active hours from the resolved quiet window (the inverse of `quietHoursOfActive`; none is start = end). */
const activeHoursOf = (q: EffectiveSettings['quietHours']): { readonly start: number; readonly end: number } =>
  q === null ? { start: 0, end: 0 } : { start: Math.floor(q.endMinute / MINUTES_PER_HOUR), end: Math.floor(q.startMinute / MINUTES_PER_HOUR) };

export function toV1Settings(e: EffectiveSettings, doc: SettingsDocV2, bk: V1Bookkeeping | null): Settings {
  const active = activeHoursOf(e.quietHours);
  return {
    seed: e.seed, bandLow: e.bandLow, bandHigh: e.bandHigh, peakLow: e.peakLow, peakHigh: e.peakHigh, hardLow: e.hardLow,
    hardHigh: e.hardHigh, minFollowers: e.minFollowers, maxFollowers: e.maxFollowers, privateBoost: e.privateBoost,
    maxWaitForFollowbackDays: e.maxWaitForFollowbackDays, holdAfterFollowbackDays: e.holdAfterFollowbackDays,
    maxRetries: e.maxRetries, dailyHardCeiling: e.dailyHardCeiling, dailyOperatingRate: e.dailyOperatingRate,
    // The retired pacer's knobs read as v1's defaults (the day plan paces); active hours mirror the quiet window.
    minDelayMinutes: DEFAULT_SETTINGS.minDelayMinutes, maxDelayMinutes: DEFAULT_SETTINGS.maxDelayMinutes,
    jitterPercent: DEFAULT_SETTINGS.jitterPercent, activeHoursStart: active.start, activeHoursEnd: active.end,
    followbackSweepHours: e.followbackSweepHours,
    sweepLastRunAt: bk?.sweepLastRunAt ?? null, sweepIntervalFactor: bk?.sweepIntervalFactor ?? DEFAULT_SETTINGS.sweepIntervalFactor,
    autoAcceptFollowRequests: e.autoAcceptFollowRequests, dailyPlanSize: e.dailyPlanSize,
    lowWaterCandidates: e.lowWaterCandidates, minFollowBackRate: e.minFollowBackRate, minPoolSize: e.minPoolSize,
    dryRun: e.dryRun,
    // The lists come from the document (the effective record no longer carries them). Today's whitelist matches a
    // handle or an all-digit pk; a linked entry contributes both.
    pruneWhitelist: doc.protection.accounts.flatMap((a) => (a.pk !== null && a.pk !== a.username ? [a.username, a.pk] : [a.username])),
    pruneBioFilterWords: doc.protection.words.map((w) => w.text),
    pruneDailyLimit: e.pruneDailyLimit, pruneScheduleDays: e.pruneScheduleDays, pruneLastRunAt: bk?.pruneLastRunAt ?? null,
    pruneScanMinSeconds: e.pruneScanMinSeconds, pruneScanMaxSeconds: e.pruneScanMaxSeconds, pacingModel: 'organic',
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
/** Knobs v2 no longer has (reference-scale gaps, the retired pacer): an old renderer's write is dropped and logged. */
const DROPPED = new Set<keyof Settings>(['gapMedianSeconds', 'gapFloorSeconds', ...RETIRED_PACER_KEYS]);

export interface V1Translation {
  readonly ops: readonly SettingsOp[];
  readonly dropped: readonly string[];
  readonly bookkeeping: Partial<V1Bookkeeping>;
}

type OwnedStamps = V1Bookkeeping & { readonly forPk: string | null };

/** The stamps of the account `ownPk` (unbound: any); unowned migration stamps belong to the first account bound. */
export function stampsFor(bk: OwnedStamps | null, ownPk: string | null, firstPk: string | null): OwnedStamps | null {
  if (bk === null || ownPk === null) return bk;
  return (bk.forPk ?? firstPk) === ownPk ? bk : null;
}

/** The next document with a stamp patch recorded for `owner`; another account's stamps start over. */
export function withStamps(doc: SettingsDocV2, patch: Partial<V1Bookkeeping>, owner: string | null, firstPk: string | null,
  now: number): SettingsDocV2 {
  const m = doc.migration ?? { at: now, fromV1: null, notes: [], bookkeeping: null };
  const prior = stampsFor(m.bookkeeping, owner, firstPk);
  const bookkeeping = { sweepLastRunAt: null, sweepIntervalFactor: null, pruneLastRunAt: null, ...prior, ...patch,
    forPk: owner ?? m.bookkeeping?.forPk ?? null };
  return { ...doc, rev: doc.rev + 1, migration: { ...m, bookkeeping } };
}

/** What a refused migration runs on (spec §6.10): v1's own numbers, its raw lists as protection, practice carried. */
export function refusedState(raw: string, now: number):
  { readonly kind: 'v1'; readonly v1: Settings; readonly doc: SettingsDocV2 } | { readonly kind: 'unreadable'; readonly error: string } {
  let parsed: Partial<Settings>;
  try {
    parsed = JSON.parse(raw) as Partial<Settings>;
  } catch (e) {
    return { kind: 'unreadable', error: String(e) };
  }
  const v1 = sanitizeSettings(migrateLegacyPattern({ ...parsed }));
  const protection = { ...DEFAULT_DOC.protection, accounts: migrateAccountList(parsed.pruneWhitelist, now).accounts,
    words: migrateWordList(parsed.pruneBioFilterWords, now).words };
  const doc: SettingsDocV2 = { ...DEFAULT_DOC, seed: v1.seed, protection, protectionState: 'needs-review',
    prefs: { ...DEFAULT_DOC.prefs, practice: v1.dryRun, acceptRequests: v1.autoAcceptFollowRequests } };
  return { kind: 'v1', v1, doc };
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
  if (changed('activeHoursStart') || changed('activeHoursEnd')) {
    const quiet = quietHoursOfActive(partial.activeHoursStart ?? current.activeHoursStart, partial.activeHoursEnd ?? current.activeHoursEnd);
    ops.push({ op: 'intent', key: 'quietHours', value: quiet });
  }
  for (const k of DROPPED) if (changed(k)) dropped.push(k);
  return { ops, dropped, bookkeeping };
}
