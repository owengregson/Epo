import type { SqliteDriver } from '../driver/driver';

/**
 * Read-only SQL behind the live feed (settled effects, follow-backs, new and
 * lost followers). A skeleton: the live-data stream adds the reads; the bounds
 * they need arrive as method arguments, never by import.
 */
export class FeedReadsRepo {
  constructor(protected readonly db: SqliteDriver) {}
}
