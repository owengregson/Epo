import type { SqliteDriver } from '../driver/driver';

/**
 * The two append-only action ledgers: `action_ledger` (the growth engine's
 * follow/unfollow record, source of truth for the rate governor) and
 * `prune_ledger` (the prune routine's independent daily cap).
 *
 * Append-only by design — nothing here updates or deletes a row. Every count
 * is a window read over `at`, which both tables index.
 */
export class LedgerRepo {
  constructor(
    private readonly db: SqliteDriver,
    private readonly changed: () => void,
  ) {}

  private countSince(sql: string, sinceMs: number): number {
    return (this.db.prepare(sql).get(sinceMs) as { c: number }).c;
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
    this.changed();
  }

  actionCountSince(sinceMs: number): number {
    return this.countSince(`SELECT COUNT(*) AS c FROM action_ledger WHERE at >= ?`, sinceMs);
  }

  /**
   * Follows that actually LANDED since `sinceMs` — unfollows and failures
   * excluded, so the rate reflects real forward progress only.
   */
  followActionCountSince(sinceMs: number): number {
    return this.countSince(
      `SELECT COUNT(*) AS c FROM action_ledger
       WHERE at >= ? AND action = 'follow' AND result = 'ok'`,
      sinceMs,
    );
  }

  recordPruneAction(accountPk: string, result: 'ok' | 'fail' | 'simulated', at: number): void {
    this.db
      .prepare(`INSERT INTO prune_ledger (account_pk, at, result) VALUES (?, ?, ?)`)
      .run(accountPk, at, result);
    this.changed();
  }

  pruneCountSince(sinceMs: number): number {
    return this.countSince(`SELECT COUNT(*) AS c FROM prune_ledger WHERE at >= ?`, sinceMs);
  }

  /**
   * REAL prune actions since `sinceMs` — `ok`/`fail` only. A `simulated` row is
   * dry-run intent that never touched Instagram, so counting it would make the
   * shared ceiling refuse writes the account never made.
   */
  realPruneActionCountSince(sinceMs: number): number {
    return this.countSince(
      `SELECT COUNT(*) AS c FROM prune_ledger WHERE at >= ? AND result IN ('ok', 'fail')`,
      sinceMs,
    );
  }
}
