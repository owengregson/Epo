import type { ChainConfig } from '../engine/chain-controller';
import type { ChurnConfig } from '../engine/churn-scheduler';
import type { FollowbackConfig } from '../engine/followback-watcher';
import type { PruneConfig } from '../engine/prune-engine';
import type { ScannerConfig } from '../engine/scanner';
import { SCORER_DEFAULTS, type ScorerConfig } from '../engine/scorer';
import type { RateGovernorConfig } from '../governors/rate-governor';
import { MS_PER_DAY, MS_PER_MINUTE } from '../timing/units';
import type { Settings } from './v1/settings-v1-types';

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
    holdAfterFollowbackMs: s.holdAfterFollowbackDays * MS_PER_DAY,
    maxRetries: s.maxRetries,
    // v1 has no mutuals choice: held mutuals rotate (the v2 intent `mutuals` drives it).
    rotateMutuals: true,
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

/** Project the follow-back appliers' config out of Settings (days → ms). */
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
