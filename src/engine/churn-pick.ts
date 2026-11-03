/**
 * Which churn record acts next: the due ranking (reclaimed slots before new follows, the best
 * score first) and the gates every pick honours — no head-of-line (spec §9.8–9.9): a parked, a
 * journal-blocked or a requesting record is passed over, never waited on.
 */

import type { KnowledgeStore } from '../store/knowledge-store';
import { compareByScoreDesc, type FollowRecord } from '../store/types';
import type { ChurnConfig, ChurnDeps } from './churn-types';
import { journalBlocks } from './journal';

/** What the pick reads; the config is read live. */
export interface ChurnPickDeps {
  store: KnowledgeStore;
  ownPk?: string;
  cfg(): ChurnConfig;
  pickQueued?: ChurnDeps['pickQueued'];
  /** Whether `pk` has asked to follow us and the request is open (a live predicate, spec §9.9). */
  hasActiveRequest(pk: string): boolean;
  /** True while protection is paused for a review: no unfollow is offered, follows continue (spec §7.6). */
  unfollowsPaused(): boolean;
  reviewBound?: ChurnDeps['reviewBound'];
}

/** Due unfollows: the earliest `unfollowDueAt` first, then `accountPk` (deterministic). */
export function byUnfollowDue(a: FollowRecord, b: FollowRecord): number {
  const da = a.unfollowDueAt ?? 0;
  const db = b.unfollowDueAt ?? 0;
  if (da !== db) return da - db;
  return a.accountPk < b.accountPk ? -1 : a.accountPk > b.accountPk ? 1 : 0;
}

export class ChurnPick {
  private readonly store: KnowledgeStore;
  private readonly pickQueued?: ChurnDeps['pickQueued'];

  constructor(private readonly deps: ChurnPickDeps) {
    this.store = deps.store;
    this.pickQueued = deps.pickQueued;
  }

  /**
   * The most-due record, or null: reclaimed slots first (by `unfollowDueAt`), then the best-scored follow;
   * never one parked ahead, one with its own write unsettled, or a retained or requesting unfollow.
   */
  nextDue(now: number, kind?: 'follow' | 'unfollow'): FollowRecord | null {
    const unsettled = this.store.effectIntents.pending();
    // Neither parked until later nor blocked by its own unsettled write.
    const open = (r: FollowRecord): boolean => (r.recheckAt ?? now) <= now && !journalBlocks(r.accountPk, unsettled);
    const queued = kind === 'unfollow' ? [] : this.store.followRecordsByState('queued').filter((r) => r.score !== 0 && open(r));
    const chosenFollow = this.pickQueued ? this.pickQueued(queued) : queued.sort(compareByScoreDesc)[0] ?? null;
    if (kind === 'follow') return chosenFollow;
    const unfollows = !this.unfollowsOffered(now) ? [] : this.store.followRecordsByState('unfollow_queued')
      .filter((r) => open(r) && !this.isRetained(r.accountPk) && !this.isRequester(r.accountPk));
    // A reclaimed slot comes first; the plan's mix decides between the kinds (spec §5.7).
    if (unfollows.length > 0) {
      return unfollows.sort(byUnfollowDue)[0];
    }
    return kind === 'unfollow' ? null : chosenFollow;
  }

  /**
   * No unfollow is offered while protection is paused, or once this session's reviews that pressed
   * nothing reach its planned unfollows (spec §9.7); follows continue.
   */
  private unfollowsOffered(now: number): boolean {
    if (this.deps.unfollowsPaused()) return false;
    const bound = this.deps.reviewBound?.(now) ?? null;
    return bound === null || this.store.effectIntents.nonDispatchReviewsSince(bound.since) < bound.planned;
  }

  isRetained(pk: string): boolean {
    return this.store.getTarget(pk)?.status === 'retained'
      || this.store.getAccount(pk)?.role === 'retained_target';
  }

  /** Whether `pk` has an open request to follow us: never queued, never selected, never written. */
  isRequester(pk: string): boolean {
    return this.deps.hasActiveRequest(pk);
  }
}
