/**
 * The pure v1 → v2 migration (spec §6.10): today's v1 pipeline resolves every quirk; an override is written
 * only where v1 differs from the FROZEN `V1_DERIVED` (a default install of any persona gets none); timing
 * rows only slow down; both lists come raw, every item counted; a broken post-condition refuses.
 */
import { createHash } from 'node:crypto';
import { SETTINGS_POLICY } from '@/kernel/settings-policy';
import type { AudienceSize, CleanupLevel, Intent, QuietHours } from '@/shared/settings-intent';
import type { ParamValue, RatioCurve } from '@/shared/settings-model';
import type { ParamKey } from '@/shared/settings-params';
import { DEFAULT_DOC, type MigrationNote, type OverrideEntry, type SettingsDocV2 } from './doc';
import { migrateAccountList, migrateWordList } from './migrate-v1-lists';
import type { ResolvedPattern } from './pattern-map';
import { v1Derived } from './v1/derive-v1';
import { DEFAULT_SETTINGS, migrateLegacyPattern, sanitizeSettings } from './v1/settings-v1';
import type { Settings } from './v1/settings-v1-types';

/** The v2 recommendations the slower-only and bucket rows compare against (the settings core supplies them). */
export interface MigrationBasis {
  /** The recommended effective typical gap at pace 1 (seconds). */
  gapTypicalSeconds(intent: Intent): number;
  /** The recommended effective gap floor at pace 1 (seconds). */
  gapMinimumSeconds(intent: Intent): number;
  /** The briskest check spacing an override may ask for (hours). */
  readonly checksEveryHoursMin: number;
  readonly audienceSize: Readonly<Record<AudienceSize, { readonly min: number; readonly max: number }>>;
  /** The 'likely' follow-back curve. */
  readonly likelyCurve: RatioCurve;
  /** The private-account edge `preferPrivate` adds. */
  readonly privateEdge: number;
  /** The highest refill threshold that still has an effect. */
  readonly refillMax: number;
  /** The interim recommendations while the plan port is not registered. */
  readonly interim: { readonly cleanupPerDay: number; readonly censusEveryDays: number; readonly checksEveryHours: number };
}

export interface MigrateOptions {
  readonly now: number;
  /** The account the v1 bookkeeping belongs to, when known. */
  readonly legacyAccountPk: string | null;
  /** The v1 file's modification time, recorded with its digest for the union-only re-import. */
  readonly mtimeMs: number | null;
  readonly basis: MigrationBasis;
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

const CURVE_KEYS = ['hardLow', 'bandLow', 'peakLow', 'peakHigh', 'bandHigh', 'hardHigh'] as const;

function quietHoursFrom(v1: Settings, notes: MigrationNote[]): QuietHours {
  const { activeHoursStart: start, activeHoursEnd: end } = v1;
  if (start === DEFAULT_SETTINGS.activeHoursStart && end === DEFAULT_SETTINGS.activeHoursEnd) {
    notes.push({ kind: 'quiet-hours-derived' });
    return { kind: 'derived' };
  }
  notes.push({ kind: 'quiet-hours-from-active-hours', start, end });
  // The active window [start, end) becomes the quiet window [end, start); an empty one has none.
  return start === end ? { kind: 'none' } : { kind: 'custom', startMinute: end * 60, endMinute: start * 60 };
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
    set('unfollow.censusEveryDays', clamped('unfollow.censusEveryDays', v1.pruneScheduleDays, 1, 30),
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

  return {
    kind: 'migrated',
    doc: {
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
      legacyCarry: {
        pacingModel: v1.pacingModel, minDelayMinutes: v1.minDelayMinutes, maxDelayMinutes: v1.maxDelayMinutes,
        jitterPercent: v1.jitterPercent, activeHoursStart: v1.activeHoursStart, activeHoursEnd: v1.activeHoursEnd,
      },
    },
  };
}
