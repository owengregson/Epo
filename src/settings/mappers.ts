import type { ChainConfig } from '../engine/chain-controller';
import type { ChurnConfig } from '../engine/churn-scheduler';
import type { FollowbackConfig } from '../engine/followback-watcher';
import type { PruneConfig } from '../engine/prune-engine';
import type { ScannerConfig } from '../engine/scanner';
import type { ScorerConfig } from '../engine/scorer';
import type { RateGovernorConfig } from '../governors/rate-governor';
import { MS_PER_DAY } from '../timing/units';
import type { EffectiveSettings } from './effective';

/** Project every resolved audience knob, including Advanced scorer overrides. */
export function toScorerConfig(s: Pick<EffectiveSettings, 'bandLow' | 'bandHigh' | 'peakLow' | 'peakHigh' | 'hardLow' | 'hardHigh' | 'minFollowers' | 'maxFollowers' | 'privateBoost' | 'bandEdgeScore' | 'mutualCap' | 'mutualWeight'>): ScorerConfig {
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
    bandEdgeScore: s.bandEdgeScore,
    mutualCap: s.mutualCap,
    mutualWeight: s.mutualWeight,
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
export function toRateGovernorConfig(s: Pick<EffectiveSettings, 'dailyHardCeiling'>): RateGovernorConfig {
  return { dailyHardCeiling: s.dailyHardCeiling };
}

/** Project the follow-back appliers' config out of Settings (days → ms). */
export function toFollowbackConfig(s: Pick<EffectiveSettings, 'holdAfterFollowbackDays' | 'autoAcceptFollowRequests'>): FollowbackConfig {
  return {
    holdAfterFollowbackMs: s.holdAfterFollowbackDays * MS_PER_DAY,
    autoAcceptRequests: s.autoAcceptFollowRequests,
  };
}

/** Project the Scanner's config out of Settings. */
export function toScannerConfig(s: Pick<EffectiveSettings, 'dailyPlanSize'>): ScannerConfig {
  return {
    dailyPlanSize: s.dailyPlanSize,
  };
}

/** Project the Chain Controller's config out of Settings. */
export function toChainConfig(s: Pick<EffectiveSettings, 'minFollowBackRate' | 'minPoolSize'>): ChainConfig {
  return {
    minFollowBackRate: s.minFollowBackRate,
    minPoolSize: s.minPoolSize,
  };
}

/** The no-plan test rig's ceiling. Production reads the plan's unfollow budget and tempo. */
export function toPruneConfig(s: Pick<EffectiveSettings, 'dailyHardCeiling'>): PruneConfig {
  return { dailyLimit: s.dailyHardCeiling };
}
