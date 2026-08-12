import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import {
  AccountState,
  Edge,
  EdgeType,
  EnrichmentLevel,
  Observation,
  Source,
  SOURCE_CONFIDENCE,
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

  close(): void {
    this.db.close();
  }
}
