import * as fs from 'node:fs';
import type { ChainConfig } from '../engine/chain-controller';
import type { ChurnConfig } from '../engine/churn-scheduler';
import type { FollowbackConfig } from '../engine/followback-watcher';
import type { PruneConfig } from '../engine/prune-engine';
import type { ScannerConfig } from '../engine/scanner';
import { SCORER_DEFAULTS, type ScorerConfig } from '../engine/scorer';
import type { RateGovernorConfig } from '../governors/rate-governor';
import { NOISE, PATTERN, SESSION } from '../timing/config';
import type { SessionPlannerConfig } from '../timing/session-planner';
import { MS_PER_DAY, MS_PER_MINUTE } from '../timing/units';
import { warn } from '../utils/logger';
import {
  type PatternSettings,
  PERSONAS,
  type PersonaId,
  type ResolvedPattern,
  resolvePattern,
} from './pattern-map';

/**
 * The single user-facing knob set (v3 §4). Every component's config is a pure
 * projection of this object (see the `toXConfig` mappers), so there is exactly ONE
 * place a user tunes behavior and the component defaults can never silently drift.
 *
 * Persisted as JSON in `userData`, separate from the DB (§6). User-facing units are
 * used here (days, minutes, hours); the mappers convert to the millisecond units the
 * components expect.
 */
export interface Settings {
  /** Seed target username the chain starts from. */
  seed: string;

  // --- Scorer: ratio sweet-spot band + peak plateau + hard exclusion bounds. ---
  bandLow: number;
  bandHigh: number;
  peakLow: number;
  peakHigh: number;
  hardLow: number;
  hardHigh: number;

  // --- Scorer: follower-count band + private-account preference. ---
  minFollowers: number;
  maxFollowers: number;
  privateBoost: number;

  // --- Churn lifecycle timers (display units) + retry cap. ---
  maxWaitForFollowbackDays: number;
  holdAfterFollowbackDays: number;
  maxRetries: number;

  // --- Rate governor: daily caps, inter-action delay, active hours. ---
  dailyHardCeiling: number;
  dailyOperatingRate: number;
  minDelayMinutes: number;
  maxDelayMinutes: number;
  jitterPercent: number;
  activeHoursStart: number;
  activeHoursEnd: number;

  // --- Follow-back sweep cadence. ---
  followbackSweepHours: number;
  /** Epoch ms of the last completed follow-back sweep; null when never run. */
  sweepLastRunAt: number | null;
  /**
   * Timing-noise factor stretching the CURRENT sweep interval (isDue compares
   * against `everyMs × factor`); redrawn and persisted at each completed sweep
   * so consecutive intervals differ while a restart mid-interval keeps the one
   * already drawn. 1 = the exact configured cadence.
   */
  sweepIntervalFactor: number;
  /**
   * Auto-accept incoming follow requests during each follow-back check. On a
   * PRIVATE account, follow-backs arrive as requests — without accepting them
   * they never count as reciprocation. Free for public accounts (no requests
   * entry → soft skip).
   */
  autoAcceptFollowRequests: boolean;

  // --- Scanner / chain / pool health. ---
  dailyPlanSize: number;
  lowWaterCandidates: number;
  minFollowBackRate: number;
  minPoolSize: number;

  /** When true, actions are logged-and-noop'd (intent still recorded) — never touches the account. */
  dryRun: boolean;

  // --- Auto-prune: unfollow non-reciprocating accounts (separate from growth). ---
  /** Usernames never auto-pruned (case-insensitive; pk entries also match). */
  pruneWhitelist: string[];
  /** The bio keep-list: words/phrases (case-insensitive substring match on
   *  the profile bio) that keep an account followed — ONLY when it follows
   *  back. A protected mutual is never rotated out by the churn cycle; a
   *  non-follower is pruned regardless of bio. */
  pruneBioFilterWords: string[];
  /** Max prune unfollows per local day (its OWN ledger, independent of growth). */
  pruneDailyLimit: number;
  /** Re-run the prune every N days; 0 = scheduling off (one-shot only). */
  pruneScheduleDays: number;
  /** Epoch ms of the last completed prune run; null when never run. */
  pruneLastRunAt: number | null;
  /** Min seconds between scan list-pages / scroll rounds (jittered up to max). */
  pruneScanMinSeconds: number;
  /** Max seconds between scan list-pages / scroll rounds (rate-limit safety). */
  pruneScanMaxSeconds: number;

  // --- Organic macro-timing model (docs/superpowers/plans/2026-08-15-*). ---
  /**
   * Which pacing model drives the growth loop. `'organic'` (the default)
   * activates the SessionPlanner (circadian sessions, log-normal gaps,
   * daily-volume distribution); `'legacy'` keeps the flat active-hours +
   * operating-rate metronome. Both values persist as-is: an install whose
   * settings file explicitly says `'legacy'` stays legacy; a file with no
   * stored value gets the organic default. A model switch takes effect at the
   * next graph build (the planner is a construction-time engine dep).
   */
  pacingModel: 'legacy' | 'organic';
  /** Day-to-day volume spread (log-normal σ, as a percent). */
  dailyVolumeVariancePct: number;
  /** Chance a given day is a near-zero "rest day" (percent). */
  restDayChancePct: number;
  /** The day's target volume is distributed across this many sessions. */
  sessionsPerDayMin: number;
  sessionsPerDayMax: number;
  /** Within-session inter-action gap: median / hard floor (seconds). */
  gapMedianSeconds: number;
  gapFloorSeconds: number;
  /** Hard rolling-hour action cap (established-account velocity backstop). */
  hourlyVelocityCap: number;
  /** Weave prune unfollows into the growth action stream (vs. a separate bulk run). */
  weaveEnabled: boolean;
  /** Cap the unfollow share of any single session (mix guard, not an aggregate ratio). */
  maxUnfollowFractionPerSession: number;

  // --- Qualitative pattern model (§5.6): the PRIMARY user surface. The numeric knobs
  //     above are DERIVED from `pattern` (via resolvePattern) — users tune behavior,
  //     not distributions. `persona` is a named bundle; 'custom' means hand-tuned knobs. ---
  persona: PersonaId;
  pattern: PatternSettings;

  // --- Shell / onboarding. ---
  /** Epoch ms when the intro tour was finished or dismissed; null = offer it on launch. */
  tourCompletedAt: number | null;
}

// --- The one knob table -------------------------------------------------------
//
// Every knob is declared ONCE here, with its default and its safe range in the
// same line. `DEFAULT_SETTINGS` is projected out of it and `sanitizeSettings`
// applies it, so a new knob cannot ship with a default but no clamp (or the
// reverse) — and `satisfies` below makes a knob missing from either the
// `Settings` interface or this table a compile error.

/** How one knob's stored value is repaired: never a throw, always the nearest safe value. */
interface Rule<T> {
  fallback: T;
  coerce(raw: unknown): T;
}

const clamp = (v: unknown, fallback: number, min: number, max: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return Math.min(max, Math.max(min, n));
};

/** A real-valued knob, clamped into `[min, max]`. */
const num = (fallback: number, min: number, max: number): Rule<number> => ({
  fallback,
  coerce: (v) => clamp(v, fallback, min, max),
});

/** An integer knob: clamped, then rounded. */
const int = (fallback: number, min: number, max: number): Rule<number> => ({
  fallback,
  coerce: (v) => Math.round(clamp(v, fallback, min, max)),
});

const bool = (fallback: boolean): Rule<boolean> => ({
  fallback,
  coerce: (v) => (typeof v === 'boolean' ? v : fallback),
});

const str = (fallback: string): Rule<string> => ({
  fallback,
  coerce: (v) => (typeof v === 'string' ? v : fallback).trim(),
});

/** A list of strings; anything else (a hand-edited object, null) reads as empty. */
const strList = (): Rule<string[]> => ({
  fallback: [],
  coerce: (v) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []),
});

/** An epoch-ms timestamp, or null when absent/garbage. */
const epoch = (): Rule<number | null> => ({
  fallback: null,
  coerce: (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null),
});

/** A closed set of stored values; anything else degrades to `fallback`. */
const oneOf = <T extends string>(allowed: readonly T[], fallback: T): Rule<T> => ({
  fallback,
  coerce: (v) => (typeof v === 'string' && allowed.includes(v as T) ? (v as T) : fallback),
});

/** Allowed values for each qualitative knob (for sanitizing a hand-edited file). */
const PATTERN_ALLOWED = {
  activityLevel: ['minimal', 'light', 'moderate', 'active', 'aggressive'],
  consistency: ['clockwork', 'natural', 'erratic'],
  rhythm: ['trickle', 'sessions', 'bursts'],
  dayShape: ['morning', 'balanced', 'evening', 'nightowl', 'business'],
  weeklyShape: ['uniform', 'weekdays', 'weekends', 'realistic'],
  caution: ['cautious', 'standard', 'bold'],
  cleanup: ['off', 'trickle', 'steady', 'deep'],
  patience: ['quick', 'normal', 'patient'],
} as const;

const PERSONA_IDS: readonly PersonaId[] = [
  'casual',
  'balanced',
  'grower',
  'nineToFive',
  'nightOwl',
  'custom',
];

/** Coerce a possibly hand-edited pattern object into a valid PatternSettings. */
function sanitizePattern(raw: unknown): PatternSettings {
  const base = PERSONAS.balanced;
  const r = (raw ?? {}) as Record<string, unknown>;
  const pick = <K extends keyof PatternSettings>(k: K): PatternSettings[K] => {
    const allowed = PATTERN_ALLOWED[k] as readonly string[];
    const v = r[k];
    return (typeof v === 'string' && allowed.includes(v) ? v : base[k]) as PatternSettings[K];
  };
  return {
    activityLevel: pick('activityLevel'),
    consistency: pick('consistency'),
    rhythm: pick('rhythm'),
    dayShape: pick('dayShape'),
    weeklyShape: pick('weeklyShape'),
    caution: pick('caution'),
    cleanup: pick('cleanup'),
    patience: pick('patience'),
  };
}

/** The `balanced` persona IS the historical numeric default set — one home for both. */
const BALANCED = resolvePattern(PERSONAS.balanced);

const RULES = {
  seed: str(''),

  // Ratio bands. The piecewise ordering is enforced by ORDERINGS below.
  bandLow: num(0.9, 0, 100),
  bandHigh: num(1.5, 0, 100),
  peakLow: num(1.0, 0, 100),
  peakHigh: num(1.2, 0, 100),
  hardLow: num(0.5, 0, 100),
  hardHigh: num(3.0, 0, 100),

  minFollowers: int(50, 0, 10_000_000),
  maxFollowers: int(20_000, 1, 100_000_000),
  privateBoost: num(0.15, 0, 1),

  maxWaitForFollowbackDays: num(BALANCED.maxWaitForFollowbackDays, 0.25, 60),
  holdAfterFollowbackDays: num(BALANCED.holdAfterFollowbackDays, 0, 60),
  maxRetries: int(3, 0, 10),

  dailyHardCeiling: int(BALANCED.dailyHardCeiling, 1, 1000),
  dailyOperatingRate: int(BALANCED.dailyOperatingRate, 1, 500),
  // Legacy pacing knobs — the prune-scan / manual paths and the legacy model
  // only. The growth pace comes from the qualitative pattern.
  minDelayMinutes: num(3, 0.5, 240),
  maxDelayMinutes: num(7, 0.5, 480),
  jitterPercent: num(30, 0, 90),
  activeHoursStart: int(8, 0, 23),
  activeHoursEnd: int(22, 0, 23),

  // The notifications-based check is one click + one request, cheap enough to
  // run hourly (the old whole-list paged sweep budgeted for multi-hour gaps).
  followbackSweepHours: num(1, 0.5, 168),
  sweepLastRunAt: epoch(),
  sweepIntervalFactor: num(1, NOISE.CADENCE_MIN_FACTOR, NOISE.CADENCE_MAX_FACTOR),
  autoAcceptFollowRequests: bool(true),

  dailyPlanSize: int(BALANCED.dailyPlanSize, 1, 200),
  lowWaterCandidates: int(5, 0, 100),
  minFollowBackRate: num(0.15, 0, 1),
  minPoolSize: int(300, 0, 1_000_000),

  dryRun: bool(false),

  pruneWhitelist: strList(),
  pruneBioFilterWords: strList(),
  pruneDailyLimit: int(50, 1, 1000),
  pruneScheduleDays: num(0, 0, 365),
  pruneLastRunAt: epoch(),
  // Matched to the widely-used console tool's scan cadence (~1.5–3.3 s per
  // 50-user API page): with the direct list walk this completes ~3200
  // followers in a few minutes while staying inside its proven rate band.
  pruneScanMinSeconds: num(1, 0.5, 300),
  pruneScanMaxSeconds: num(3, 0.5, 600),

  // Both models are valid stored values (an explicit 'legacy' from an existing
  // install is respected); anything else degrades to the default.
  pacingModel: oneOf(['legacy', 'organic'] as const, 'organic'),
  dailyVolumeVariancePct: num(BALANCED.dailyVolumeVariancePct, 0, 60),
  restDayChancePct: num(BALANCED.restDayChancePct, 0, 30),
  sessionsPerDayMin: int(BALANCED.sessionsPerDayMin, 1, 12),
  sessionsPerDayMax: int(BALANCED.sessionsPerDayMax, 1, 12),
  gapMedianSeconds: num(BALANCED.gapMedianSeconds, 30, 600),
  gapFloorSeconds: num(BALANCED.gapFloorSeconds, 15, 300),
  hourlyVelocityCap: int(BALANCED.hourlyVelocityCap, 3, 40),
  weaveEnabled: bool(BALANCED.weaveEnabled),
  maxUnfollowFractionPerSession: num(BALANCED.maxUnfollowFractionPerSession, 0, 1),

  // The qualitative pair is re-decided wholesale after the per-knob pass (see
  // the persona block in `sanitizeSettings`); these rules only supply defaults.
  persona: oneOf(PERSONA_IDS, 'balanced'),
  pattern: { fallback: { ...PERSONAS.balanced }, coerce: sanitizePattern } as Rule<PatternSettings>,

  tourCompletedAt: epoch(),
} satisfies { [K in keyof Settings]: Rule<Settings[K]> };

/**
 * Pairs that must stay ordered after the per-knob clamps: `[a, b]` lifts `a` to
 * at least `b`. Applied in sequence, so the ratio band's five links compose
 * into hardLow ≤ bandLow ≤ peakLow ≤ peakHigh ≤ bandHigh ≤ hardHigh.
 */
const AT_LEAST: ReadonlyArray<readonly [NumericKnob, NumericKnob]> = [
  ['bandLow', 'hardLow'],
  ['peakLow', 'bandLow'],
  ['peakHigh', 'peakLow'],
  ['bandHigh', 'peakHigh'],
  ['hardHigh', 'bandHigh'],
  ['maxFollowers', 'minFollowers'],
  ['dailyHardCeiling', 'dailyOperatingRate'],
  ['maxDelayMinutes', 'minDelayMinutes'],
  ['pruneScanMaxSeconds', 'pruneScanMinSeconds'],
  ['sessionsPerDayMax', 'sessionsPerDayMin'],
];

/** Pairs where `a` must not exceed `b` (the gap floor never passes the median). */
const AT_MOST: ReadonlyArray<readonly [NumericKnob, NumericKnob]> = [
  ['gapFloorSeconds', 'gapMedianSeconds'],
];

/** Knob names whose value is a plain number (the only ones the orderings touch). */
type NumericKnob = {
  [K in keyof Settings]: Settings[K] extends number ? K : never;
}[keyof Settings];

/**
 * Every knob name, projected from {@link RULES} — the ONE list of what a
 * settings object may contain. The IPC boundary guard (`src/ipc/guards.ts`)
 * builds its `updateSettings` shape check from this, so a new knob is admitted
 * over IPC by the same edit that declares it (ADR 1009). Values stay
 * unvalidated there on purpose: clamping is {@link sanitizeSettings}'s job,
 * and coercion is not validation (ADR 0103).
 */
export const SETTINGS_KEYS: readonly (keyof Settings)[] = Object.keys(RULES) as (keyof Settings)[];

/**
 * Fallback values for every knob, projected from {@link RULES} so the default
 * and the clamp can never describe different values. Time knobs are in display
 * units; the 14 pacing knobs come from the `balanced` persona's bundle.
 */
export const DEFAULT_SETTINGS: Settings = Object.fromEntries(
  Object.entries(RULES).map(([key, rule]) => [key, (rule as Rule<unknown>).fallback]),
) as unknown as Settings;

/**
 * Clamp every knob into its sane range. The UI keeps its own input guards, but
 * settings also arrive from disk and over IPC unvalidated — a hand-edited file
 * (or a bad renderer payload) must never produce a negative delay, a 100%
 * jitter that fires actions back-to-back, an inverted band, or a whitelist that
 * isn't an array (which used to crash the prune scan). Every out-of-range value
 * degrades to the nearest safe one, never to a throw.
 */
export function sanitizeSettings(s: Settings): Settings {
  const raw = s as unknown as Record<string, unknown>;
  const out = Object.fromEntries(
    Object.entries(RULES).map(([key, rule]) => [key, (rule as Rule<unknown>).coerce(raw[key])]),
  ) as unknown as Settings;

  const nums = out as unknown as Record<NumericKnob, number>;
  for (const [a, b] of AT_LEAST) nums[a] = Math.max(nums[a], nums[b]);
  for (const [a, b] of AT_MOST) nums[a] = Math.min(nums[a], nums[b]);

  // Qualitative pattern: a NAMED persona is authoritative — the numeric pacing
  // knobs are DERIVED from its bundle (users tune behavior, not distributions).
  // In 'custom' mode the numeric knobs are kept as clamped UNLESS a `pattern`
  // object exists, in which case the UI tuned it and its numbers derive too. A
  // legacy numbers-only file has no `pattern`, so its hand-set knobs survive
  // migration. The default persona 'balanced' derives exactly the historical
  // numeric defaults, so a fresh install is unchanged.
  const named =
    typeof s.persona === 'string' &&
    PERSONA_IDS.includes(s.persona) &&
    s.persona !== 'custom'
      ? (s.persona as Exclude<PersonaId, 'custom'>)
      : null;
  if (named !== null) {
    out.persona = named;
    out.pattern = { ...PERSONAS[named] };
    applyResolvedPattern(out, resolvePattern(out.pattern));
  } else {
    out.persona = 'custom';
    out.pattern = sanitizePattern(s.pattern);
    if (s.pattern !== undefined && s.pattern !== null) {
      applyResolvedPattern(out, resolvePattern(out.pattern));
    }
  }

  return out;
}

/**
 * Write the 14 persona-derived knobs into `out`. `ResolvedPattern`'s keys ARE
 * those knobs, so adding one to the bundle lands here with no edit.
 */
function applyResolvedPattern(out: Settings, rp: ResolvedPattern): void {
  Object.assign(out, rp);
}

/**
 * Load settings from `filePath`, merged over {@link DEFAULT_SETTINGS} so a partial or
 * older file still yields a complete object. A missing file or a parse error is NOT an
 * error condition: it returns the defaults and logs a warning (never throws).
 */
export function loadSettings(filePath: string): Settings {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    warn('settings: no settings file, using defaults', { filePath, error: String(err) });
    return { ...DEFAULT_SETTINGS };
  }

  try {
    return sanitizeSettings(migrateLegacyPattern(JSON.parse(raw) as Partial<Settings>));
  } catch (err) {
    warn('settings: failed to parse settings file, using defaults', {
      filePath,
      error: String(err),
    });
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * A file predating the qualitative pattern model has no `persona`/`pattern`.
 * Treat it as 'custom' AND drop the default-merged pattern, so its hand-set
 * numeric knobs survive instead of being re-derived from a nominal pattern.
 * Runs BEFORE the sanitizer, which is where the derivation happens.
 */
function migrateLegacyPattern(parsed: Partial<Settings>): Settings {
  const legacyNoPattern = !('pattern' in parsed);
  if (!('persona' in parsed)) parsed.persona = 'custom';
  const merged = { ...DEFAULT_SETTINGS, ...parsed };
  if (legacyNoPattern && merged.persona === 'custom') {
    (merged as { pattern?: PatternSettings }).pattern = undefined;
  }
  return merged;
}

/**
 * Persist settings to `filePath` atomically: write a temp sibling then rename over the
 * target, so a crash mid-write can never leave a truncated/corrupt settings file.
 */
export function saveSettings(filePath: string, s: Settings): void {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

/**
 * Project the Scorer's config out of Settings (`bandEdgeScore` and the mutual
 * knobs are not user-tunable — they carry the component defaults).
 */
export function toScorerConfig(s: Settings): ScorerConfig {
  return {
    bandLow: s.bandLow,
    bandHigh: s.bandHigh,
    peakLow: s.peakLow,
    peakHigh: s.peakHigh,
    hardLow: s.hardLow,
    hardHigh: s.hardHigh,
    minFollowers: s.minFollowers,
    maxFollowers: s.maxFollowers,
    privateBoost: s.privateBoost,
    bandEdgeScore: SCORER_DEFAULTS.bandEdgeScore,
    mutualCap: SCORER_DEFAULTS.mutualCap,
    mutualWeight: SCORER_DEFAULTS.mutualWeight,
  };
}

/** Project the Churn Scheduler's config out of Settings (days → ms). The post-
 *  follow-back hold is deliberately absent: it belongs to the FollowbackWatcher
 *  (see `toFollowbackConfig`), which stamps `holdUntil` on each record. */
export function toChurnConfig(s: Settings): ChurnConfig {
  return {
    maxWaitForFollowbackMs: s.maxWaitForFollowbackDays * MS_PER_DAY,
    maxRetries: s.maxRetries,
    // The bio keep-list lives with churn (not prune): it protects mutuals
    // from the hold-elapsed rotation, while prune ignores bios entirely.
    bioKeepWords: s.pruneBioFilterWords,
  };
}

/** Project the Rate Governor's config out of Settings (minutes → ms). */
export function toRateGovernorConfig(s: Settings): RateGovernorConfig {
  return {
    dailyHardCeiling: s.dailyHardCeiling,
    dailyOperatingRate: s.dailyOperatingRate,
    minDelayMs: s.minDelayMinutes * MS_PER_MINUTE,
    maxDelayMs: s.maxDelayMinutes * MS_PER_MINUTE,
    jitterPercent: s.jitterPercent,
    activeHoursStart: s.activeHoursStart,
    activeHoursEnd: s.activeHoursEnd,
  };
}

/** Project the Follow-back Watcher's config out of Settings (days → ms). */
export function toFollowbackConfig(s: Settings): FollowbackConfig {
  return {
    holdAfterFollowbackMs: s.holdAfterFollowbackDays * MS_PER_DAY,
    autoAcceptRequests: s.autoAcceptFollowRequests,
  };
}

/** Project the Scanner's config out of Settings. */
export function toScannerConfig(s: Settings): ScannerConfig {
  return {
    dailyPlanSize: s.dailyPlanSize,
  };
}

/** Project the Chain Controller's config out of Settings. */
export function toChainConfig(s: Settings): ChainConfig {
  return {
    minFollowBackRate: s.minFollowBackRate,
    minPoolSize: s.minPoolSize,
  };
}

/**
 * Project the SessionPlanner's config out of Settings (organic pacing model). The
 * user-facing knobs (mean volume, variance, sessions/day, gap median/floor, velocity
 * cap) come from Settings; the anti-fingerprint internals (gap σ, tail cap, Hawkes
 * kernel) are registry constants — one home per kind of value.
 */
export function toPacingConfig(s: Settings): SessionPlannerConfig {
  return {
    dailyMeanActions: s.dailyOperatingRate,
    dailyHardCeiling: s.dailyHardCeiling,
    dayVolumeSigma: s.dailyVolumeVariancePct / 100,
    restDayProbability: s.restDayChancePct / 100,
    restDayMaxFraction: PATTERN.REST_DAY_MAX_FRACTION,
    sessionsPerDayMin: s.sessionsPerDayMin,
    sessionsPerDayMax: s.sessionsPerDayMax,
    gapMedianMs: s.gapMedianSeconds * 1000,
    gapSigma: SESSION.GAP_SIGMA,
    gapFloorMs: s.gapFloorSeconds * 1000,
    gapCapMs: SESSION.GAP_CAP_MS,
    hawkesAlpha: SESSION.HAWKES_ALPHA,
    hawkesTauMs: SESSION.HAWKES_TAU_MS,
    maxActionsPerRollingHour: s.hourlyVelocityCap,
  };
}

/**
 * Project the Prune Engine's config out of Settings (minutes → ms). The
 * inter-action delay knobs are shared with the growth engine, but prune scales
 * the resulting paced delay to a third (see `PRUNE_DELAY_FACTOR`) so it runs
 * ~3× faster than growth's follow cadence. The SCAN pacing knobs (seconds → ms)
 * are prune's own, clamped so `0 ≤ scanMinMs ≤ scanMaxMs` even when the
 * settings file carries a negative or inverted pair.
 */
export function toPruneConfig(s: Settings): PruneConfig {
  const scanMinMs = Math.max(0, s.pruneScanMinSeconds * 1000);
  const scanMaxMs = Math.max(scanMinMs, s.pruneScanMaxSeconds * 1000);
  return {
    dailyLimit: s.pruneDailyLimit,
    whitelist: s.pruneWhitelist,
    minDelayMs: s.minDelayMinutes * MS_PER_MINUTE,
    maxDelayMs: s.maxDelayMinutes * MS_PER_MINUTE,
    jitterPercent: s.jitterPercent,
    scanMinMs,
    scanMaxMs,
  };
}
