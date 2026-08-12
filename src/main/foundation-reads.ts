/**
 * Pure read-shaping for the dashboard's list panels (§5).
 *
 * These functions turn raw `KnowledgeStore` reads into the exact renderer-facing
 * shapes (`ChainTargetView[]`, `QueueListResult`). They live apart from the
 * Electron-bound `Foundation` so they can be unit-tested against a plain fake store
 * — no browser, no SQLite, no login. Every call here is a STORE CALL (no SQL), so
 * the store's single-boundary rule is preserved.
 */

import type { AccountState, FollowRecord, FollowState, Target } from '@/store/types';
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
 * A capped page of the follow_records in `state`, each joined to its account for the
 * username/ratio/private badge the row shows. `truncated` is true when more records
 * exist than the cap returns (the UI notes it rather than silently dropping them).
 */
export function shapeQueueList(
  store: QueueReadStore,
  state: FollowState,
  cap: number = QUEUE_ROW_CAP,
): QueueListResult {
  const records = store.followRecordsByState(state);
  const truncated = records.length > cap;
  const rows: QueueRow[] = records.slice(0, cap).map((r) => {
    const acc = store.getAccount(r.accountPk);
    return {
      pk: r.accountPk,
      username: acc?.username ?? null,
      ratio: acc?.ratio ?? null,
      isPrivate: acc?.isPrivate ?? null,
      followedAt: r.followedAt,
      holdUntil: r.holdUntil,
      unfollowDueAt: r.unfollowDueAt,
    };
  });
  return { rows, truncated };
}
