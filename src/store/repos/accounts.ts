import type { SqliteDriver } from '../driver/driver';
import { projectAccount } from '../projections';
import { type AccountRow, rowToState } from '../rows';
import { type AccountState, type Observation, SOURCE_CONFIDENCE } from '../types';
import { ACCOUNT_UPSERT_SQL, accountUpsertParams } from './account-columns';

/**
 * The account projection and its append-only inputs: `observations` (the raw
 * event log), `accounts` (the folded current state), and `username_history`.
 *
 * The merge itself is NOT here — `projectAccount` is a pure function of
 * (existing, observation) tested without a database. This class only decides
 * what to persist and when.
 */
export class AccountRepo {
  constructor(
    private readonly db: SqliteDriver,
    private readonly changed: () => void,
  ) {}

  /**
   * Append an observation and re-project the account row in the SAME
   * transaction — the single write path that keeps the event log and the
   * projection consistent. Called per parsed row (docs/PRINCIPLES.md §1), so
   * it must stay cheap and must never buffer.
   */
  observe(obs: Observation): void {
    this.db.transaction(() => {
      const o = obs;
      this.db
        .prepare(
          `INSERT INTO observations (account_pk, observed_at, source, confidence, field_set)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          o.accountPk,
          o.observedAt,
          o.source,
          SOURCE_CONFIDENCE[o.source],
          JSON.stringify(o.fields),
        );

      const existing = this.get(o.accountPk);
      const next = projectAccount(existing, o);

      // Column list, VALUES list, ON CONFLICT SET and params all come from
      // ACCOUNT_COLUMNS — one manifest, so they cannot drift apart.
      this.db.prepare(ACCOUNT_UPSERT_SQL).run(accountUpsertParams(next));

      // History, not a heartbeat: a row lands only when the account's PROJECTED
      // username actually changes (first sighting included). Logging every
      // observation instead wrote a row per row of every census — a write
      // amplification on the streaming hot path that nothing reads. A stale read the
      // projection rejects writes nothing, because the value did not change.
      if (next.username !== undefined && next.username !== existing?.username) {
        this.db
          .prepare(`INSERT INTO username_history (pk, username, seen_at) VALUES (?, ?, ?)`)
          .run(o.accountPk, next.username, o.observedAt);
      }
    });
    this.changed();
  }

  /**
   * Retention sweep, run once at open: the raw observation log and the username
   * history are append-only and nothing reads rows older than the projection
   * they already fed, so the store policy's retention window keeps a large
   * account's daily thousands of rows from growing without bound. Real wall
   * clock on purpose — retention is an operational concern of THIS process,
   * not of any injected test clock.
   */
  pruneAppendOnlyLogs(retentionMs: number): void {
    const cutoff = Date.now() - retentionMs;
    this.db.prepare(`DELETE FROM observations WHERE observed_at < ?`).run(cutoff);
    this.db.prepare(`DELETE FROM username_history WHERE seen_at < ?`).run(cutoff);
  }

  get(pk: string): AccountState | null {
    const row = this.db.prepare(`SELECT * FROM accounts WHERE pk = ?`).get(pk) as
      | AccountRow
      | undefined;
    return row ? rowToState(row) : null;
  }

  /**
   * The pk currently projected under `username` (case-insensitive; the
   * most-recently-seen row wins if a rename ever leaves two). Lets acquisition
   * resolve a known target without an Instagram request. `null` when unseen.
   */
  pkByUsername(username: string): string | null {
    const row = this.db
      .prepare(
        `SELECT pk FROM accounts WHERE username = ? COLLATE NOCASE
         ORDER BY last_seen_at DESC LIMIT 1`,
      )
      .get(username) as { pk: string } | undefined;
    return row?.pk ?? null;
  }

  /**
   * Stamp `username`'s account as permanently un-enrichable (deleted,
   * suspended, unparseable profile body) so enrichment selection skips it and
   * a dead account can never head-of-line-block the pool. Cleared by any later
   * successful stats observation — see the upsert's `ON CONFLICT` tail.
   */
  markEnrichmentFailed(username: string, at: number): void {
    this.db
      .prepare(`UPDATE accounts SET enrich_failed_at = ? WHERE username = ? COLLATE NOCASE`)
      .run(at, username);
    this.changed();
  }

  /** Assign a role (e.g. 'target', 'me', 'skipped'); the row must already exist. */
  setRole(pk: string, role: string): void {
    this.db.prepare(`UPDATE accounts SET role = ? WHERE pk = ?`).run(role, pk);
    this.changed();
  }

  /** Every pk the Scanner has rejected (`role = 'skipped'`) — pool exclusion. */
  skippedPks(): Set<string> {
    const rows = this.db.prepare(`SELECT pk FROM accounts WHERE role = 'skipped'`).all() as Array<{
      pk: string;
    }>;
    return new Set(rows.map((r) => r.pk));
  }
}
