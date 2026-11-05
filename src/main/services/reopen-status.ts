/**
 * The reopen status contributors (spec §15.3, Appendix E): the catch-up's view, the own counts with the
 * outside-change marker, today's placed tallies on the plan-day, the journal and the requests. Every value
 * is read from the store at each composed status, so a mutation's push shows it at once.
 */

import type { FrontierSweep } from '@/engine/frontier-sweep';
import type { PlanDayClock } from '@/kernel/plan';
import type { JournalView, OwnCountsView, RequestsView } from '@/shared/reopen-view';
import type { KnowledgeStore } from '@/store/knowledge-store';
import type { StatusContributor } from './graph-types';

/** What the contributors read. */
export interface ReopenStatusDeps {
  readonly store: KnowledgeStore;
  readonly sweep: Pick<FrontierSweep, 'view'>;
  readonly dayClock: PlanDayClock;
  /** The following count's change since `since` that Epo's writes do not explain (the sweep's store port). */
  followingResidual(since: number | null): number;
}

/** The newest header with the changes seen since it, and what moved outside Epo since the following check. */
export function ownCounts(d: ReopenStatusDeps): OwnCountsView | null {
  const header = d.store.growth.latestOwnHeader();
  if (header === null) return null;
  const seenSince = d.store.growth.accounting(header.at, (t) => d.dayClock.window(t)).seenSince(header.at);
  return {
    followers: { count: header.followers, at: header.at, seenSince },
    following: { count: header.following, at: header.at },
    followingUnverified: d.followingResidual(d.store.reopen.get()?.following?.checkedAt ?? null),
  };
}

/** Open intents: due for their settlement read now, or parked until their next re-check. */
export function journalView(store: KnowledgeStore, now: number): JournalView {
  const open = store.effectIntents.pending().filter((i) => i.state === 'dispatched' || i.state === 'uncertain');
  const parked = open.filter((i) => i.nextAttemptAt !== null && i.nextAttemptAt > now);
  const next = parked.map((i) => i.nextAttemptAt as number);
  return { pending: open.length - parked.length, parked: parked.length, nextAttemptAt: next.length === 0 ? null : Math.min(...next) };
}

/** The last requests reading the drawer or the panel recorded. */
export function requestsView(store: KnowledgeStore): RequestsView | null {
  const r = store.reopen.get()?.requests ?? null;
  return r === null ? null : { count: r.count, complete: r.complete, observedAt: r.observedAt };
}

/** The five reopen contributors of one built graph (they read its store at each composed status). */
export function reopenContributors(d: ReopenStatusDeps): StatusContributor[] {
  return [
    { name: 'catchUp', contribute: () => ({ catchUp: d.sweep.view() }) },
    { name: 'own', contribute: () => ({ own: ownCounts(d) }) },
    { name: 'today', contribute: (_g, now) => ({ today: d.store.growth.today(d.dayClock.window(now)) }) },
    { name: 'journal', contribute: (_g, now) => ({ journal: journalView(d.store, now) }) },
    { name: 'requests', contribute: () => ({ requests: requestsView(d.store) }) },
  ];
}
