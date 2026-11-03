import type { SqliteDriver } from '../driver/driver';
import { type FollowRecordRow, rowToFollowRecord } from '../rows';
import { orNull } from '../sql-values';
import type { FollowRecord, FollowState } from '../types';
import { type KeptMove, keptCounts, keptPage, recheckDue, reviewKept } from './follow-records-kept';

export type { KeptMove, KeptStampRow } from './follow-records-kept';

/** What one call to {@link FollowRecordRepo.healAbandonedInWindow} did. */
export interface HealResult {
  healed: number;
  toQueued: number;
  toUnfollowQueued: number;
  skippedUnworkable: number;
}

/** States a record has left for good; nothing works them again. */
const TERMINAL = `('unfollowed', 'abandoned', 'external')`;

/**
 * The churn lifecycle table: one row per account the growth engine has taken
 * responsibility for, from `queued` through to a terminal state.
 */
export class FollowRecordRepo {
  constructor(
    private readonly db: SqliteDriver,
    private readonly changed: () => void,
  ) {}

  /** Insert or fully replace a record, keyed on account_pk. */
  upsert(rec: FollowRecord): void {
    this.db.transaction(() => {
      const r = rec;
      this.db
        .prepare(
          `INSERT INTO follow_records (
             account_pk, target_pk, state, followed_at, followed_back_at,
             hold_until, unfollow_due_at, retry_count, score, abandoned_at, healed_at,
             reconciled_at, followback_observed_at, unfollow_reason, queued_at, decision_version,
             kept_reason, kept_match, kept_at, recheck_at, park_reason, check_failures, followback_after
           ) VALUES (
             @account_pk, @target_pk, @state, @followed_at, @followed_back_at,
             @hold_until, @unfollow_due_at, @retry_count, @score, @abandoned_at, @healed_at,
             @reconciled_at, @followback_observed_at, @unfollow_reason, @queued_at, @decision_version,
             @kept_reason, @kept_match, @kept_at, @recheck_at, @park_reason,
             COALESCE(@check_failures, 0), @followback_after
           )
           ON CONFLICT(account_pk) DO UPDATE SET
             target_pk = excluded.target_pk,
             state = excluded.state,
             followed_at = excluded.followed_at,
             followed_back_at = excluded.followed_back_at,
             hold_until = excluded.hold_until,
             unfollow_due_at = excluded.unfollow_due_at,
             retry_count = excluded.retry_count,
             -- COALESCE, not assignment: score and the two history stamps are
             -- facts a PARTIAL upsert must never erase. A re-abandonment writes
             -- a fresh non-null abandoned_at and wins; healed_at is written once
             -- (by the healer) and never cleared — the never-heal-twice marker.
             score = COALESCE(excluded.score, follow_records.score),
             abandoned_at = COALESCE(excluded.abandoned_at, follow_records.abandoned_at),
             healed_at = COALESCE(excluded.healed_at, follow_records.healed_at),
             reconciled_at = excluded.reconciled_at,
             followback_observed_at = excluded.followback_observed_at,
             unfollow_reason = excluded.unfollow_reason,
             queued_at = COALESCE(excluded.queued_at, follow_records.queued_at),
             decision_version = excluded.decision_version,
             kept_reason = excluded.kept_reason,
             kept_match = excluded.kept_match,
             kept_at = excluded.kept_at,
             recheck_at = excluded.recheck_at,
             park_reason = excluded.park_reason,
             -- A write that does not state the count keeps the stored one.
             check_failures = COALESCE(@check_failures, follow_records.check_failures),
             followback_after = excluded.followback_after`,
        )
        .run({
          account_pk: r.accountPk,
          target_pk: orNull(r.targetPk),
          state: r.state,
          followed_at: orNull(r.followedAt),
          followed_back_at: orNull(r.followedBackAt),
          hold_until: orNull(r.holdUntil),
          unfollow_due_at: orNull(r.unfollowDueAt),
          retry_count: r.retryCount,
          score: orNull(r.score),
          abandoned_at: orNull(r.abandonedAt),
          healed_at: orNull(r.healedAt),
          reconciled_at: orNull(r.reconciledAt),
          followback_observed_at: orNull(r.followbackObservedAt),
          unfollow_reason: orNull(r.unfollowReason),
          queued_at: orNull(r.queuedAt),
          decision_version: orNull(r.decisionVersion),
          kept_reason: orNull(r.keptReason),
          kept_match: orNull(r.keptMatch),
          kept_at: orNull(r.keptAt),
          recheck_at: orNull(r.recheckAt),
          park_reason: orNull(r.parkReason),
          check_failures: orNull(r.checkFailures),
          followback_after: orNull(r.followbackAfter),
        });
    });
    this.changed();
  }

  get(accountPk: string): FollowRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM follow_records WHERE account_pk = ?`)
      .get(accountPk) as FollowRecordRow | undefined;
    return row ? rowToFollowRecord(row) : null;
  }

  byState(state: FollowState): FollowRecord[] {
    return (
      this.db.prepare(`SELECT * FROM follow_records WHERE state = ?`).all(state) as
        FollowRecordRow[]
    ).map(rowToFollowRecord);
  }

  /** Every record not yet in a terminal state. */
  active(): FollowRecord[] {
    return (
      this.db
        .prepare(`SELECT * FROM follow_records WHERE state NOT IN ${TERMINAL}`)
        .all() as FollowRecordRow[]
    ).map(rowToFollowRecord);
  }

  /** All account_pks that already have a record (for candidate exclusion). */
  pks(): Set<string> {
    const rows = this.db.prepare(`SELECT account_pk FROM follow_records`).all() as Array<{
      account_pk: string;
    }>;
    return new Set(rows.map((r) => r.account_pk));
  }

  /**
   * account_pks the growth engine is ACTIVELY managing (queued, awaiting a
   * follow-back, held after one, or queued for its own unfollow). Prune
   * excludes these so the two systems never fight over one account. Terminal
   * rows are excluded, so an account the user later re-follows by hand is fair
   * game again.
   */
  activePks(): Set<string> {
    const rows = this.db
      .prepare(`SELECT account_pk FROM follow_records WHERE state NOT IN ${TERMINAL}`)
      .all() as Array<{ account_pk: string }>;
    return new Set(rows.map((r) => r.account_pk));
  }

  /** Apply protection moves in ONE transaction and one mutation pulse (spec §7.5); returns how many moved. */
  review(moves: readonly KeptMove[]): number {
    const moved = moves.length === 0 ? 0 : reviewKept(this.db, moves);
    if (moved > 0) this.changed();
    return moved;
  }

  /** One page of kept records, the most recently kept first. */
  kept(page: number, size: number): FollowRecord[] { return keptPage(this.db, page, size); }

  /** How many records are kept, and how many of them for an unreadable fact. */
  keptCounts(): { total: number; unreadable: number } { return keptCounts(this.db); }

  /** Kept records whose re-check is due at `now`. */
  recheckDue(now: number): FollowRecord[] { return recheckDue(this.db, now); }

  /**
   * The recovery requeue-healer's store half: requeue `abandoned` records whose
   * abandonment fell inside a CLOSED systemic-incident window
   * [`windowStartMs`, `windowEndMs`] — the engine calls this exactly once per
   * ladder reset, the proof moment that the window's failures were
   * systemic-and-over and the retries those records burned were spurious.
   *
   * The abandonment-time signal, in honesty order:
   *  1. `abandoned_at` — the stamped transition (churn scheduler, migration 11).
   *  2. Rows abandoned before the stamp shipped fall back to the record's last
   *     `fail` action-ledger row: the abandoning transition writes its fail row
   *     at the same instant, so the latest fail is the nearest recorded fact.
   *  3. Neither exists → the record CANNOT be honestly placed in the window and
   *     stays abandoned (absence of evidence is never evidence).
   *
   * A heal resets `retry_count` and returns the record to where the burn
   * interrupted the lifecycle — `queued` when it was never followed,
   * `unfollow_queued` when the abandonment ate the unfollow leg of an
   * already-followed record (requeueing THOSE as 'queued' would re-follow an
   * account we already follow). `healed_at` is stamped so a record heals
   * exactly ONCE. Nothing else is rewritten: the incident's fail ledger rows
   * stay as recorded — the heal is a new fact, not a revision of history.
   *
   * Left abandoned: records already healed, records outside the window, and
   * records whose target is no longer 'active' (nothing would ever work them),
   * the latter counted in `skippedUnworkable`. Records with NO target are
   * workable (the churn queue is target-agnostic). `cap` bounds the batch,
   * best-scored first; a window claiming more than the cap is pathological and
   * the remainder stays put.
   */
  healAbandonedInWindow(opts: {
    windowStartMs: number;
    windowEndMs: number;
    cap: number;
    now: number;
  }): HealResult {
    const abandonedAtSignal = `COALESCE(
      fr.abandoned_at,
      (SELECT MAX(al.at) FROM action_ledger al
        WHERE al.account_pk = fr.account_pk AND al.result = 'fail')
    )`;
    const inWindow = `fr.state = 'abandoned'
      AND fr.healed_at IS NULL
      AND ${abandonedAtSignal} BETWEEN @start AND @end`;
    const targetWorkable = `(fr.followed_at IS NOT NULL OR fr.target_pk IS NULL OR EXISTS (
      SELECT 1 FROM targets t
      WHERE t.account_pk = fr.target_pk AND t.status = 'active'))`;

    let result: HealResult = { healed: 0, toQueued: 0, toUnfollowQueued: 0, skippedUnworkable: 0 };
    this.db.transaction(() => {
      const args = { start: opts.windowStartMs, end: opts.windowEndMs };
      const skippedUnworkable = (
        this.db
          .prepare(
            `SELECT COUNT(*) AS c FROM follow_records fr
             WHERE ${inWindow} AND NOT ${targetWorkable}`,
          )
          .get(args) as { c: number }
      ).c;
      const rows = this.db
        .prepare(
          `SELECT fr.account_pk, fr.followed_at FROM follow_records fr
           WHERE ${inWindow} AND ${targetWorkable}
           ORDER BY fr.score DESC, fr.account_pk
           LIMIT @cap`,
        )
        .all({ ...args, cap: opts.cap }) as Array<{
        account_pk: string;
        followed_at: number | null;
      }>;
      const heal = this.db.prepare(
        `UPDATE follow_records
         SET state = @state, retry_count = 0, healed_at = @now
         WHERE account_pk = @pk`,
      );
      let toQueued = 0;
      let toUnfollowQueued = 0;
      for (const row of rows) {
        const state: FollowState = row.followed_at === null ? 'queued' : 'unfollow_queued';
        heal.run({ pk: row.account_pk, state, now: opts.now });
        if (state === 'queued') toQueued += 1;
        else toUnfollowQueued += 1;
      }
      result = { healed: rows.length, toQueued, toUnfollowQueued, skippedUnworkable };
    });
    if (result.healed > 0) this.changed();
    return result;
  }
}
