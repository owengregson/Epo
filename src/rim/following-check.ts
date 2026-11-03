/**
 * The following check (step G, spec §9.1–9.3): our own following list read whole — the ordered
 * response plus one plain probe, through the walker's whole-list rule — so outside changes are known
 * exactly. Each row is written as it parses; only a verified-complete read removes an edge: managed
 * records the owner unfollowed become `external`, and accounts the owner followed are outside follows.
 */

import type { Sentinel } from '@/adapter/sentinel';
import type { Observation } from '@/adapter/surface-types';
import { BOUNDS_REENTRY } from '@/kernel/reentry-policy';
import type { ListPageWalker } from '@/rim/list-page-walker';
import type { KnowledgeStore } from '@/store/knowledge-store';
import type { FollowState } from '@/store/types';
import * as logger from '@/utils/logger';

export type FollowingCheckResult =
  | { readonly ok: true; readonly complete: true; readonly count: number; readonly removed: number; readonly added: number }
  | { readonly ok: false; readonly reason: 'read-budget' | 'shape-mismatch' | 'fetch-failed' | 'incomplete'
      | `sentinel:${string}` | 'stopped'; readonly retryAt?: number };

/** The narrow store port the check reads and writes. */
export interface FollowingFacts {
  /** Who we follow by the graph before the read. */
  activeFollowing(): ReadonlySet<string>;
  /** One row of the list: the account and our edge to it, as it parses. */
  observeRow(obs: Observation): void;
  /** A verified absence: our edge to `pk` ended outside Epo. */
  removeFollowing(pk: string, at: number): void;
  /** Whether Epo manages a follow of `pk` (its follow is Epo's, not an outside one). */
  managed(pk: string): boolean;
  /** A managed record the owner unfollowed outside Epo becomes `external`. */
  endManaged(pk: string, at: number): void;
}

/** The record states in which Epo follows the account. */
const FOLLOWING_STATES: ReadonlySet<FollowState> = new Set<FollowState>(['pending_followback', 'followed_back',
  'unfollow_queued', 'kept']);

/** The store as the check's port. */
export function storeFollowingFacts(store: Pick<KnowledgeStore, 'accountsWeFollow' | 'observe' | 'observeEdge'
  | 'getFollowRecord' | 'upsertFollowRecord'>, ownPk: string): FollowingFacts {
  const managedRecord = (pk: string) => {
    const rec = store.getFollowRecord(pk);
    return rec !== null && FOLLOWING_STATES.has(rec.state) ? rec : null;
  };
  return {
    activeFollowing: () => store.accountsWeFollow(),
    observeRow: (obs) => {
      store.observe(obs);
      store.observeEdge(ownPk, obs.accountPk, 'follows', true, obs.observedAt);
    },
    removeFollowing: (pk, at) => store.observeEdge(ownPk, pk, 'follows', false, at),
    managed: (pk) => managedRecord(pk) !== null,
    endManaged: (pk, at) => {
      const rec = managedRecord(pk);
      if (rec !== null) store.upsertFollowRecord({ ...rec, state: 'external', reconciledAt: at });
    },
  };
}

export interface FollowingCheckDeps {
  readonly walker: Pick<ListPageWalker, 'walkAll'>;
  readonly facts: FollowingFacts;
  readonly clock: { now(): number };
  readonly sentinel: Sentinel;
}

const FAILURES: ReadonlySet<string> = new Set(['read-budget', 'shape-mismatch', 'fetch-failed']);

/** Read the whole following list; verified-complete or a typed failure (facts kept either way). */
export async function checkFollowing(d: FollowingCheckDeps, a: { readonly ownPk: string; readonly signal: AbortSignal }):
  Promise<FollowingCheckResult> {
  const before = d.facts.activeFollowing();
  const seen = new Set<string>();
  let added = 0;
  const walk = await d.walker.walkAll({
    pk: a.ownPk, which: 'following', sentinel: d.sentinel, readUse: 'check',
    maxPages: BOUNDS_REENTRY.FOLLOWING_WALK_PAGES, shouldStop: () => a.signal.aborted,
    onObservation: (obs) => {
      if (!seen.has(obs.accountPk)) {
        seen.add(obs.accountPk);
        if (!before.has(obs.accountPk) && !d.facts.managed(obs.accountPk)) added += 1;
      }
      d.facts.observeRow(obs);
    },
  });
  const retry = walk.retryAt === undefined ? {} : { retryAt: walk.retryAt };
  if (walk.reason === 'stop-requested') return { ok: false, reason: 'stopped' };
  if (FAILURES.has(walk.reason)) return { ok: false, reason: walk.reason as 'read-budget', ...retry };
  if (walk.reason.startsWith('sentinel:')) return { ok: false, reason: walk.reason as `sentinel:${string}` };
  // Only a proven whole list with every row read may turn an absence into a verdict.
  if (!walk.complete || walk.quarantined > 0) {
    logger.warn('rim.following-check: the list did not read whole, no verdicts', { reason: walk.reason,
      pages: walk.pages, quarantined: walk.quarantined });
    return { ok: false, reason: 'incomplete' };
  }
  const at = d.clock.now();
  let removed = 0;
  for (const pk of before) {
    if (seen.has(pk)) continue;
    d.facts.removeFollowing(pk, at);
    d.facts.endManaged(pk, at);
    removed += 1;
  }
  logger.info('rim.following-check: the following list read whole', { count: seen.size, added, removed });
  return { ok: true, complete: true, count: seen.size, removed, added };
}
