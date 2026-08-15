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
import type { ProfileEnricher } from '@/rim/profile-enricher';
import * as logger from '@/utils/logger';

/** Profile-completeness ordering for tie-breaks (higher is more complete). */
const ENRICHMENT_RANK: Record<EnrichmentLevel, number> = {
  stub: 0,
  listed: 1,
  profiled: 2,
};

/** How many un-profiled own followers one pick() may enrich before ranking. */
const PICK_ENRICH_CAP = 15;

export interface OwnFollowersTargetSourceDeps {
  store: KnowledgeStore;
  ownPk: string;
  /**
   * When wired, a pick with NO profiled candidates first enriches a bounded
   * sample so the ranking has data to rank on. Own followers arrive from
   * followers-list pages, which carry NO counts — without this the
   * "highest follower count" comparison was `-1 === -1` for every candidate
   * and the tie-break handed the chain the lexicographically smallest pk: an
   * arbitrary (usually tiny) account. Chain advances are rare, so one bounded
   * enrichment pass here is cheap relative to picking a dead-end target.
   */
  enricher?: ProfileEnricher;
}

export class AdapterBackedOwnFollowersTargetSource implements OwnFollowersTargetSource {
  private readonly store: KnowledgeStore;
  private readonly ownPk: string;
  private readonly enricher?: ProfileEnricher;

  constructor(deps: OwnFollowersTargetSourceDeps) {
    this.store = deps.store;
    this.ownPk = deps.ownPk;
    this.enricher = deps.enricher;
  }

  async pick(): Promise<string | null> {
    let candidates = this.eligibleFollowers();

    // No candidate carries a follower count → the ranking below would be a
    // pk-order coin flip. Enrich a bounded sample first (real IG traffic, but
    // a chain advance happens once per exhausted target).
    if (this.enricher && !candidates.some((c) => c.followers !== undefined)) {
      const usernames: string[] = [];
      for (const c of candidates) {
        if (usernames.length >= PICK_ENRICH_CAP) break;
        if (c.username === undefined || c.enrichFailedAt !== undefined) continue;
        usernames.push(c.username);
      }
      if (usernames.length > 0) {
        logger.info('rim.own-followers-target-source: enriching sample before ranking', {
          sample: usernames.length,
        });
        await this.enricher.enrich(usernames);
        candidates = this.eligibleFollowers(); // re-read with fresh counts
      }
    }

    let best: { pk: string; followers: number; enrichmentRank: number } | null = null;
    for (const account of candidates) {
      const pk = account.pk;
      const followerCount = account.followers ?? -1;
      const enrichmentRank = ENRICHMENT_RANK[account.enrichment];

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

  /** Own followers not already promoted into the chain, as account states. */
  private eligibleFollowers(): Array<{
    pk: string;
    username?: string;
    followers?: number;
    enrichment: EnrichmentLevel;
    enrichFailedAt?: number;
  }> {
    const targets = this.store.targetPks();
    const out = [];
    for (const pk of this.store.followersOf(this.ownPk)) {
      if (targets.has(pk)) continue; // already promoted into the chain
      const account = this.store.getAccount(pk);
      out.push({
        pk,
        username: account?.username,
        followers: account?.followers,
        enrichment: account?.enrichment ?? ('stub' as EnrichmentLevel),
        enrichFailedAt: account?.enrichFailedAt,
      });
    }
    return out;
  }
}
