import type BetterSqlite3 from 'better-sqlite3';
import { MIGRATIONS } from './schema';
import * as logger from '../utils/logger';

type Db = BetterSqlite3.Database;

/**
 * Applies every migration whose index is >= the database's current `user_version`,
 * each inside its own transaction, then advances `user_version`. Idempotent: on a
 * fully-migrated database it is a no-op. Only `src/store/*` runs SQL.
 */
export const runMigrations = (db: Db): void => {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let version = current; version < MIGRATIONS.length; version++) {
    const sql = MIGRATIONS[version];
    const apply = db.transaction(() => {
      db.exec(sql);
      // user_version is a pragma and cannot be parameterized; version is a trusted int.
      db.pragma(`user_version = ${version + 1}`);
    });
    apply();
    logger.info('store.migration.applied', { from: version, to: version + 1 });
  }
};
