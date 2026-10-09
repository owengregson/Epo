import type { SqliteDriver } from '../driver/driver';
import { rowToTarget, type TargetRow } from '../rows';
import { orNull } from '../sql-values';
import type { Target } from '../types';

/**
 * The poaching chain's targets: which accounts the chain is mining, in what
 * order, and whether their follower pool is drained.
 *
 * Yield and funnel statistics are NOT here — they are emergent queries over
 * follow_records and edges, and live with the analytics reads.
 */
export class TargetRepo {
  constructor(
    private readonly db: SqliteDriver,
    private readonly changed: () => void,
  ) {}

  /** Insert or replace a chain target, keyed on account_pk. */
  add(t: Target): void {
    this.db
      .prepare(
        `INSERT INTO targets (account_pk, source, status, chain_index, exhausted_at)
         VALUES (@account_pk, @source, @status, @chain_index, @exhausted_at)
         ON CONFLICT(account_pk) DO UPDATE SET
           source = excluded.source,
           status = excluded.status,
           chain_index = excluded.chain_index,
           exhausted_at = excluded.exhausted_at`,
      )
      .run({
        account_pk: t.accountPk,
        source: t.source,
        status: t.status,
        chain_index: orNull(t.chainIndex ?? undefined),
        exhausted_at: orNull(t.exhaustedAt),
      });
    this.changed();
  }

  get(accountPk: string): Target | null {
    const row = this.db
      .prepare(`SELECT * FROM targets WHERE account_pk = ?`)
      .get(accountPk) as TargetRow | undefined;
    return row ? rowToTarget(row) : null;
  }

  /**
   * Marking 'exhausted' WITH `at` stamps `exhausted_at` — the evidence time the
   * chain concluded the pool was drained, which keeps the verdict REVERSIBLE
   * (the dead-end self-heal only reconsiders recently stamped targets, see
   * {@link exhaustedSince}). WITHOUT `at` it is a deliberate retirement
   * (restart-from-seed): no stamp, never auto-revived. Any other status clears
   * the stamp — an active or retained target is not exhausted.
   */
  setStatus(accountPk: string, status: Target['status'], at?: number): void {
    this.db
      .prepare(`UPDATE targets SET status = ?, exhausted_at = ? WHERE account_pk = ?`)
      .run(status, status === 'exhausted' ? orNull(at) : null, accountPk);
    this.changed();
  }

  /** All chain targets ordered by chain_index (nulls last), then account_pk. */
  list(): Target[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM targets
           ORDER BY chain_index IS NULL, chain_index ASC, account_pk ASC`,
        )
        .all() as TargetRow[]
    ).map(rowToTarget);
  }

  /**
   * Targets currently 'exhausted' whose evidence stamp is at/after `cutoff`,
   * most recently exhausted first. Unstamped exhaustions never appear.
   */
  exhaustedSince(cutoff: number): Target[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM targets
           WHERE status = 'exhausted' AND exhausted_at IS NOT NULL AND exhausted_at >= ?
           ORDER BY exhausted_at DESC, account_pk ASC`,
        )
        .all(cutoff) as TargetRow[]
    ).map(rowToTarget);
  }

  /** The next chain position: `(MAX(chain_index) ?? -1) + 1`. */
  nextChainIndex(): number {
    const row = this.db.prepare(`SELECT MAX(chain_index) AS m FROM targets`).get() as {
      m: number | null;
    };
    return (row.m ?? -1) + 1;
  }

  /** Every target pk, for membership tests. */
  pks(): Set<string> {
    const rows = this.db.prepare(`SELECT account_pk FROM targets`).all() as Array<{
      account_pk: string;
    }>;
    return new Set(rows.map((r) => r.account_pk));
  }
}
