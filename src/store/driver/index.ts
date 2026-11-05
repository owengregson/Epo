/**
 * Driver selection: one place that decides which engine the store runs on.
 *
 * `node:sqlite` is the only engine: the runtime's built-in SQLite (Electron 44
 * bundles Node 24), so nothing native ships and nothing is rebuilt per ABI.
 * `EPO_SQLITE_DRIVER` is honoured only to name it explicitly; any other value
 * THROWS — silently running a different engine than the operator asked for is
 * exactly the kind of quiet degradation the self-test exists to prevent. The
 * former `better-sqlite3` fallback lives in git history (ADR 0702).
 */

import type { SqliteDriver } from './driver';
import { openNodeSqlite } from './node-sqlite';
import { runSelfTest } from './self-test';

export type DriverName = 'node:sqlite';

/** The env var an operator sets to pin the engine. */
export const DRIVER_ENV = 'EPO_SQLITE_DRIVER';

/** Which engine `openDatabase` would choose right now. */
export const selectedDriver = (env: NodeJS.ProcessEnv = process.env): DriverName => {
  const raw = env[DRIVER_ENV];
  if (raw === undefined || raw === '' || raw === 'node:sqlite' || raw === 'node-sqlite') {
    return 'node:sqlite';
  }
  throw new Error(
    `store: ${DRIVER_ENV}="${raw}" is not a driver (expected "node:sqlite"); refusing to guess`,
  );
};

/**
 * Open `path`, apply the durability pragmas, and prove the handle works before
 * handing it back. Throws rather than returning a degraded database.
 */
export const openDatabase = (path: string): SqliteDriver => {
  selectedDriver(); // refuses an unrecognised engine name before anything opens
  const db: SqliteDriver = openNodeSqlite(path);
  try {
    runSelfTest(db);
  } catch (e) {
    db.close();
    throw e;
  }
  return db;
};

export type { RunResult, SqliteDriver, SqlParams, SqlStatement, SqlValue } from './driver';
export { DriverSelfTestError, runSelfTest } from './self-test';
