import type { ChainConfig } from '../engine/chain-controller';
import type { ChurnConfig } from '../engine/churn-scheduler';
import type { FollowbackConfig } from '../engine/followback-watcher';
import type { PruneConfig } from '../engine/prune-engine';
import type { ScannerConfig } from '../engine/scanner';
import { SCORER_DEFAULTS, type ScorerConfig } from '../engine/scorer';
import type { RateGovernorConfig } from '../governors/rate-governor';
import { MS_PER_DAY } from '../timing/units';
import type { EffectiveSettings } from './effective';
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

/** The churn knobs: the follow-back windows, the attempts and the v2 mutuals choice (the effective record's). */
export type ChurnKnobs = Pick<EffectiveSettings, 'maxWaitForFollowbackDays' | 'holdAfterFollowbackDays' | 'maxRetries' | 'rotateMutuals'>;

/** Project the Churn Scheduler's config (days → ms); `rotateMutuals` is the intent's `mutuals` choice. */
export function toChurnConfig(s: ChurnKnobs): ChurnConfig {
  return {
    maxWaitForFollowbackMs: s.maxWaitForFollowbackDays * MS_PER_DAY,
    holdAfterFollowbackMs: s.holdAfterFollowbackDays * MS_PER_DAY,
    maxRetries: s.maxRetries,
    rotateMutuals: s.rotateMutuals,
  };
}

/** Project the Rate Governor's config out of Settings: the hard ceiling (the plan paces; spec §5.13 S2). */
export function toRateGovernorConfig(s: Settings): RateGovernorConfig {
  return { dailyHardCeiling: s.dailyHardCeiling };
}

/** Project the Follow-back Watcher's config out of Settings (days → ms). */
export function toFollowbackConfig(s: Settings): FollowbackConfig {
  return {
    maxWaitForFollowbackMs: s.maxWaitForFollowbackDays * MS_PER_DAY,
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
 * Project the Prune Engine's config out of Settings: the cap a rig without the plan reads, and the SCAN
 * pacing (seconds → ms) clamped so `0 ≤ scanMinMs ≤ scanMaxMs`. The plan paces the run (spec §5.13 S2);
 * protection is the predicate's on every path, so no list rides here.
 */
export function toPruneConfig(s: Settings): PruneConfig {
  const scanMinMs = Math.max(0, s.pruneScanMinSeconds * 1000);
  const scanMaxMs = Math.max(scanMinMs, s.pruneScanMaxSeconds * 1000);
  return { dailyLimit: s.pruneDailyLimit, scanMinMs, scanMaxMs };
}
