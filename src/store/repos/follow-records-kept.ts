/**
 * The `kept` half of the follow-records repo (spec §7.5): protection moves applied in one
 * transaction, guarded by the state each leaves from, and the kept reads.
 */

import type { SqliteDriver } from '../driver/driver';
import { type FollowRecordRow, rowToFollowRecord } from '../rows';
import type { FollowRecord, KeptReason } from '../types';

/** Why a record is kept, the matched entry, when, its next read (null: none) and the unreadable count. */
export interface KeptStampRow {
  readonly reason: KeptReason; readonly match: string | null; readonly at: number;
  readonly recheckAt: number | null; readonly checks: number;
}

/** One protection move: into `kept`, back to the lifecycle, or back to the unfollow queue to re-read. */
export type KeptMove =
  | { readonly pk: string; readonly move: 'keep'; readonly stamp: KeptStampRow }
  | { readonly pk: string; readonly move: 'release'; readonly to: 'followed_back' | 'pending_followback' }
  | { readonly pk: string; readonly move: 'recheck' };

const KEPT_CLEARED = 'kept_reason = NULL, kept_match = NULL, kept_at = NULL, recheck_at = NULL';

/** Apply `moves` in one transaction; a record that moved on since it was read is left alone. Returns how many moved. */
export function reviewKept(db: SqliteDriver, moves: readonly KeptMove[]): number {
  const keep = db.prepare(
    `UPDATE follow_records SET state = 'kept', kept_reason = @reason, kept_match = @match, kept_at = @at,
       recheck_at = @recheck, check_failures = @checks
     WHERE account_pk = @pk AND state IN ('pending_followback', 'followed_back', 'unfollow_queued', 'kept')`,
  );
  const release = db.prepare(
    `UPDATE follow_records SET state = @to, ${KEPT_CLEARED}, check_failures = 0, reconciled_at = NULL
     WHERE account_pk = @pk AND state = 'kept'`,
  );
  const recheck = db.prepare(
    `UPDATE follow_records SET state = 'unfollow_queued', ${KEPT_CLEARED} WHERE account_pk = @pk AND state = 'kept'`,
  );
  let moved = 0;
  db.transaction(() => {
    for (const m of moves) {
      const run = m.move === 'keep'
        ? keep.run({ pk: m.pk, reason: m.stamp.reason, match: m.stamp.match, at: m.stamp.at,
          recheck: m.stamp.recheckAt, checks: m.stamp.checks })
        : m.move === 'release' ? release.run({ pk: m.pk, to: m.to }) : recheck.run({ pk: m.pk });
      moved += Number(run.changes);
    }
  });
  return moved;
}

/** One page of kept records, the most recently kept first. */
export function keptPage(db: SqliteDriver, page: number, size: number): FollowRecord[] {
  return (
    db.prepare(`SELECT * FROM follow_records WHERE state = 'kept'
      ORDER BY kept_at DESC, account_pk LIMIT @size OFFSET @offset`)
      .all({ size, offset: page * size }) as FollowRecordRow[]
  ).map(rowToFollowRecord);
}

/** How many records are kept, and how many of them for an unreadable fact. */
export function keptCounts(db: SqliteDriver): { total: number; unreadable: number } {
  const row = db.prepare(`SELECT COUNT(*) AS total,
    COALESCE(SUM(CASE WHEN kept_reason LIKE 'unreadable-%' THEN 1 ELSE 0 END), 0) AS unreadable
    FROM follow_records WHERE state = 'kept'`).get() as { total: number; unreadable: number };
  return { total: Number(row.total), unreadable: Number(row.unreadable) };
}

/** Kept records whose re-check is due at `now`. */
export function recheckDue(db: SqliteDriver, now: number): FollowRecord[] {
  return (
    db.prepare(`SELECT * FROM follow_records
      WHERE state = 'kept' AND recheck_at IS NOT NULL AND recheck_at <= ? ORDER BY recheck_at, account_pk`)
      .all(now) as FollowRecordRow[]
  ).map(rowToFollowRecord);
}
