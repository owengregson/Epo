import type { SqliteDriver } from '../driver/driver';

/**
 * Per-target followers-list pagination cursors, so a scrape resumes across
 * sessions instead of re-scrolling from the top.
 */
export class CursorRepo {
  constructor(private readonly db: SqliteDriver) {}

  /**
   * Upsert a target's resume cursor. A `null` cursor is stored verbatim (the
   * last page had no next cursor), so a later read tells "exhausted" from
   * "never scraped" by row presence alone.
   *
   * `at` is required: callers pass their injected clock's time, so this write
   * can never silently bypass a fake clock through a `Date.now()` default.
   */
  set(targetPk: string, cursor: string | null, at: number): void {
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

  /** The stored cursor, or `null` when absent or itself null. */
  get(targetPk: string): string | null {
    const row = this.db
      .prepare(`SELECT cursor FROM scrape_cursors WHERE target_pk = ?`)
      .get(targetPk) as { cursor: string | null } | undefined;
    return row ? row.cursor : null;
  }
}
