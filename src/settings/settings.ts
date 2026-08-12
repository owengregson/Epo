import * as fs from 'fs';

import { type ScorerConfig, SCORER_DEFAULTS } from '../engine/scorer';
import { type ChurnConfig } from '../engine/churn-scheduler';
import { type FollowbackConfig, FOLLOWBACK_DEFAULTS } from '../engine/followback-watcher';
import { type ScannerConfig } from '../engine/scanner';
import { type ChainConfig } from '../engine/chain-controller';
import { type RateGovernorConfig } from '../governors/rate-governor';
import { type RequestBudgetConfig } from '../governors/request-budget';
import { warn } from '../utils/logger';

/**
 * The single user-facing knob set (v3 §4). Every component's config is a pure
 * projection of this object (see the `toXConfig` mappers), so there is exactly ONE
 * place a user tunes behavior and the component defaults can never silently drift.
 *
 * Persisted as JSON in `userData`, separate from the DB (§6). Human-facing units are
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

  // --- Churn lifecycle timers (human units) + retry cap. ---
  maxWaitForFollowbackDays: number;
  holdAfterFollowbackDays: number;
  maxRetries: number;

  // --- Rate governor: daily caps, human inter-action delay, active hours. ---
  dailyHardCeiling: number;
  dailyOperatingRate: number;
  minDelayMinutes: number;
  maxDelayMinutes: number;
  jitterPercent: number;
  activeHoursStart: number;
  activeHoursEnd: number;

  // --- Request budget (token bucket) + follow-back sweep cadence. ---
  requestBudgetMaxPerWindow: number;
  requestBudgetWindowMinutes: number;
  followbackSweepHours: number;

  // --- Scanner / chain / pool health. ---
  dailyPlanSize: number;
  lowWaterCandidates: number;
  minFollowBackRate: number;
  minPoolSize: number;

  /** When true, actions are logged-and-noop'd (intent still recorded) — never touches the account. */
  dryRun: boolean;
}

/**
 * Fallback values for every knob, consistent with each component's own `*_DEFAULTS`
 * (v3 §4: the component defaults live here). Time knobs are in human units.
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

  maxWaitForFollowbackDays: 4,
  holdAfterFollowbackDays: 2,
  maxRetries: 3,

  dailyHardCeiling: 50,
  dailyOperatingRate: 25,
  minDelayMinutes: 3,
  maxDelayMinutes: 7,
  jitterPercent: 30,
  activeHoursStart: 8,
  activeHoursEnd: 22,

  requestBudgetMaxPerWindow: 200,
  requestBudgetWindowMinutes: 60,
  followbackSweepHours: 4,

  dailyPlanSize: 25,
  lowWaterCandidates: 5,
  minFollowBackRate: 0.15,
  minPoolSize: 300,

  dryRun: false,
};

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 3600 * 1000;

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
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch (err) {
    warn('settings: failed to parse settings file, using defaults', {
      filePath,
      error: String(err),
    });
    return { ...DEFAULT_SETTINGS };
  }
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

/** Project the Scorer's config out of Settings (`bandEdgeScore` is not user-tunable). */
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
  };
}

/** Project the Churn Scheduler's config out of Settings (days → ms). */
export function toChurnConfig(s: Settings): ChurnConfig {
  return {
    maxWaitForFollowbackMs: s.maxWaitForFollowbackDays * MS_PER_DAY,
    holdAfterFollowbackMs: s.holdAfterFollowbackDays * MS_PER_DAY,
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

/** Project the Request Budget's config out of Settings (window minutes → ms). */
export function toRequestBudgetConfig(s: Settings): RequestBudgetConfig {
  return {
    maxRequestsPerWindow: s.requestBudgetMaxPerWindow,
    windowMs: s.requestBudgetWindowMinutes * MS_PER_MINUTE,
  };
}

/**
 * Project the Follow-back Watcher's config out of Settings (days → ms). `maxPagesPerCheck`
 * is a request-safety bound, not a user knob, so it carries the component default.
 */
export function toFollowbackConfig(s: Settings): FollowbackConfig {
  return {
    holdAfterFollowbackMs: s.holdAfterFollowbackDays * MS_PER_DAY,
    maxPagesPerCheck: FOLLOWBACK_DEFAULTS.maxPagesPerCheck,
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
