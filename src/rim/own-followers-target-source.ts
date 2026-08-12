/**
 * AdapterBackedOwnFollowersTargetSource — the live `OwnFollowersTargetSource` port
 * (§2). The Chain Controller's fallback next-target chooser: when no discovered hub
 * clears the yield gate, pick the best account from OUR OWN followers so the chain
 * never dead-ends.
 *
 * "Our own followers" are the sources of active `pk → ownPk (follows)` edges
 * (`store.followersOf(ownPk)`). Among those not already a chain target, we prefer
 * the highest known follower count, breaking ties by profile completeness
 * (enrichment level) then pk for determinism. This is pure over the store — no
 * live Instagram traffic — so it stays deterministic and unit-testable.
 */

import type { KnowledgeStore } from '@/store/knowledge-store';
import type { EnrichmentLevel } from '@/store/types';
import type { OwnFollowersTargetSource } from '@/engine/chain-controller';
import * as logger from '@/utils/logger';

/** Profile-completeness ordering for tie-breaks (higher is more complete). */
const ENRICHMENT_RANK: Record<EnrichmentLevel, number> = {
  stub: 0,
  listed: 1,
  profiled: 2,
};

export interface OwnFollowersTargetSourceDeps {
  store: KnowledgeStore;
  ownPk: string;
}

export class AdapterBackedOwnFollowersTargetSource implements OwnFollowersTargetSource {
  private readonly store: KnowledgeStore;
  private readonly ownPk: string;

  constructor(deps: OwnFollowersTargetSourceDeps) {
    this.store = deps.store;
    this.ownPk = deps.ownPk;
  }

  async pick(): Promise<string | null> {
    const followers = this.store.followersOf(this.ownPk);

    let best: { pk: string; followers: number; enrichmentRank: number } | null = null;
    for (const pk of followers) {
      // Skip anyone already promoted into the chain as a target.
      if (this.store.getTarget(pk) !== null) continue;

      const account = this.store.getAccount(pk);
      const followerCount = account?.followers ?? -1;
      const enrichmentRank = account ? ENRICHMENT_RANK[account.enrichment] : 0;

      if (
        best === null ||
        followerCount > best.followers ||
        (followerCount === best.followers && enrichmentRank > best.enrichmentRank) ||
        (followerCount === best.followers &&
          enrichmentRank === best.enrichmentRank &&
          pk < best.pk)
      ) {
        best = { pk, followers: followerCount, enrichmentRank };
      }
    }

    if (best === null) {
      logger.info('rim.own-followers-target-source: no eligible follower to promote', {
        ownPk: this.ownPk,
      });
      return null;
    }
    logger.info('rim.own-followers-target-source: picked fallback target', {
      pk: best.pk,
      followers: best.followers,
    });
    return best.pk;
  }
}
