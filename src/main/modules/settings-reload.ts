/**
 * The diffed reload (spec §6.6): after a saved change each live component reloads only when its projected
 * config changed, so a protection or seed edit no longer rescans the whole queue.
 */
import type { BuiltGraph } from '@/main/services/graph-types';
import {
  type Settings, toChainConfig, toChurnConfig, toFollowbackConfig, toPacingConfig, toPruneConfig, toRateGovernorConfig,
  toScannerConfig, toScorerConfig,
} from '@/settings/settings';
import * as logger from '@/utils/logger';

/** Reload what changed between two v1 views of the settings; returns the components reloaded. */
export function reloadChanged(g: BuiltGraph, prev: Settings, next: Settings): string[] {
  const moved = <T>(f: (s: Settings) => T): boolean => JSON.stringify(f(prev)) !== JSON.stringify(f(next));
  const reloaded: string[] = [];
  const reload = (name: string, run: () => void): void => {
    run();
    reloaded.push(name);
  };
  if (moved(toRateGovernorConfig)) reload('rate', () => g.rate.applyConfig(toRateGovernorConfig(next)));
  if (moved(toChurnConfig)) reload('churn', () => g.churn.applyConfig(toChurnConfig(next)));
  if (moved(toScannerConfig) || moved(toScorerConfig)) {
    reload('scanner', () => g.scanner.applyConfig(toScannerConfig(next), toScorerConfig(next)));
  }
  if (moved(toFollowbackConfig)) reload('followback', () => g.followback.applyConfig(toFollowbackConfig(next)));
  if (moved(toChainConfig)) reload('chain', () => g.chain.applyConfig(toChainConfig(next)));
  if (moved(toPruneConfig)) reload('prune', () => g.pruneEngine.applyConfig(toPruneConfig(next)));
  if (moved(toPacingConfig) && g.pacing !== null && g.pacing !== undefined) {
    reload('pacing', () => g.pacing?.applyConfig(toPacingConfig(next)));
  }
  if (prev.dryRun !== next.dryRun) reload('practice', () => g.churnActions.setDryRun(next.dryRun));
  if (JSON.stringify(prev) !== JSON.stringify(next)) g.engine.applySettings(next);
  if (reloaded.length > 0) logger.info('settings: reloaded the changed live configs', { reloaded });
  return reloaded;
}
