/**
 * Pure read-shaping for the dashboard's list panels (§5).
 *
 * These functions turn raw `KnowledgeStore` reads into the exact renderer-facing
 * shapes (`ChainTargetView[]`, `QueueListResult`). They live apart from the
 * Electron-bound `Foundation` so they can be unit-tested against a plain fake store
 * — no browser, no SQLite, no login. Every call here is a STORE CALL (no SQL), so
 * the store's single-boundary rule is preserved.
 */

import {
  type AccountState,
  type FollowRecord,
  type FollowState,
  type Target,
  compareByScoreDesc,
} from '@/store/types';
import type {
  ChainTargetView,
  QueueListResult,
  QueueRow,
  TargetYield,
} from '@/types';

/** The narrow slice of `KnowledgeStore` the chain projection reads. */
export interface ChainReadStore {
  listTargets(): Target[];
  getAccount(pk: string): AccountState | null;
  targetYield(targetPk: string, ownPk: string): TargetYield;
}

/** The narrow slice of `KnowledgeStore` the queue projection reads. */
export interface QueueReadStore {
  followRecordsByState(state: FollowState): FollowRecord[];
  getAccount(pk: string): AccountState | null;
}

/** Default cap on rows returned per queue tab (the rest are flagged truncated). */
export const QUEUE_ROW_CAP = 100;

/**
 * Every chain target, in the store's chain order, each augmented with its account
 * username and its on-demand yield (follow-back rate, pool size, overlap).
 */
export function shapeChainList(store: ChainReadStore, ownPk: string): ChainTargetView[] {
  return store.listTargets().map((t) => ({
    ...t,
    username: store.getAccount(t.accountPk)?.username ?? null,
    yield: store.targetYield(t.accountPk, ownPk),
  }));
}

/**
 * Order a queue's records the way the pipeline actually processes them, so the
 * DISPLAY matches reality:
 *  - `queued`             → best candidate first (Scorer's composite `score`),
 *                           the same ranking `nextDue` follows to pick the next
 *                           account to act on (shared {@link compareByScoreDesc}).
 *  - `pending_followback` → oldest follow first (closest to the follow-back timeout).
 *  - `followed_back`      → nearest hold expiry first.
 *  - `unfollow_queued`    → nearest due first (how `nextDue` reclaims slots).
 * Any other/terminal state keeps its natural order.
 *
 * Ordering runs over the WHOLE record set BEFORE the cap, so the capped page is
 * genuinely the top-N — never an arbitrary DB-order slice that then hides the
 * best candidates behind the truncation note.
 */
function orderedForDisplay(records: FollowRecord[], state: FollowState): FollowRecord[] {
  const byTimeAsc = (key: keyof FollowRecord) =>
    [...records].sort((a, b) => ((a[key] as number) ?? 0) - ((b[key] as number) ?? 0));
  switch (state) {
    case 'queued':
      return [...records].sort(compareByScoreDesc);
    case 'pending_followback':
      return byTimeAsc('followedAt');
    case 'followed_back':
      return byTimeAsc('holdUntil');
    case 'unfollow_queued':
      return byTimeAsc('unfollowDueAt');
    default:
      return records;
  }
}

/**
 * A capped page of the follow_records in `state`, each joined to its account for the
 * username/ratio/mutuals/private badge the row shows. Records are ORDERED (see
 * {@link orderedForDisplay}) before the cap, so the page is the top-N. `truncated`
 * is true when more records exist than the cap returns (the UI notes it rather than
 * silently dropping them).
 */
export function shapeQueueList(
  store: QueueReadStore,
  state: FollowState,
  cap: number = QUEUE_ROW_CAP,
): QueueListResult {
  const records = orderedForDisplay(store.followRecordsByState(state), state);
  const truncated = records.length > cap;
  const rows: QueueRow[] = records.slice(0, cap).map((r) => {
    const acc = store.getAccount(r.accountPk);
    return {
      pk: r.accountPk,
      username: acc?.username ?? null,
      ratio: acc?.ratio ?? null,
      isPrivate: acc?.isPrivate ?? null,
      mutuals: acc?.mutuals ?? null,
      score: r.score ?? null,
      followedAt: r.followedAt,
      holdUntil: r.holdUntil,
      unfollowDueAt: r.unfollowDueAt,
    };
  });
  return { rows, truncated };
}
