/**
 * The diffed reload (spec §6.6): after a saved change each live component reloads only when its projected
 * config changed, so a protection or seed edit no longer rescans the whole queue.
 */
import type { BuiltGraph } from '@/main/services/graph-types';
import type { EffectiveSettings } from '@/settings/effective';
import {
  toChainConfig, toChurnConfig, toFollowbackConfig, toPruneConfig, toRateGovernorConfig,
  toScannerConfig, toScorerConfig,
} from '@/settings/mappers';
import type { Touched } from '@/settings/ops';
import * as logger from '@/utils/logger';

/** A saved revision as the reload reads it: the effective records and what the change touched. */
export interface ReloadEvent { readonly prev: EffectiveSettings; readonly next: EffectiveSettings; readonly touched: ReadonlySet<Touched> }

/** Reload what changed between the resolved settings records; returns the components reloaded. */
export function reloadChanged(g: BuiltGraph, prev: EffectiveSettings, next: EffectiveSettings, e: ReloadEvent): string[] {
  const moved = <T>(f: (s: EffectiveSettings) => T): boolean => JSON.stringify(f(prev)) !== JSON.stringify(f(next));
  const reloaded: string[] = [];
  const reload = (name: string, run: () => void): void => {
    run();
    reloaded.push(name);
  };
  if (moved(toRateGovernorConfig)) reload('rate', () => g.rate.applyConfig(toRateGovernorConfig(next)));
  // A protection edit re-applies the unfollow rules at once, the engine running or stopped (spec §7.4).
  const churnMoved = JSON.stringify(toChurnConfig(e.prev)) !== JSON.stringify(toChurnConfig(e.next));
  if (churnMoved || e.touched.has('protection')) reload('churn', () => g.churn.applyConfig(toChurnConfig(e.next)));
  if (moved(toScannerConfig) || moved(toScorerConfig)) {
    reload('scanner', () => g.scanner.applyConfig(toScannerConfig(next), toScorerConfig(next)));
  }
  if (moved(toFollowbackConfig)) reload('followback', () => g.followback.applyConfig(toFollowbackConfig(next)));
  if (moved(toChainConfig)) reload('chain', () => g.chain.applyConfig(toChainConfig(next)));
  if (moved(toPruneConfig)) reload('prune', () => g.pruneEngine.applyConfig(toPruneConfig(next)));
  if (prev.dryRun !== next.dryRun) reload('practice', () => g.churnActions.setDryRun(next.dryRun));
  if (JSON.stringify(prev) !== JSON.stringify(next)) g.engine.applySettings(next);
  if (reloaded.length > 0) logger.info('settings: reloaded the changed live configs', { reloaded });
  return reloaded;
}
