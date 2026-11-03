/**
 * The pure v1 → v2 migration (spec §6.10): today's v1 pipeline resolves every quirk; an override is written
 * only where v1 differs from the FROZEN `V1_DERIVED` (a default install of any persona gets none); timing
 * rows only slow down; both lists come raw, every item counted; a broken post-condition refuses.
 */
import { createHash } from 'node:crypto';
import { SETTINGS_GUARDS, SETTINGS_POLICY } from '@/kernel/settings-policy';
import { MS_PER_HOUR, MS_PER_MINUTE } from '@/kernel/units';
import type { AudienceSize, CleanupLevel, Intent, QuietHours } from '@/shared/settings-intent';
import type { ParamValue, RatioCurve } from '@/shared/settings-model';
import type { ParamKey } from '@/shared/settings-params';
import type { MigrationBasis } from './basis';
import { DEFAULT_DOC, type MigrationNote, type OverrideEntry, type SettingsDocV2 } from './doc';
import { type EffectiveSettings, effectiveFrom } from './effective';
import { retireLegacyPacing } from './legacy-pacing-migration';
import { migrateAccountList, migrateWordList } from './migrate-v1-lists';
import { PARAM_SPECS } from './params';
import type { ResolvedPattern } from './pattern-map';
import type { ResolvedParams } from './resolve';
import { v1Derived } from './v1/derive-v1';
import { DEFAULT_SETTINGS, migrateLegacyPattern, sanitizeSettings } from './v1/settings-v1';
import type { Settings } from './v1/settings-v1-types';

export type { MigrationBasis } from './basis';

export interface MigrateOptions {
  readonly now: number;
  /** The account the v1 bookkeeping belongs to, when known. */
  readonly legacyAccountPk: string | null;
  /** The v1 file's modification time, recorded with its digest for the union-only re-import. */
  readonly mtimeMs: number | null;
  readonly basis: MigrationBasis;
  /** Resolves a document's parameters: given, the effective record must equal v1 on every retained knob. */
  readonly resolve?: (doc: SettingsDocV2) => ResolvedParams;
}

export type MigrationOutcome =
  | { readonly kind: 'migrated'; readonly doc: SettingsDocV2 }
  | { readonly kind: 'refused'; readonly reasons: readonly string[] };

/** v1 knob → v2 parameter for the fourteen pattern-derived numbers (gaps handled apart). */
const DERIVED_ROWS: ReadonlyArray<readonly [ParamKey, keyof ResolvedPattern]> = [
  ['pace.dailyVolume', 'dailyOperatingRate'], ['pace.dailyCeiling', 'dailyHardCeiling'],
  ['pace.candidateBuffer', 'dailyPlanSize'], ['pace.dayVariation', 'dailyVolumeVariancePct'],
  ['pace.restDayChance', 'restDayChancePct'], ['sessions.perDayMin', 'sessionsPerDayMin'],
  ['sessions.perDayMax', 'sessionsPerDayMax'], ['pace.hourlyCap', 'hourlyVelocityCap'],
  ['unfollow.cleanupShare', 'maxUnfollowFractionPerSession'], ['unfollow.waitDays', 'maxWaitForFollowbackDays'],
  ['unfollow.holdDays', 'holdAfterFollowbackDays'],
];

const MINUTES_PER_HOUR = MS_PER_HOUR / MS_PER_MINUTE;

const CURVE_KEYS = ['hardLow', 'bandLow', 'peakLow', 'peakHigh', 'bandHigh', 'hardHigh'] as const;

/** v1's active hours as quiet hours: the default window is derived; [start, end) active is [end, start) quiet. */
export function quietHoursOfActive(start: number, end: number): QuietHours {
  if (start === DEFAULT_SETTINGS.activeHoursStart && end === DEFAULT_SETTINGS.activeHoursEnd) return { kind: 'derived' };
  return start === end ? { kind: 'none' } : { kind: 'custom', startMinute: end * MINUTES_PER_HOUR, endMinute: start * MINUTES_PER_HOUR };
}

function quietHoursFrom(v1: Settings, notes: MigrationNote[]): QuietHours {
  const { activeHoursStart: start, activeHoursEnd: end } = v1;
  const quiet = quietHoursOfActive(start, end);
  notes.push(quiet.kind === 'derived' ? { kind: 'quiet-hours-derived' } : { kind: 'quiet-hours-from-active-hours', start, end });
  return quiet;
}

function cleanupFrom(v1: Settings, notes: MigrationNote[]): CleanupLevel {
  if (v1.pruneScheduleDays > 0) {
    notes.push({ kind: 'cleanup-scheduled-now-gradual' });
    if (v1.pattern.cleanup === 'off') notes.push({ kind: 'cleanup-trickle-from-schedule' });
    return v1.pattern.cleanup === 'steady' || v1.pattern.cleanup === 'deep' ? 'steady' : 'trickle';
  }
  if (v1.pattern.cleanup !== 'off') notes.push({ kind: 'cleanup-own-follows-off' });
  return 'off';
}

/** The mean of a band's ends. */
const meanOf = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

/** The seed as v2 stores it: trimmed, without a leading '@'. */
const normalizeSeed = (s: string): string => s.trim().replace(/^@/, '').trim();

function parseRaw(raw: string): Partial<Settings> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // a corrupt file is a refusal reason, reported by the caller
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Partial<Settings>) : null;
}

/** Migrate the raw v1 file text into a v2 document, or refuse with the broken post-conditions. */
export function migrateV1(raw: string, opts: MigrateOptions): MigrationOutcome {
  const parsed = parseRaw(raw);
  if (parsed === null) return { kind: 'refused', reasons: ['v1-unparseable'] };
  const rawLists = { whitelist: parsed.pruneWhitelist as unknown, words: parsed.pruneBioFilterWords as unknown };
  const v1 = sanitizeSettings(migrateLegacyPattern({ ...parsed }));
  const { now, basis } = opts;
  const notes: MigrationNote[] = [];
  const p = v1.pattern;
  const derived = v1Derived(p);
  const sizeEntry = (Object.entries(basis.audienceSize) as [AudienceSize, { min: number; max: number }][])
    .find(([, r]) => r.min === v1.minFollowers && r.max === v1.maxFollowers);
  const intent: Intent = {
    activity: p.activityLevel, caution: p.caution, rhythm: p.rhythm, consistency: p.consistency,
    dayShape: p.dayShape, weeklyShape: p.weeklyShape, quietHours: quietHoursFrom(v1, notes), daysOff: [],
    patience: p.patience, mutuals: 'rotate', cleanup: cleanupFrom(v1, notes), audienceFocus: 'likely',
    audienceSize: sizeEntry?.[0] ?? 'everyday', preferPrivate: v1.privateBoost > 0,
  };
  const overrides: Partial<Record<ParamKey, OverrideEntry>> = {};
  const set = (key: ParamKey, value: ParamValue, from: ParamValue): void => {
    overrides[key] = { value, setAt: now, basis: from };
  };
  const clamped = (key: ParamKey, value: number, lo: number, hi: number): number => {
    const to = Math.min(hi, Math.max(lo, value));
    if (to !== value) notes.push({ kind: 'value-clamped', key, from: value, to });
    return to;
  };
  for (const [key, knob] of DERIVED_ROWS) if (v1[knob] !== derived[knob]) set(key, v1[knob], derived[knob]);
  // Gaps act on the effective scale: a non-derived v1 value scales the v2 recommendation, slower only.
  const slower = (key: ParamKey, note: 'gapTypical' | 'gapMinimum', v1Value: number, ref: number, rec: number): void => {
    if (v1Value === ref) return;
    if (v1Value > ref) set(key, Math.round(rec * (v1Value / ref)), rec);
    else notes.push({ kind: 'faster-value-dropped', key: note, from: v1Value });
  };
  slower('sessions.gapTypical', 'gapTypical', v1.gapMedianSeconds, derived.gapMedianSeconds, basis.gapTypicalSeconds(intent));
  slower('sessions.gapMinimum', 'gapMinimum', v1.gapFloorSeconds, derived.gapFloorSeconds, basis.gapMinimumSeconds(intent));
  const curve = Object.fromEntries(CURVE_KEYS.map((k) => [k, v1[k]])) as unknown as RatioCurve;
  if (CURVE_KEYS.some((k) => curve[k] !== basis.likelyCurve[k])) set('audience.ratioCurve', curve, basis.likelyCurve);
  if (sizeEntry === undefined) {
    set('audience.followerRange', { min: v1.minFollowers, max: v1.maxFollowers }, basis.audienceSize.everyday);
  }
  if (v1.privateBoost !== 0 && v1.privateBoost !== basis.privateEdge) {
    set('audience.privateBoost', v1.privateBoost, intent.preferPrivate ? basis.privateEdge : 0);
  }
  if (v1.maxRetries !== DEFAULT_SETTINGS.maxRetries) set('unfollow.attempts', v1.maxRetries, DEFAULT_SETTINGS.maxRetries);
  if (v1.lowWaterCandidates !== DEFAULT_SETTINGS.lowWaterCandidates) {
    set('explore.refillBelow', clamped('explore.refillBelow', v1.lowWaterCandidates, 0, basis.refillMax),
      DEFAULT_SETTINGS.lowWaterCandidates);
  }
  if (v1.minFollowBackRate !== DEFAULT_SETTINGS.minFollowBackRate) {
    set('explore.moveOnRate', v1.minFollowBackRate, DEFAULT_SETTINGS.minFollowBackRate);
  }
  if (v1.minPoolSize !== DEFAULT_SETTINGS.minPoolSize) set('explore.moveOnPool', v1.minPoolSize, DEFAULT_SETTINGS.minPoolSize);
  if (v1.followbackSweepHours !== basis.interim.checksEveryHours) {
    if (v1.followbackSweepHours >= basis.checksEveryHoursMin) {
      set('checks.everyHours', v1.followbackSweepHours, basis.interim.checksEveryHours);
    } else notes.push({ kind: 'faster-value-dropped', key: 'checksEveryHours', from: v1.followbackSweepHours });
  }
  if (v1.pruneDailyLimit !== basis.interim.cleanupPerDay) {
    set('unfollow.cleanupPerDay', clamped('unfollow.cleanupPerDay', v1.pruneDailyLimit, 0, v1.dailyHardCeiling),
      basis.interim.cleanupPerDay);
  }
  if (v1.pruneScheduleDays > 0 && v1.pruneScheduleDays !== basis.interim.censusEveryDays) {
    const { min, max } = SETTINGS_GUARDS.censusEveryDays;
    set('unfollow.censusEveryDays', clamped('unfollow.censusEveryDays', v1.pruneScheduleDays, min, max),
      basis.interim.censusEveryDays);
  }
  // The scan band becomes a walk.page factor over the v1 default band (the walk.page reference), slower
  // only: a faster band would speed up every list walk, so it is dropped with a notice.
  const scanMean = meanOf([v1.pruneScanMinSeconds, v1.pruneScanMaxSeconds]);
  const scanFactor = scanMean / meanOf([DEFAULT_SETTINGS.pruneScanMinSeconds, DEFAULT_SETTINGS.pruneScanMaxSeconds]);
  if (scanFactor > 1) {
    set('tempo.walk.page', clamped('tempo.walk.page', scanFactor, 1, SETTINGS_POLICY.TEMPO_OVERRIDE_MAX_FACTOR), 1);
  } else if (scanFactor < 1) notes.push({ kind: 'faster-value-dropped', key: 'pruneScan', from: scanMean });

  const accounts = migrateAccountList(rawLists.whitelist, now);
  const words = migrateWordList(rawLists.words, now);
  notes.push({ kind: 'verified-kept' });
  if (words.words.length > 0) notes.push({ kind: 'bio-words-widened', words: words.words.length });
  if (accounts.nonString > 0) notes.push({ kind: 'list-items-dropped', list: 'accounts', count: accounts.nonString });
  if (words.nonString > 0) notes.push({ kind: 'list-items-dropped', list: 'words', count: words.nonString });
  const seed = normalizeSeed(v1.seed);

  const reasons: string[] = [];
  if (accounts.accounts.length !== accounts.uniqueHandles) reasons.push('account-count');
  if (words.words.length !== words.uniqueFolded) reasons.push('word-count');
  if (seed !== normalizeSeed(typeof parsed.seed === 'string' ? parsed.seed : '')) reasons.push('seed');
  if (reasons.length > 0) return { kind: 'refused', reasons };

  const doc: SettingsDocV2 = {
      ...DEFAULT_DOC,
      intent,
      seed,
      overrides,
      protection: { accounts: accounts.accounts, words: words.words, wordMatch: 'anywhere', keepVerified: true },
      protectionState: accounts.nonString + words.nonString > 0 ? 'needs-review' : 'ready',
      prefs: { ...DEFAULT_DOC.prefs, practice: v1.dryRun, acceptRequests: v1.autoAcceptFollowRequests },
      app: { ...DEFAULT_DOC.app, tourCompletedAt: v1.tourCompletedAt },
      migration: {
        at: now,
        fromV1: opts.mtimeMs === null ? null : { mtimeMs: opts.mtimeMs, sha256: createHash('sha256').update(raw).digest('hex') },
        notes,
        bookkeeping: {
          forPk: opts.legacyAccountPk, sweepLastRunAt: v1.sweepLastRunAt,
          sweepIntervalFactor: v1.sweepIntervalFactor, pruneLastRunAt: v1.pruneLastRunAt,
        },
      },
  };
  // The kept numbers are checked against v1 first; the retired pacer then maps once, as for a carried document.
  if (opts.resolve === undefined) return { kind: 'migrated', doc: retireLegacyPacing(doc, v1.pacingModel, now) };
  const pinned = pinChained(v1, doc, opts.resolve, now);
  const broken = effectiveMismatches(v1, pinned, opts.resolve(pinned), notes);
  return broken.length > 0 ? { kind: 'refused', reasons: broken } : { kind: 'migrated', doc: retireLegacyPacing(pinned, v1.pacingModel, now) };
}

/**
 * v2 derives some numbers from the EFFECTIVE upstreams (a hand-set daily volume moves the recommended
 * ceiling); a v1 value that matched its old derivation keeps itself as an override, so behaviour is kept.
 */
function pinChained(v1: Settings, doc: SettingsDocV2, resolve: (d: SettingsDocV2) => ResolvedParams, now: number): SettingsDocV2 {
  let d = doc;
  for (let pass = 0; pass < RETAINED.length; pass += 1) {
    const r = resolve(d);
    const e = effectiveFrom(d, r);
    const drift = RETAINED.find(([knob, key]) => typeof v1[knob] === 'number' && e[knob] !== v1[knob]
      && d.overrides[key] === undefined && PARAM_SPECS[key].kind === 'int' && within(v1[knob] as number, r[key].bounds));
    if (drift === undefined) return d;
    const [knob, key] = drift;
    d = { ...d, overrides: { ...d.overrides, [key]: { value: v1[knob] as number, setAt: now, basis: r[key].recommended } } };
  }
  return d;
}

const within = (v: number, b: { readonly min: number; readonly max: number }): boolean => v >= b.min && v <= b.max;

/** v1 knobs whose meaning v2 keeps, and the parameter that now holds each. */
const RETAINED: ReadonlyArray<readonly [keyof Settings & keyof EffectiveSettings, ParamKey]> = [
  ['dailyOperatingRate', 'pace.dailyVolume'], ['dailyHardCeiling', 'pace.dailyCeiling'], ['dailyPlanSize', 'pace.candidateBuffer'],
  ['dailyVolumeVariancePct', 'pace.dayVariation'], ['restDayChancePct', 'pace.restDayChance'],
  ['sessionsPerDayMin', 'sessions.perDayMin'], ['sessionsPerDayMax', 'sessions.perDayMax'], ['hourlyVelocityCap', 'pace.hourlyCap'],
  ['maxWaitForFollowbackDays', 'unfollow.waitDays'], ['holdAfterFollowbackDays', 'unfollow.holdDays'], ['maxRetries', 'unfollow.attempts'],
  ['lowWaterCandidates', 'explore.refillBelow'], ['minFollowBackRate', 'explore.moveOnRate'], ['minPoolSize', 'explore.moveOnPool'],
  ['privateBoost', 'audience.privateBoost'], ['minFollowers', 'audience.followerRange'], ['maxFollowers', 'audience.followerRange'],
  ...CURVE_KEYS.map((k) => [k, 'audience.ratioCurve'] as const), ['followbackSweepHours', 'checks.everyHours'],
  ['pruneDailyLimit', 'unfollow.cleanupPerDay'],
];

/**
 * The effective-equality post-condition (spec §6.10): the migrated document's effective record equals the
 * v1-sanitized object on every retained knob, except the documented exceptions — a value the new bounds
 * clamp (a `value-clamped` note is added) and a faster value that was dropped with its notice.
 */
function effectiveMismatches(v1: Settings, doc: SettingsDocV2, r: ResolvedParams, notes: MigrationNote[]): string[] {
  const e = effectiveFrom(doc, r);
  const noted = (key: ParamKey): boolean => notes.some((n) => 'key' in n && n.key === key);
  const out: string[] = [];
  for (const [knob, key] of RETAINED) {
    if (e[knob] === v1[knob] || (knob === 'followbackSweepHours' && notes.some((n) => n.kind === 'faster-value-dropped' && n.key === 'checksEveryHours'))) continue;
    const outside = typeof v1[knob] === 'number' && !within(v1[knob] as number, r[key].bounds);
    if ((outside || r[key].override?.clamped === true) && typeof v1[knob] === 'number' && typeof e[knob] === 'number') {
      if (!noted(key)) notes.push({ kind: 'value-clamped', key, from: v1[knob] as number, to: e[knob] as number });
      continue;
    }
    if (!noted(key)) out.push(`effective:${knob}`);
  }
  return out;
}
