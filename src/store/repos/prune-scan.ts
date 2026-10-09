import type { SqliteDriver } from '../driver/driver';
import type { PruneScanSnapshot } from '../types';

/**
 * The durable prune-scan snapshot: a singleton census row plus the candidates
 * a run has not yet visited.
 *
 * The remaining set is consumed row by row as a run acts, so a mid-run quit
 * leaves exactly the unvisited remainder (docs/PRINCIPLES.md §3). It is
 * deliberately separate from the last-complete census in `meta`: this set
 * shrinks as runs work through it, while the census is the settled display
 * truth a finished scan produced.
 */
export class PruneScanRepo {
  constructor(
    private readonly db: SqliteDriver,
    private readonly changed: () => void,
  ) {}

  /** Replace the snapshot (singleton) with this one — one transaction. */
  save(snap: PruneScanSnapshot): void {
    this.db.transaction(() => {
      this.clearRows();
      this.db
        .prepare(
          `INSERT INTO prune_scan (id, at, following_count, followers_count, candidate_count)
           VALUES (1, ?, ?, ?, ?)`,
        )
        .run(snap.at, snap.following, snap.followers, snap.candidateCount);
      const insert = this.db.prepare(
        `INSERT INTO prune_scan_remaining (pk, username) VALUES (?, ?)`,
      );
      for (const cand of snap.remaining) insert.run(cand.pk, cand.username);
    });
    this.changed();
  }

  /** The persisted snapshot, or null when no scan has been saved. */
  get(): PruneScanSnapshot | null {
    const head = this.db
      .prepare(
        `SELECT at, following_count, followers_count, candidate_count
         FROM prune_scan WHERE id = 1`,
      )
      .get() as
      | { at: number; following_count: number; followers_count: number; candidate_count: number }
      | undefined;
    if (head === undefined) return null;
    const rows = this.db
      .prepare(`SELECT pk, username FROM prune_scan_remaining ORDER BY rowid`)
      .all() as Array<{ pk: string; username: string | null }>;
    return {
      at: head.at,
      following: head.following_count,
      followers: head.followers_count,
      candidateCount: head.candidate_count,
      remaining: rows,
    };
  }

  /** A run visited this candidate — drop it from the durable remaining set. */
  consumeCandidate(pk: string): void {
    this.db.prepare(`DELETE FROM prune_scan_remaining WHERE pk = ?`).run(pk);
    this.changed();
  }

  /** Forget the snapshot entirely (new scan starting, or whitelist change). */
  clear(): void {
    this.db.transaction(() => this.clearRows());
    this.changed();
  }

  /**
   * How many raw census rows a run has not yet visited (0 without a snapshot).
   * A cheap COUNT twin of {@link get}'s `remaining` — safe to read on every
   * status projection, unlike loading the full row set.
   */
  remainingCount(): number {
    return (
      this.db.prepare(`SELECT COUNT(*) AS c FROM prune_scan_remaining`).get() as { c: number }
    ).c;
  }

  private clearRows(): void {
    this.db.prepare(`DELETE FROM prune_scan`).run();
    this.db.prepare(`DELETE FROM prune_scan_remaining`).run();
  }
}
