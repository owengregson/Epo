import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import {
  AccountState,
  Edge,
  EdgeType,
  EnrichmentLevel,
  FollowRecord,
  FollowState,
  Observation,
  Source,
  SOURCE_CONFIDENCE,
  Target,
} from './types';
import { projectAccount } from './projections';
import { runMigrations } from './migrations';

interface AccountRow {
  pk: string;
  username: string | null;
  enrichment: string;
  followers: number | null;
  following: number | null;
  ratio: number | null;
  is_private: number | null;
  is_verified: number | null;
  activity_signal: number | null;
  role: string | null;
  stats_observed_at: number | null;
  stats_source: string | null;
  first_seen_at: number;
  last_seen_at: number;
}

interface EdgeRow {
  src_pk: string;
  dst_pk: string;
  type: string;
  first_seen_at: number;
  last_confirmed_at: number;
  status: string;
}

interface FollowRecordRow {
  account_pk: string;
  target_pk: string | null;
  state: string;
  followed_at: number | null;
  followed_back_at: number | null;
  hold_until: number | null;
  unfollow_due_at: number | null;
  retry_count: number;
}

interface TargetRow {
  account_pk: string;
  source: string;
  status: string;
  chain_index: number | null;
}

const boolOrUndef = (v: number | null): boolean | undefined =>
  v === null ? undefined : v !== 0;
const numOrUndef = (v: number | null): number | undefined => (v === null ? undefined : v);
const strOrUndef = (v: string | null): string | undefined => (v === null ? undefined : v);
const boolToInt = (v: boolean | undefined): number | null =>
  v === undefined ? null : v ? 1 : 0;
const orNull = <T>(v: T | undefined): T | null => (v === undefined ? null : v);

const rowToState = (row: AccountRow): AccountState => ({
  pk: row.pk,
  username: strOrUndef(row.username),
  enrichment: row.enrichment as EnrichmentLevel,
  followers: numOrUndef(row.followers),
  following: numOrUndef(row.following),
  ratio: numOrUndef(row.ratio),
  isPrivate: boolOrUndef(row.is_private),
  isVerified: boolOrUndef(row.is_verified),
  activitySignal: numOrUndef(row.activity_signal),
  role: strOrUndef(row.role),
  statsObservedAt: numOrUndef(row.stats_observed_at),
  statsSource: strOrUndef(row.stats_source) as Source | undefined,
  firstSeenAt: row.first_seen_at,
  lastSeenAt: row.last_seen_at,
});

const rowToEdge = (row: EdgeRow): Edge => ({
  srcPk: row.src_pk,
  dstPk: row.dst_pk,
  type: row.type as EdgeType,
  firstSeenAt: row.first_seen_at,
  lastConfirmedAt: row.last_confirmed_at,
  status: row.status as 'active' | 'removed',
});

const rowToTarget = (row: TargetRow): Target => ({
  accountPk: row.account_pk,
  source: row.source as Target['source'],
  status: row.status as Target['status'],
  chainIndex: row.chain_index,
});

const rowToFollowRecord = (row: FollowRecordRow): FollowRecord => ({
  accountPk: row.account_pk,
  targetPk: row.target_pk,
  state: row.state as FollowState,
  followedAt: numOrUndef(row.followed_at),
  followedBackAt: numOrUndef(row.followed_back_at),
  holdUntil: numOrUndef(row.hold_until),
  unfollowDueAt: numOrUndef(row.unfollow_due_at),
  retryCount: row.retry_count,
});

/**
 * The sole boundary to the SQLite knowledge graph. This is the ONLY module permitted
 * to import `better-sqlite3` or contain SQL. Every write funnels through `observe`/
 * `observeEdge`/`recordAction`/`recordRequest`; every read through the typed queries.
 */
export class KnowledgeStore {
  private readonly db: BetterSqlite3.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    runMigrations(this.db);
  }

  /**
   * Append an observation and re-project the account row in the same transaction —
   * the single write path that keeps the event log and projection consistent.
   */
  observe(obs: Observation): void {
    const tx = this.db.transaction((o: Observation) => {
      this.db
        .prepare(
          `INSERT INTO observations (account_pk, observed_at, source, confidence, field_set)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(o.accountPk, o.observedAt, o.source, SOURCE_CONFIDENCE[o.source], JSON.stringify(o.fields));

      const existing = this.getAccount(o.accountPk);
      const next = projectAccount(existing, o);

      this.db
        .prepare(
          `INSERT INTO accounts (
             pk, username, enrichment, followers, following, ratio,
             is_private, is_verified, activity_signal,
             stats_observed_at, stats_source, first_seen_at, last_seen_at
           ) VALUES (
             @pk, @username, @enrichment, @followers, @following, @ratio,
             @is_private, @is_verified, @activity_signal,
             @stats_observed_at, @stats_source, @first_seen_at, @last_seen_at
           )
           ON CONFLICT(pk) DO UPDATE SET
             username = excluded.username,
             enrichment = excluded.enrichment,
             followers = excluded.followers,
             following = excluded.following,
             ratio = excluded.ratio,
             is_private = excluded.is_private,
             is_verified = excluded.is_verified,
             activity_signal = excluded.activity_signal,
             stats_observed_at = excluded.stats_observed_at,
             stats_source = excluded.stats_source,
             first_seen_at = excluded.first_seen_at,
             last_seen_at = excluded.last_seen_at`,
        )
        .run({
          pk: next.pk,
          username: orNull(next.username),
          enrichment: next.enrichment,
          followers: orNull(next.followers),
          following: orNull(next.following),
          ratio: orNull(next.ratio),
          is_private: boolToInt(next.isPrivate),
          is_verified: boolToInt(next.isVerified),
          activity_signal: orNull(next.activitySignal),
          stats_observed_at: orNull(next.statsObservedAt),
          stats_source: orNull(next.statsSource),
          first_seen_at: next.firstSeenAt,
          last_seen_at: next.lastSeenAt,
        });

      if (o.fields.username !== undefined) {
        this.db
          .prepare(`INSERT INTO username_history (pk, username, seen_at) VALUES (?, ?, ?)`)
          .run(o.accountPk, o.fields.username, o.observedAt);
      }
    });
    tx(obs);
  }

  /** Upsert a directed edge, dating first/last seen and its active/removed status. */
  observeEdge(srcPk: string, dstPk: string, type: EdgeType, active: boolean, at: number): void {
    const status = active ? 'active' : 'removed';
    this.db
      .prepare(
        `INSERT INTO edges (src_pk, dst_pk, type, first_seen_at, last_confirmed_at, status)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(src_pk, dst_pk, type) DO UPDATE SET
           last_confirmed_at = excluded.last_confirmed_at,
           status = excluded.status,
           first_seen_at = MIN(edges.first_seen_at, excluded.first_seen_at)`,
      )
      .run(srcPk, dstPk, type, at, at, status);
  }

  getAccount(pk: string): AccountState | null {
    const row = this.db.prepare(`SELECT * FROM accounts WHERE pk = ?`).get(pk) as
      | AccountRow
      | undefined;
    return row ? rowToState(row) : null;
  }

  getEdge(srcPk: string, dstPk: string, type: EdgeType): Edge | null {
    const row = this.db
      .prepare(`SELECT * FROM edges WHERE src_pk = ? AND dst_pk = ? AND type = ?`)
      .get(srcPk, dstPk, type) as EdgeRow | undefined;
    return row ? rowToEdge(row) : null;
  }

  recordAction(
    accountPk: string,
    action: 'follow' | 'unfollow',
    result: 'ok' | 'fail',
    at: number,
  ): void {
    this.db
      .prepare(`INSERT INTO action_ledger (account_pk, action, at, result) VALUES (?, ?, ?, ?)`)
      .run(accountPk, action, at, result);
  }

  actionCountSince(sinceMs: number): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM action_ledger WHERE at >= ?`)
      .get(sinceMs) as { c: number };
    return row.c;
  }

  recordRequest(at: number): void {
    this.db.prepare(`INSERT INTO request_log (at) VALUES (?)`).run(at);
  }

  requestCountSince(sinceMs: number): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM request_log WHERE at >= ?`)
      .get(sinceMs) as { c: number };
    return row.c;
  }

  // --- Churn lifecycle: follow_records (§3.4) ------------------------------------

  /** Insert or fully replace a churn-lifecycle record, keyed on account_pk. */
  upsertFollowRecord(rec: FollowRecord): void {
    const tx = this.db.transaction((r: FollowRecord) => {
      this.db
        .prepare(
          `INSERT INTO follow_records (
             account_pk, target_pk, state, followed_at, followed_back_at,
             hold_until, unfollow_due_at, retry_count
           ) VALUES (
             @account_pk, @target_pk, @state, @followed_at, @followed_back_at,
             @hold_until, @unfollow_due_at, @retry_count
           )
           ON CONFLICT(account_pk) DO UPDATE SET
             target_pk = excluded.target_pk,
             state = excluded.state,
             followed_at = excluded.followed_at,
             followed_back_at = excluded.followed_back_at,
             hold_until = excluded.hold_until,
             unfollow_due_at = excluded.unfollow_due_at,
             retry_count = excluded.retry_count`,
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
        });
    });
    tx(rec);
  }

  getFollowRecord(accountPk: string): FollowRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM follow_records WHERE account_pk = ?`)
      .get(accountPk) as FollowRecordRow | undefined;
    return row ? rowToFollowRecord(row) : null;
  }

  followRecordsByState(state: FollowState): FollowRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM follow_records WHERE state = ?`)
      .all(state) as FollowRecordRow[];
    return rows.map(rowToFollowRecord);
  }

  /** Every follow_record not yet in a terminal state. */
  activeFollowRecords(): FollowRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM follow_records WHERE state NOT IN ('unfollowed', 'abandoned')`)
      .all() as FollowRecordRow[];
    return rows.map(rowToFollowRecord);
  }

  /** All account_pks that already have a follow_record (for candidate exclusion). */
  followRecordPks(): Set<string> {
    const rows = this.db
      .prepare(`SELECT account_pk FROM follow_records`)
      .all() as Array<{ account_pk: string }>;
    return new Set(rows.map((r) => r.account_pk));
  }

  /** src_pk of active `follows` edges pointing at the target (accounts that follow it). */
  followersOf(targetPk: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT src_pk FROM edges
         WHERE dst_pk = ? AND type = 'follows' AND status = 'active'`,
      )
      .all(targetPk) as Array<{ src_pk: string }>;
    return rows.map((r) => r.src_pk);
  }

  /**
   * Raw candidate pool for poaching a target: its active followers MINUS accounts
   * already in a follow_record MINUS the target itself. The Scorer ranks these.
   */
  candidatePksForTarget(targetPk: string): string[] {
    const excluded = this.followRecordPks();
    return this.followersOf(targetPk).filter(
      (pk) => pk !== targetPk && !excluded.has(pk),
    );
  }

  // --- Chain targets: targets table (§3.5) ---------------------------------------

  /** Insert or replace a chain target, keyed on account_pk. */
  addTarget(t: Target): void {
    this.db
      .prepare(
        `INSERT INTO targets (account_pk, source, status, chain_index)
         VALUES (@account_pk, @source, @status, @chain_index)
         ON CONFLICT(account_pk) DO UPDATE SET
           source = excluded.source,
           status = excluded.status,
           chain_index = excluded.chain_index`,
      )
      .run({
        account_pk: t.accountPk,
        source: t.source,
        status: t.status,
        chain_index: orNull(t.chainIndex ?? undefined),
      });
  }

  getTarget(accountPk: string): Target | null {
    const row = this.db
      .prepare(`SELECT * FROM targets WHERE account_pk = ?`)
      .get(accountPk) as TargetRow | undefined;
    return row ? rowToTarget(row) : null;
  }

  setTargetStatus(accountPk: string, status: Target['status']): void {
    this.db.prepare(`UPDATE targets SET status = ? WHERE account_pk = ?`).run(status, accountPk);
  }

  /** All chain targets ordered by chain_index (nulls last), then account_pk. */
  listTargets(): Target[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM targets
         ORDER BY chain_index IS NULL, chain_index ASC, account_pk ASC`,
      )
      .all() as TargetRow[];
    return rows.map(rowToTarget);
  }

  /** The next chain position: `(MAX(chain_index) ?? -1) + 1`. */
  nextChainIndex(): number {
    const row = this.db
      .prepare(`SELECT MAX(chain_index) AS m FROM targets`)
      .get() as { m: number | null };
    return (row.m ?? -1) + 1;
  }

  /**
   * Yield statistics for a poaching session against `targetPk` (§3.5), computed on
   * demand from follow_records + edges — the "analysis is an emergent query" principle.
   *
   * - `total`: follow_records aimed at the target that reached at least the
   *   pending-followback stage (i.e. we actually followed the candidate).
   * - `followedBack`: of those, the ones that reciprocated (non-null followed_back_at).
   * - `followBackRate`: followedBack / total (0 when total is 0).
   * - `poolSize`: active followers of the target (the raw poaching pool).
   * - `mutualOverlap`: target-followers we ALREADY actively follow (ownPk -> pk edge).
   */
  targetYield(
    targetPk: string,
    ownPk: string,
  ): {
    total: number;
    followedBack: number;
    followBackRate: number;
    poolSize: number;
    mutualOverlap: number;
  } {
    const counts = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           COUNT(followed_back_at) AS followed_back
         FROM follow_records
         WHERE target_pk = ?
           AND state IN ('pending_followback', 'followed_back', 'unfollow_queued', 'unfollowed')`,
      )
      .get(targetPk) as { total: number; followed_back: number };

    const total = counts.total;
    const followedBack = counts.followed_back;
    const followBackRate = total === 0 ? 0 : followedBack / total;

    const followers = this.followersOf(targetPk);
    const poolSize = followers.length;
    const mutualOverlap = followers.filter((pk) => {
      const edge = this.getEdge(ownPk, pk, 'follows');
      return edge !== null && edge.status === 'active';
    }).length;

    return { total, followedBack, followBackRate, poolSize, mutualOverlap };
  }

  /** Assign a role to an account (e.g. 'target', 'me'); the accounts row must exist. */
  setRole(pk: string, role: string): void {
    this.db.prepare(`UPDATE accounts SET role = ? WHERE pk = ?`).run(role, pk);
  }

  // --- Scrape cursors: per-target pagination resume (R4) -------------------------

  /**
   * Upsert the followers-list resume cursor (`next_max_id`) for a target. A `null`
   * cursor is stored verbatim (the last page had no next cursor), so a later read
   * distinguishes "exhausted" from "never scraped" only by row presence.
   */
  setScrapeCursor(targetPk: string, cursor: string | null, at: number = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO scrape_cursors (target_pk, cursor, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(target_pk) DO UPDATE SET
           cursor = excluded.cursor,
           updated_at = excluded.updated_at`,
      )
      .run(targetPk, cursor, at);
  }

  /** The stored resume cursor for a target, or `null` when absent or itself null. */
  getScrapeCursor(targetPk: string): string | null {
    const row = this.db
      .prepare(`SELECT cursor FROM scrape_cursors WHERE target_pk = ?`)
      .get(targetPk) as { cursor: string | null } | undefined;
    return row ? row.cursor : null;
  }

  close(): void {
    this.db.close();
  }
}
