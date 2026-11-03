/**
 * Engine configs for tests, each projected from the v1 `DEFAULT_SETTINGS`
 * through the same mappers main uses, so a suite never restates a component's
 * own defaults (and those defaults can be deleted later).
 */
import {
  DEFAULT_SETTINGS, type Settings, toChainConfig, toChurnConfig, toFollowbackConfig, toPruneConfig,
  toRateGovernorConfig, toScannerConfig, toScorerConfig,
} from '@/settings/settings';

/** Every engine config the mappers project, from `settings` (default: `DEFAULT_SETTINGS`). */
export function configsFrom(settings: Settings = DEFAULT_SETTINGS) {
  return {
    scorer: toScorerConfig(settings),
    churn: toChurnConfig(settings),
    followback: toFollowbackConfig(settings),
    chain: toChainConfig(settings),
    prune: toPruneConfig(settings),
    rateGovernor: toRateGovernorConfig(settings),
    scanner: toScannerConfig(settings),
  };
}

export const DEFAULT_CONFIGS = configsFrom();
