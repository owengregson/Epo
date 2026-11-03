/**
 * The plan's store reads (spec §5.3): the demand snapshot a draw records, and the last write before
 * an instant that probation reads. Kernel values arrive as arguments; nothing here is a number of
 * its own.
 */

import { WEEKLY_CYCLE } from '@/kernel/derive-reentry';
import type { PlanDayWindow, PlanDemand } from '@/kernel/plan';
import { MS_PER_DAY } from '@/kernel/units';
import type { EffectiveSettings } from '@/settings/effective';
import type { KnowledgeStore } from '@/store/knowledge-store';
import type { FollowRecord } from '@/store/types';

/** The store slice the demand reads. */
export type DemandStore = Pick<KnowledgeStore, 'followRecordsByState' | 'tallySince' | 'pendingEffectIntents'
  | 'pruneScanRemainingCount' | 'getAccount' | 'getPruneCensus' | 'activeRequestPks'> & {
  readonly followRecords: Pick<KnowledgeStore['followRecords'], 'recheckDue'>;
  readonly growth: Pick<KnowledgeStore['growth'], 'outsideSince'>;
};

/** How many lifecycle unfollows are due by `t`: the queued ones and the timers that expire by then. */
function lifecycleDueBy(store: DemandStore, s: EffectiveSettings, t: number): number {
  const maxWait = s.maxWaitForFollowbackDays * MS_PER_DAY;
  const waited = (r: FollowRecord): boolean => r.followedAt !== undefined && r.followedAt + maxWait <= t;
  const held = (r: FollowRecord): boolean => r.holdUntil !== undefined && r.holdUntil <= t;
  return store.followRecordsByState('unfollow_queued').length
    + store.followRecordsByState('pending_followback').filter(waited).length
    + (s.rotateMutuals ? store.followRecordsByState('followed_back').filter(held).length : 0);
}

/**
 * The demand at `now` for the plan-day `window`: the kept records whose re-read falls in it, the outside
 * following actions charged to it (increases only), and the open follow requests into the account.
 */
export function planDemand(store: DemandStore, s: EffectiveSettings, ownPk: string, window: PlanDayWindow,
  now: number): PlanDemand {
  const own = store.getAccount(ownPk);
  const census = store.getPruneCensus();
  // A trailing week of plan-days, as whole days: an average, never a boundary.
  const weekAgo = window.startsAt - WEEKLY_CYCLE * MS_PER_DAY;
  return {
    lifecycleDueByDayEnd: lifecycleDueBy(store, s, window.endsAt),
    lifecycleBacklog: lifecycleDueBy(store, s, now),
    pruneStock: store.pruneScanRemainingCount(),
    protectedReeval: store.followRecords.recheckDue(window.endsAt).length,
    journalPending: store.pendingEffectIntents().length,
    followsDoneToday: store.tallySince(window.startsAt).follow,
    outsideToday: store.growth.outsideSince(window.startsAt),
    pendingRequests: store.activeRequestPks().length,
    acceptsRecent: (store.tallySince(weekAgo).accept - store.tallySince(window.startsAt).accept) / WEEKLY_CYCLE,
    ownHeader: { followers: own?.followers ?? null, following: own?.following ?? null },
    census: { lastCompleteAt: census?.at ?? null, rowsPerPage: null },
  };
}

/** The store slice the last-write read uses. */
export type LedgerTimes = Pick<KnowledgeStore, 'recentMutationTimes' | 'tallySince'>;

/** The last write before `t`: a day back first, then twice as far each time, until the ledger runs out. */
export function lastMutationBefore(store: LedgerTimes, t: number): number | null {
  for (let span = MS_PER_DAY; ; span += span) {
    const before = store.recentMutationTimes(t - span).filter((at) => at < t);
    if (before.length > 0) return before[before.length - 1];
    if (store.tallySince(t - span).all >= store.tallySince(0).all) return null;
  }
}
