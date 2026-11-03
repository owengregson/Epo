/**
 * Which churn record acts next: the due ranking (reclaimed slots before new
 * follows, the best score first) and the two gates every unfollow pick honours.
 */

import type { KnowledgeStore } from '../store/knowledge-store';
import { compareByScoreDesc, type FollowRecord } from '../store/types';
import { MS_PER_DAY } from '../timing/units';
import type { ChurnConfig, ChurnDeps } from './churn-types';

/** What the pick reads; the config and the cleanup streak are read live. */
export interface ChurnPickDeps {
  store: KnowledgeStore;
  ownPk?: string;
  cfg(): ChurnConfig;
  /** Consecutive verified unfollows since the last verified follow. */
  consecutiveCleanup(): number;
  pickQueued?: ChurnDeps['pickQueued'];
  /** Whether `pk` has a follow request in flight (the requester seam); false until wired. */
  hasActiveRequest(pk: string): boolean;
  /** True while protection is paused for a review: no unfollow is offered, follows continue (spec §7.6). */
  unfollowsPaused(): boolean;
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
  private readonly ownPk?: string;
  private readonly pickQueued?: ChurnDeps['pickQueued'];

  constructor(private readonly deps: ChurnPickDeps) {
    this.store = deps.store;
    this.ownPk = deps.ownPk;
    this.pickQueued = deps.pickQueued;
  }

  /** The live churn config (swapped by `ChurnScheduler.applyConfig`). */
  private get cfg(): ChurnConfig {
    return this.deps.cfg();
  }

  private get consecutiveCleanup(): number {
    return this.deps.consecutiveCleanup();
  }

  /**
   * Return the single most-due record needing Instagram traffic, or `null` if none.
   *
   * Ordering: reclaimed slots first — `unfollow_queued` records are preferred
   * over `queued`, so we free capacity before spending it on new follows. Within
   * `unfollow_queued`, order by `unfollowDueAt` ascending then `accountPk`. Among
   * `queued` records the BEST candidate goes first: descending `score` (the
   * Scorer's composite — ratio, mutuals, private boost), with `accountPk` only as
   * a deterministic tie-break. A record without a score (not Scanner-created)
   * sorts last. This method does NOT check the ceiling/active-hours (the Engine
   * gates before calling) and does NOT act. `kind` narrows the pick to one verb;
   * undefined keeps the precedence above.
   */
  nextDue(now: number, kind?: 'follow' | 'unfollow'): FollowRecord | null {
    const queued = kind === 'unfollow' ? [] : this.store.followRecordsByState('queued').filter((r) => r.score !== 0);
    const chosenFollow = this.pickQueued ? this.pickQueued(queued) : queued.sort(compareByScoreDesc)[0] ?? null;
    if (kind === 'follow') return chosenFollow;
    const unfollows = this.deps.unfollowsPaused() ? [] : this.store.followRecordsByState('unfollow_queued')
      .filter((r) => !this.isRetained(r.accountPk) && this.fresh(r, now));
    if (unfollows.length > 0 && (kind === 'unfollow' || this.consecutiveCleanup < 2 || chosenFollow === null)) {
      return unfollows.sort(byUnfollowDue)[0];
    }
    return kind === 'unfollow' ? null : chosenFollow;
  }

  fresh(rec: FollowRecord, now: number): boolean {
    if (this.ownPk === undefined) return true;
    return rec.reconciledAt !== undefined && rec.reconciledAt <= now
      && now - rec.reconciledAt <= (this.cfg.relationshipFreshMs ?? MS_PER_DAY);
  }

  isRetained(pk: string): boolean {
    return this.store.getTarget(pk)?.status === 'retained'
      || this.store.getAccount(pk)?.role === 'retained_target';
  }
}
