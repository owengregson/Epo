import * as logger from '../utils/logger';
import type { SqliteDriver } from './driver/driver';
import { MIGRATIONS } from './schema';

/**
 * Applies every migration whose id is >= the database's current `user_version`,
 * each inside its own transaction, then advances `user_version`. Idempotent: on
 * a fully-migrated database it is a no-op. Only `src/store/*` runs SQL.
 */
export const runMigrations = (db: SqliteDriver): void => {
  const current = db.pragma('user_version') as number;
  if (current > MIGRATIONS.length) {
    // A database touched by a NEWER build: its schema is unknown to this code.
    // Proceeding would run old SQL against new tables — refuse loudly instead.
    throw new Error(
      `store: database schema version ${current} is newer than this build supports ` +
        `(${MIGRATIONS.length}); refusing to open it`,
    );
  }
  for (let version = current; version < MIGRATIONS.length; version++) {
    const migration = MIGRATIONS[version];
    // The append-only rule, mechanically: a migration's declared id IS its
    // position, so an inserted, reordered, or renumbered entry fails here
    // instead of silently applying the wrong SQL to the wrong version.
    if (migration.id !== version) {
      throw new Error(
        `store: migration at index ${version} declares id ${migration.id} ` +
          `("${migration.name}"); migrations are append-only and must never be renumbered`,
      );
    }
    db.transaction(() => {
      db.exec(migration.sql);
      // user_version is a pragma and cannot be parameterized; version is a trusted int.
      db.pragma('user_version', version + 1);
    });
    logger.info('store.migration.applied', {
      from: version,
      to: version + 1,
      name: migration.name,
    });
  }
};
