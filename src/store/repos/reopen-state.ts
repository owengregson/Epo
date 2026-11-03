import type { SqliteDriver } from '../driver/driver';
import type { MetaRepo } from './meta';

/**
 * The reopen frontiers' home (`meta.reopen_state`, one writer: the frontier
 * sweep). A skeleton: the reopen stream adds the typed reads and writes, and
 * validates the raw value it stores.
 */
export class ReopenStateRepo {
  constructor(
    protected readonly db: SqliteDriver,
    protected readonly meta: MetaRepo,
    protected readonly changed: () => void,
  ) {}

  /** The stored frontier document, unparsed; `null` when none was written. */
  raw(): string | null {
    return this.meta.get('reopenState');
  }

  /** Replace the stored document; `null` deletes it. */
  setRaw(raw: string | null): void {
    this.meta.set('reopenState', raw);
  }
}
