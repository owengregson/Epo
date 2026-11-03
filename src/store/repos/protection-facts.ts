import type { SqliteDriver } from '../driver/driver';

/**
 * Read-only SQL behind the protection facts (following rows with their bios,
 * account suggestions, the kept table and its counts). A skeleton: the
 * settings-core stream adds the reads.
 */
export class ProtectionFactsRepo {
  constructor(protected readonly db: SqliteDriver) {}
}
