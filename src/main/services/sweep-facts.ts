/**
 * The frontier sweep's store port (spec §9.2–9.5, §9.10): the frontiers, the reads that size each step,
 * the window tallies, and the follow-back appliers. Every number here is a count of stored facts.
 */

import type { FollowbackWatcher } from '@/engine/followback-watcher';
import type { SweepFacts, SweepTally } from '@/engine/frontier-sweep';
import type { KnowledgeStore } from '@/store/knowledge-store';

/** The store and the appliers as the sweep's port. */
export function sweepFacts(store: KnowledgeStore, ownPk: string, watcher: FollowbackWatcher): SweepFacts {
  const growth = store.growth;
  const active = (pk: string): boolean => store.getEdge(pk, ownPk, 'follows')?.status === 'active';
  /** The changes that ended after `from` (and by `to`). */
  const changesIn = (from: number, to = Number.POSITIVE_INFINITY) => growth.changesSince(from).filter((c) => c.hi > from && c.hi <= to);
  return {
    state: () => store.reopen.get(),
    persist: (s) => store.reopen.set(s),
    ensureBaseline: (at) => store.ensureFollowersBaseline(at),
    lastHeaderAt: () => growth.latestOwnHeader()?.at ?? null,
    censusAt: () => store.censusLastCompleteAt(),
    gainFloor: (at) => store.censusLastCompleteAt() ?? store.followersBaselineAt() ?? at,
    headNeed: (frontierAt, withHeader) => {
      if (frontierAt === null) return { identifiedSinceFrontier: 0, unexplainedGains: 0 };
      const identified = new Set(changesIn(frontierAt).filter((c) => c.delta === 1 && active(c.accountPk)).map((c) => c.accountPk)).size;
      const anchor = withHeader ? growth.headerAtOrBefore(frontierAt) : null;
      const latest = growth.latestOwnHeader();
      if (anchor === null || latest === null) return { identifiedSinceFrontier: identified, unexplainedGains: 0 };
      const net = changesIn(anchor.at).reduce((s, c) => s + c.delta, 0);
      return { identifiedSinceFrontier: identified, unexplainedGains: Math.max(0, latest.followers - anchor.followers - net) };
    },
    followingResidual: (since) => {
      const anchor = since === null ? growth.oldestHeader() : growth.headerAtOrBefore(since);
      const latest = growth.latestOwnHeader();
      if (anchor === null || latest === null || latest.at <= anchor.at) return 0;
      const epo = store.tallySince(anchor.at);
      return latest.following - anchor.following - (epo.follow - epo.unfollow);
    },
    censusReadFollowingSince: (t) => (store.getPruneCensus()?.at ?? Number.NEGATIVE_INFINITY) >= t,
    activeRequests: () => store.activeRequestPks(),
    endRequest: (pk, at) => store.observeEdge(pk, ownPk, 'requests', false, at),
    tally: (from, to): SweepTally => {
      const before = growth.headerAtOrBefore(from);
      const after = growth.latestOwnHeader();
      const changes = changesIn(from, to);
      const gained = changes.filter((c) => c.delta === 1).length;
      const lost = changes.length - gained;
      return {
        followers: { before: before?.followers ?? null, after: after?.followers ?? null },
        following: { before: before?.following ?? null, after: after?.following ?? null },
        newFollowers: gained, followBacks: growth.followBacksIn({ startsAt: from, endsAt: to }), lostIdentified: lost,
        unattributed: before !== null && after !== null && after.at > before.at
          ? after.followers - before.followers - (gained - lost) : 0,
        requestsWaiting: store.activeRequestPks().length, journalPending: store.effectIntents.due(to).length,
      };
    },
    applyEvent: (e) => watcher.applyEvent(e),
    applyUndated: (e) => watcher.applyUndated(e),
    applyRequester: (r, at) => watcher.applyRequester(r, at),
    applyAccepted: (a) => watcher.applyAccepted(a),
    consistencyPass: (now) => watcher.consistencyPass(now),
  };
}
