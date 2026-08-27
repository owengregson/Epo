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
 *  - `projectedFollowBackRate`: the CURRENT target's realized follow-back rate
 *    — the best available proxy for the audience quality a hub discovered
 *    inside that same audience will yield.
 *
 * This makes the ChainController's promotion path (and the
 * `minFollowBackRate` / `minPoolSize` settings) live: before this, discovery
 * was a stub returning `[]`, every advance silently took the own-followers
 * fallback, and both knobs were dead. The gate composes sensibly: a session
 * that yielded poorly projects poorly, so its hubs are refused and the chain
 * falls back to own followers — exactly the intended minimum-yield behavior.
 */

import type { DiscoveredTarget, TargetDiscovery } from '@/engine/chain-controller';
import type { KnowledgeStore } from '@/store/knowledge-store';
import * as logger from '@/utils/logger';

/** At most this many hubs are proposed per advance (the gate then filters). */
const MAX_DISCOVERED = 5;

export interface StoreBackedTargetDiscoveryDeps {
  store: KnowledgeStore;
  ownPk: string;
}

export class StoreBackedTargetDiscovery implements TargetDiscovery {
  private readonly store: KnowledgeStore;
  private readonly ownPk: string;

  constructor(deps: StoreBackedTargetDiscoveryDeps) {
    this.store = deps.store;
    this.ownPk = deps.ownPk;
  }

  async discover(currentTargetPk: string): Promise<DiscoveredTarget[]> {
    const yieldStats = this.store.targetYield(currentTargetPk, this.ownPk);
    const projected = yieldStats.followBackRate;
    const existingTargets = this.store.targetPks();

    const hubs: Array<{ pk: string; followers: number }> = [];
    for (const pk of this.store.followersOf(currentTargetPk)) {
      if (pk === this.ownPk || pk === currentTargetPk) continue;
      if (existingTargets.has(pk)) continue;
      const acc = this.store.getAccount(pk);
      if (acc === null || acc.followers === undefined) continue; // never enriched
      if (acc.isPrivate === true) continue; // cannot read a private hub's followers
      hubs.push({ pk, followers: acc.followers });
    }
    hubs.sort((a, b) => (b.followers - a.followers) || (a.pk < b.pk ? -1 : 1));

    const top = hubs.slice(0, MAX_DISCOVERED).map((h) => ({
      pk: h.pk,
      projectedFollowBackRate: projected,
      poolSize: h.followers,
    }));
    logger.info('rim.target-discovery: discovered hubs in poached audience', {
      target: currentTargetPk,
      candidates: hubs.length,
      proposed: top.length,
      projectedFollowBackRate: projected,
    });
    return top;
  }
}
