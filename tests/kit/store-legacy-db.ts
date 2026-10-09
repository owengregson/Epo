/**
 * Migration fixture: a file-backed database frozen at an OLDER schema version.
 *
 * A `:memory:` store always opens fully migrated, so the only way to prove a
 * migration is to build the previous schema by hand, seed it as a live install
 * would have it, then open it through `KnowledgeStore` and watch the pending
 * migrations run. This helper owns the temp dir, the raw handle, and the
 * cleanup so each migration test states only what it is actually asserting.
 *
 * The raw handle is a `SqliteDriver`, not a vendor type — the fixture proves
 * migrations, not which engine ran them.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SqliteDriver } from '@/store/driver/driver';
import { openDatabase } from '@/store/driver/index';
import { KnowledgeStore } from '@/store/knowledge-store';
import { MIGRATIONS } from '@/store/schema';

export interface LegacyDb {
  /** Raw handle open at the requested version — seed rows and read PRAGMAs. */
  raw: SqliteDriver;
  /** Close `raw` and re-open the same file through the store, migrating it. */
  open(): KnowledgeStore;
  /** The file's current `user_version`, read through a throwaway handle. */
  schemaVersion(): number;
}

/** The version a fully-migrated database lands on. */
export const LATEST_SCHEMA_VERSION = MIGRATIONS.length;

/**
 * Build a database at `version` (i.e. migrations `0..version-1` applied), run
 * `fn` against it, then close every handle and delete the temp directory.
 */
export const withLegacyDb = <T>(version: number, fn: (db: LegacyDb) => T): T => {
  if (!Number.isInteger(version) || version < 0 || version > MIGRATIONS.length) {
    throw new Error(`withLegacyDb: version ${version} is outside 0..${MIGRATIONS.length}`);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epo-legacy-db-'));
  const dbPath = path.join(dir, 'legacy.db');

  const raw = openDatabase(dbPath);
  for (let i = 0; i < version; i += 1) raw.exec(MIGRATIONS[i].sql);
  raw.pragma('user_version', version);

  let rawOpen = true;
  const closeRaw = (): void => {
    if (rawOpen) {
      raw.close();
      rawOpen = false;
    }
  };
  const stores: KnowledgeStore[] = [];

  try {
    return fn({
      raw,
      open() {
        closeRaw();
        const store = new KnowledgeStore(dbPath);
        stores.push(store);
        return store;
      },
      schemaVersion() {
        const probe = openDatabase(dbPath);
        try {
          return probe.pragma('user_version') as number;
        } finally {
          probe.close();
        }
      },
    });
  } finally {
    for (const store of stores) store.close();
    closeRaw();
    fs.rmSync(dir, { recursive: true, force: true });
  }
};
