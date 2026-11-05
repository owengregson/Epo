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

import type { OwnFollowersTargetSource, SourcePreparationOptions } from '@/engine/chain-controller';
import { EXPLORATION_POLICY, explorationDayClock, weeklyCycleSince } from '@/engine/exploration-policy';
import { type Clock, SystemClock } from '@/governors/clock';
import type { PlanDayClock } from '@/kernel/plan';
import { SETTINGS_POLICY } from '@/kernel/settings-policy';
import type { ProfileEnricher } from '@/rim/profile-enricher';
import type { KnowledgeStore } from '@/store/knowledge-store';
import type { EnrichmentLevel } from '@/store/types';
import * as logger from '@/utils/logger';

/** Profile completeness, least to most: a tie on count goes to the more complete profile. */
const ENRICHMENT_ORDER: readonly EnrichmentLevel[] = ['stub', 'listed', 'profiled'];
const completeness = (level: EnrichmentLevel): number => ENRICHMENT_ORDER.indexOf(level);

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
  clock?: Clock;
  planDay?: Pick<PlanDayClock, 'window'>;
  minPoolSize?: number;
}

export class AdapterBackedOwnFollowersTargetSource implements OwnFollowersTargetSource {
  private readonly store: KnowledgeStore;
  private readonly ownPk: string;
  private readonly enricher?: ProfileEnricher;
  private readonly clock: Clock;
  private readonly planDay: Pick<PlanDayClock, 'window'>;
  private readonly minPoolSize: number;
  private preparation = { pending: false, retryAt: null as number | null };

  constructor(deps: OwnFollowersTargetSourceDeps) {
    this.store = deps.store;
    this.ownPk = deps.ownPk;
    this.enricher = deps.enricher;
    this.clock = deps.clock ?? new SystemClock();
    this.planDay = deps.planDay ?? explorationDayClock();
    this.minPoolSize = deps.minPoolSize ?? SETTINGS_POLICY.RECOMMENDED.minPoolSize;
  }

  preparationState(): { pending: boolean; retryAt: number | null } { return { ...this.preparation }; }

  async pick(minPoolSize?: number, options?: SourcePreparationOptions): Promise<string | null> {
    return (await this.candidates(minPoolSize, options))[0] ?? null;
  }

  async candidates(minPoolSize: number = this.minPoolSize, options?: SourcePreparationOptions): Promise<string[]> {
    let candidates = this.eligibleFollowers();
    this.preparation = { pending: false, retryAt: null };

    // No candidate carries a follower count → the ranking below would be a
    // pk-order coin flip. Enrich a bounded sample first (real IG traffic, but
    // a chain advance happens once per exhausted target).
    if (this.enricher && !candidates.some((c) => c.followers !== undefined && c.followers >= minPoolSize)) {
      const usernames: string[] = [];
      for (const c of candidates) {
        if (usernames.length >= Math.min(options?.profileLimit ?? EXPLORATION_POLICY.ownFollowersPickMax, EXPLORATION_POLICY.ownFollowersPickMax)) break;
        if (c.followers !== undefined || c.username === undefined || (c.enrichFailedAt !== undefined &&
          c.enrichFailedAt >= weeklyCycleSince((t) => this.planDay.window(t), this.clock.now()))) continue;
        usernames.push(c.username);
      }
      if (usernames.length > 0) {
        logger.info('rim.own-followers-target-source: enriching sample before ranking', {
          sample: usernames.length,
        });
        const enriched = await this.enricher.enrich(usernames);
        candidates = this.eligibleFollowers(); // re-read with fresh counts
        this.preparation = { retryAt: this.enricher.budgetResumeAt?.() ?? null,
          pending: enriched > 0 && candidates.some((c) => c.username !== undefined && c.followers === undefined &&
            (c.enrichFailedAt === undefined || c.enrichFailedAt < weeklyCycleSince((t) => this.planDay.window(t), this.clock.now()))) };
      }
    }

    candidates = candidates.filter((c) => c.username !== undefined && c.followers !== undefined && c.followers >= minPoolSize);
    candidates.sort((a, b) => (b.followers ?? -1) - (a.followers ?? -1) ||
      completeness(b.enrichment) - completeness(a.enrichment) || a.pk.localeCompare(b.pk));
    return candidates.slice(0, EXPLORATION_POLICY.maxSources).map((c) => c.pk);
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
      if (pk === this.ownPk) continue;
      if (account?.isPrivate === true && this.store.getEdge(this.ownPk, pk, 'follows')?.status !== 'active') continue;
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
