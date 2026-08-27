import * as fs from 'node:fs';
import type { ChainConfig } from '../engine/chain-controller';
import type { ChurnConfig } from '../engine/churn-scheduler';
import type { FollowbackConfig } from '../engine/followback-watcher';
import type { PruneConfig } from '../engine/prune-engine';
import type { ScannerConfig } from '../engine/scanner';
import { SCORER_DEFAULTS, type ScorerConfig } from '../engine/scorer';
import type { RateGovernorConfig } from '../governors/rate-governor';
import { PATTERN, SESSION } from '../timing/config';
import type { SessionPlannerConfig } from '../timing/session-planner';
import { MS_PER_DAY, MS_PER_MINUTE } from '../timing/units';
import { warn } from '../utils/logger';
import {
  type PatternSettings,
  PERSONAS,
  type PersonaId,
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
  /** Bio words/phrases that protect an account from prune unfollows
   *  (case-insensitive substring match on the profile bio). */
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
   * Which pacing model drives the growth loop. `'legacy'` keeps the flat
   * active-hours + operating-rate metronome; `'organic'` activates the
   * SessionPlanner (circadian sessions, log-normal gaps, daily-volume
   * distribution). Rolled out behind this flag; flips live via applySettings.
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

/**
 * Fallback values for every knob, consistent with each component's own `*_DEFAULTS`
 * (v3 §4: the component defaults live here). Time knobs are in display units.
 */
export const DEFAULT_SETTINGS: Settings = {
  seed: '',

  bandLow: 0.9,
  bandHigh: 1.5,
  peakLow: 1.0,
  peakHigh: 1.2,
  hardLow: 0.5,
  hardHigh: 3.0,

  minFollowers: 50,
  maxFollowers: 20000,
  privateBoost: 0.15,

  maxRetries: 3,

  // Legacy pacing knobs — retained for the prune-scan / manual paths and the legacy
  // (non-organic) model only. The growth pace comes from the qualitative pattern.
  minDelayMinutes: 3,
  maxDelayMinutes: 7,
  jitterPercent: 30,
  activeHoursStart: 8,
  activeHoursEnd: 22,

  // The notifications-based check is one click + one request, cheap enough to
  // run hourly (the old whole-list paged sweep budgeted for multi-hour gaps).
  followbackSweepHours: 1,
  sweepLastRunAt: null,
  autoAcceptFollowRequests: true,

  lowWaterCandidates: 5,
  minFollowBackRate: 0.15,
  minPoolSize: 300,

  dryRun: false,

  pruneWhitelist: [],
  pruneBioFilterWords: [],
  pruneDailyLimit: 50,
  pruneScheduleDays: 0,
  pruneLastRunAt: null,
  // Matched to the widely-used console tool's scan cadence (~1.5–3.3 s per
  // 50-user API page): with the direct list walk this completes ~3200
  // followers in a few minutes while staying inside its proven rate band.
  pruneScanMinSeconds: 1,
  pruneScanMaxSeconds: 3,

  pacingModel: 'legacy',

  // The qualitative pattern is the source of truth for the pacing numbers: every
  // derived knob (daily volume, sessions, gaps, velocity, weave, prune cap, follow-back
  // windows, plan size) comes from resolvePattern(balanced), so there is ONE home.
  persona: 'balanced',
  pattern: { ...PERSONAS.balanced },
  ...resolvePattern(PERSONAS.balanced),

  tourCompletedAt: null,
};


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
    const parsed = JSON.parse(raw) as Partial<Settings>;
    // Migration: a file predating the qualitative pattern model has no `persona`/`pattern`.
    // Treat it as 'custom' AND drop the default-merged pattern so its hand-set numeric
    // knobs survive rather than being re-derived from a nominal pattern (§5.6.5).
    const legacyNoPattern = !('pattern' in parsed);
    if (!('persona' in parsed)) parsed.persona = 'custom';
    const merged = { ...DEFAULT_SETTINGS, ...parsed };
    if (legacyNoPattern && merged.persona === 'custom') {
      (merged as { pattern?: PatternSettings }).pattern = undefined;
    }
    return sanitizeSettings(merged);
  } catch (err) {
    warn('settings: failed to parse settings file, using defaults', {
      filePath,
      error: String(err),
    });
    return { ...DEFAULT_SETTINGS };
  }
}

// --- Validation -------------------------------------------------------------------

const num = (v: unknown, fallback: number, min: number, max: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return Math.min(max, Math.max(min, n));
};
const intNum = (v: unknown, fallback: number, min: number, max: number): number =>
  Math.round(num(v, fallback, min, max));
const boolVal = (v: unknown, fallback: boolean): boolean =>
  typeof v === 'boolean' ? v : fallback;
const strVal = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback);
const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const epochOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;

/**
 * Clamp every knob into its sane range. The UI keeps its own input guards, but
 * settings also arrive from disk and over IPC unvalidated — a hand-edited file
 * (or a bad renderer payload) must never produce a negative delay, a 100%
 * jitter that fires actions back-to-back, an inverted band, or a whitelist that
 * isn't an array (which used to crash the prune scan). Every out-of-range value
 * degrades to the nearest safe one, never to a throw.
 */
export function sanitizeSettings(s: Settings): Settings {
  const d = DEFAULT_SETTINGS;
  const out: Settings = { ...s };

  out.seed = strVal(s.seed, d.seed).trim();

  // Ratio bands: numeric sanity first, then enforce the piecewise ordering
  // hardLow ≤ bandLow ≤ peakLow ≤ peakHigh ≤ bandHigh ≤ hardHigh.
  out.hardLow = num(s.hardLow, d.hardLow, 0, 100);
  out.bandLow = Math.max(num(s.bandLow, d.bandLow, 0, 100), out.hardLow);
  out.peakLow = Math.max(num(s.peakLow, d.peakLow, 0, 100), out.bandLow);
  out.peakHigh = Math.max(num(s.peakHigh, d.peakHigh, 0, 100), out.peakLow);
  out.bandHigh = Math.max(num(s.bandHigh, d.bandHigh, 0, 100), out.peakHigh);
  out.hardHigh = Math.max(num(s.hardHigh, d.hardHigh, 0, 100), out.bandHigh);

  out.minFollowers = intNum(s.minFollowers, d.minFollowers, 0, 10_000_000);
  out.maxFollowers = Math.max(
    intNum(s.maxFollowers, d.maxFollowers, 1, 100_000_000),
    out.minFollowers,
  );
  out.privateBoost = num(s.privateBoost, d.privateBoost, 0, 1);

  out.maxWaitForFollowbackDays = num(s.maxWaitForFollowbackDays, d.maxWaitForFollowbackDays, 0.25, 60);
  out.holdAfterFollowbackDays = num(s.holdAfterFollowbackDays, d.holdAfterFollowbackDays, 0, 60);
  out.maxRetries = intNum(s.maxRetries, d.maxRetries, 0, 10);

  out.dailyOperatingRate = intNum(s.dailyOperatingRate, d.dailyOperatingRate, 1, 500);
  out.dailyHardCeiling = Math.max(
    intNum(s.dailyHardCeiling, d.dailyHardCeiling, 1, 1000),
    out.dailyOperatingRate,
  );
  out.minDelayMinutes = num(s.minDelayMinutes, d.minDelayMinutes, 0.5, 240);
  out.maxDelayMinutes = Math.max(num(s.maxDelayMinutes, d.maxDelayMinutes, 0.5, 480), out.minDelayMinutes);
  out.jitterPercent = num(s.jitterPercent, d.jitterPercent, 0, 90);
  out.activeHoursStart = intNum(s.activeHoursStart, d.activeHoursStart, 0, 23);
  out.activeHoursEnd = intNum(s.activeHoursEnd, d.activeHoursEnd, 0, 23);

  out.followbackSweepHours = num(s.followbackSweepHours, d.followbackSweepHours, 0.5, 168);
  out.sweepLastRunAt = epochOrNull(s.sweepLastRunAt);

  out.dailyPlanSize = intNum(s.dailyPlanSize, d.dailyPlanSize, 1, 200);
  out.lowWaterCandidates = intNum(s.lowWaterCandidates, d.lowWaterCandidates, 0, 100);
  out.minFollowBackRate = num(s.minFollowBackRate, d.minFollowBackRate, 0, 1);
  out.minPoolSize = intNum(s.minPoolSize, d.minPoolSize, 0, 1_000_000);

  out.dryRun = boolVal(s.dryRun, d.dryRun);
  out.autoAcceptFollowRequests = boolVal(s.autoAcceptFollowRequests, d.autoAcceptFollowRequests);

  out.pruneWhitelist = strArr(s.pruneWhitelist);
  out.pruneBioFilterWords = strArr(s.pruneBioFilterWords);
  out.pruneDailyLimit = intNum(s.pruneDailyLimit, d.pruneDailyLimit, 1, 1000);
  out.pruneScheduleDays = num(s.pruneScheduleDays, d.pruneScheduleDays, 0, 365);
  out.pruneLastRunAt = epochOrNull(s.pruneLastRunAt);
  out.tourCompletedAt = epochOrNull(s.tourCompletedAt);
  out.pruneScanMinSeconds = num(s.pruneScanMinSeconds, d.pruneScanMinSeconds, 0.5, 300);
  out.pruneScanMaxSeconds = Math.max(
    num(s.pruneScanMaxSeconds, d.pruneScanMaxSeconds, 0.5, 600),
    out.pruneScanMinSeconds,
  );

  out.pacingModel = s.pacingModel === 'organic' ? 'organic' : 'legacy';
  out.dailyVolumeVariancePct = num(s.dailyVolumeVariancePct, d.dailyVolumeVariancePct, 0, 60);
  out.restDayChancePct = num(s.restDayChancePct, d.restDayChancePct, 0, 30);
  out.sessionsPerDayMin = intNum(s.sessionsPerDayMin, d.sessionsPerDayMin, 1, 12);
  out.sessionsPerDayMax = Math.max(
    intNum(s.sessionsPerDayMax, d.sessionsPerDayMax, 1, 12),
    out.sessionsPerDayMin,
  );
  out.gapMedianSeconds = num(s.gapMedianSeconds, d.gapMedianSeconds, 30, 600);
  out.gapFloorSeconds = Math.min(
    num(s.gapFloorSeconds, d.gapFloorSeconds, 15, 300),
    out.gapMedianSeconds,
  );
  out.hourlyVelocityCap = intNum(s.hourlyVelocityCap, d.hourlyVelocityCap, 3, 40);
  out.weaveEnabled = boolVal(s.weaveEnabled, d.weaveEnabled);
  out.maxUnfollowFractionPerSession = num(
    s.maxUnfollowFractionPerSession,
    d.maxUnfollowFractionPerSession,
    0,
    1,
  );

  // Qualitative pattern (§5.6). A NAMED persona is authoritative: the numeric pacing
  // knobs are DERIVED from its bundle (users tune behavior, not distributions). In
  // 'custom' mode — or a legacy file with no `persona` — the numeric knobs are kept as
  // clamped (the renderer materializes them from the qualitative knobs on edit; a legacy
  // file's hand-set numbers survive migration). The default persona 'balanced' derives
  // exactly the historical numeric defaults, so a fresh install is unchanged.
  const hasNamedPersona =
    typeof s.persona === 'string' &&
    PERSONA_IDS.includes(s.persona as PersonaId) &&
    s.persona !== 'custom';
  if (hasNamedPersona) {
    const persona = s.persona as PersonaId;
    const pattern = { ...PERSONAS[persona as Exclude<PersonaId, 'custom'>] };
    out.persona = persona;
    out.pattern = pattern;
    const rp = resolvePattern(pattern);
    out.dailyOperatingRate = rp.dailyOperatingRate;
    out.dailyHardCeiling = rp.dailyHardCeiling;
    out.dailyVolumeVariancePct = rp.dailyVolumeVariancePct;
    out.restDayChancePct = rp.restDayChancePct;
    out.sessionsPerDayMin = rp.sessionsPerDayMin;
    out.sessionsPerDayMax = rp.sessionsPerDayMax;
    out.gapMedianSeconds = rp.gapMedianSeconds;
    out.gapFloorSeconds = rp.gapFloorSeconds;
    out.hourlyVelocityCap = rp.hourlyVelocityCap;
    out.weaveEnabled = rp.weaveEnabled;
    out.maxUnfollowFractionPerSession = rp.maxUnfollowFractionPerSession;
    out.maxWaitForFollowbackDays = rp.maxWaitForFollowbackDays;
    out.holdAfterFollowbackDays = rp.holdAfterFollowbackDays;
    out.dailyPlanSize = rp.dailyPlanSize;
  } else {
    out.persona = 'custom';
    out.pattern = sanitizePattern(s.pattern);
    if (s.pattern !== undefined && s.pattern !== null) {
      // A UI-tuned custom pattern derives its numbers too (a legacy numbers-only file
      // has no `pattern`, so its hand-set knobs are preserved instead).
      const rp = resolvePattern(out.pattern);
      out.dailyOperatingRate = rp.dailyOperatingRate;
      out.dailyHardCeiling = rp.dailyHardCeiling;
      out.dailyVolumeVariancePct = rp.dailyVolumeVariancePct;
      out.restDayChancePct = rp.restDayChancePct;
      out.sessionsPerDayMin = rp.sessionsPerDayMin;
      out.sessionsPerDayMax = rp.sessionsPerDayMax;
      out.gapMedianSeconds = rp.gapMedianSeconds;
      out.gapFloorSeconds = rp.gapFloorSeconds;
      out.hourlyVelocityCap = rp.hourlyVelocityCap;
      out.weaveEnabled = rp.weaveEnabled;
      out.maxUnfollowFractionPerSession = rp.maxUnfollowFractionPerSession;
      out.maxWaitForFollowbackDays = rp.maxWaitForFollowbackDays;
      out.holdAfterFollowbackDays = rp.holdAfterFollowbackDays;
      out.dailyPlanSize = rp.dailyPlanSize;
    }
  }

  return out;
}

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

const PERSONA_IDS: PersonaId[] = [
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
    bioFilterWords: s.pruneBioFilterWords,
    minDelayMs: s.minDelayMinutes * MS_PER_MINUTE,
    maxDelayMs: s.maxDelayMinutes * MS_PER_MINUTE,
    jitterPercent: s.jitterPercent,
    scanMinMs,
    scanMaxMs,
  };
}
