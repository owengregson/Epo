/**
 * StoreBackedTargetDiscovery — the live `TargetDiscovery` port (§3.5 step 2).
 *
 * Finds "popular hubs" inside the exhausted target's ALREADY-HARVESTED
 * audience, from data the app has already paid for — zero extra Instagram
 * requests:
 *
 *  - candidates: the target's observed followers that enrichment profiled
 *    (follower counts known), public (we must be able to read THEIR followers
 *    without following first), not us, and not already a chain target;
 *  - `poolSize`: the candidate's own follower count (the audience the chain
 *    would poach next);
 *  - quality uses mature outcomes with a conservative prior; unknown sources
 *    inherit the global baseline, not their parent's possibly pending cohort;
 *  - observed audience overlap discounts familiar neighborhoods. Raw follower
 *    count is a viability check, not a reason to mine a larger hub forever.
 */

import { CHAIN_DEFAULTS, type ChainConfig, type DiscoveredTarget, type TargetDiscovery } from '@/engine/chain-controller';
import { matureYields, observedOverlap, priorYield } from '@/engine/source-quality';
import { type Clock, SystemClock } from '@/governors/clock';
import { EXPLORATION_POLICY } from '@/kernel/exploration-policy';
import type { KnowledgeStore } from '@/store/knowledge-store';
import * as logger from '@/utils/logger';

/** At most this many hubs are proposed per advance (the gate then filters). */
const MAX_DISCOVERED = EXPLORATION_POLICY.maxDiscovered;

export interface StoreBackedTargetDiscoveryDeps {
  store: KnowledgeStore;
  ownPk: string;
  clock?: Clock;
  outcomeWindowMs?: () => number;
}

export class StoreBackedTargetDiscovery implements TargetDiscovery {
  private readonly store: KnowledgeStore;
  private readonly ownPk: string;
  private readonly clock: Clock;
  private readonly outcomeWindowMs?: () => number;

  constructor(deps: StoreBackedTargetDiscoveryDeps) {
    this.store = deps.store;
    this.ownPk = deps.ownPk;
    this.clock = deps.clock ?? new SystemClock();
    this.outcomeWindowMs = deps.outcomeWindowMs;
  }

  async discover(currentTargetPk: string, gates: ChainConfig = CHAIN_DEFAULTS): Promise<DiscoveredTarget[]> {
    const existingTargets = this.store.targetPks();
    const now = this.clock.now();
    const yields = matureYields(this.store, now, this.outcomeWindowMs?.());
    const baseline = yields.get(null) ?? priorYield();
    const recentSources = this.store.listTargets().slice(-MAX_DISCOVERED).map((t) => t.accountPk);

    const hubs: Array<{ pk: string; followers: number }> = [];
    for (const pk of this.store.followersOf(currentTargetPk)) {
      if (pk === this.ownPk || pk === currentTargetPk) continue;
      if (existingTargets.has(pk)) continue;
      const acc = this.store.getAccount(pk);
      if (acc === null || acc.followers === undefined || acc.followers < gates.minPoolSize) continue;
      if (acc.isPrivate === true) continue; // cannot read a private hub's followers
      hubs.push({ pk, followers: acc.followers });
    }
    const ranked = hubs.map((h) => {
      const quality = yields.get(h.pk) ?? priorYield();
      return {
      pk: h.pk,
      projectedFollowBackRate: quality.mature === 0 ? baseline.rate : quality.rate,
      poolSize: h.followers,
      matureSamples: quality.mature,
      overlap: observedOverlap(this.store, h.pk, recentSources),
      };
    });
    ranked.sort((a, b) => {
      const utility = (d: DiscoveredTarget): number =>
        d.projectedFollowBackRate * (1 - EXPLORATION_POLICY.overlapWeight * (d.overlap ?? EXPLORATION_POLICY.unknownOverlap));
      return utility(b) - utility(a) || a.pk.localeCompare(b.pk);
    });
    const top = ranked.filter((hub) => hub.matureSamples === 0 || hub.projectedFollowBackRate >= gates.minFollowBackRate)
      .slice(0, MAX_DISCOVERED);
    logger.info('rim.target-discovery: discovered hubs in poached audience', {
      target: currentTargetPk,
      candidates: hubs.length,
      proposed: top.length,
      baselineFollowBackRate: baseline.rate,
      matureSamples: baseline.mature,
    });
    return top;
  }
}
