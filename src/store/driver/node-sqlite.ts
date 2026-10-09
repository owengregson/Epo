/**
 * The default driver: Node's built-in `node:sqlite`.
 *
 * This is the ONLY module in the app that imports it. It exists so Epo carries
 * zero native dependencies — no `electron-rebuild`, no ABI matrix, no
 * `asarUnpack`, and no class of failure where a packaged build cannot load its
 * addon on a platform nobody tested (see docs/adr/0702-node-sqlite-driver.md).
 *
 * `DatabaseSync` deliberately ships without `pragma()` and `transaction()`
 * helpers; both are below, and both are ~15 lines we want to own anyway.
 */

import { DatabaseSync } from 'node:sqlite';
import type { RunResult, SqliteDriver, SqlParams, SqlStatement, SqlValue } from './driver';

/** node:sqlite reports a pragma as a one-key row; we only ever want the value. */
const scalar = (row: unknown): SqlValue => {
  if (row === null || row === undefined) return null;
  const values = Object.values(row as Record<string, unknown>);
  const first = values[0];
  return typeof first === 'string' || typeof first === 'number' ? first : null;
};

/** `run()`'s counters arrive as numbers here, but coerce so BigInt can never leak. */
const runResult = (r: { changes: number | bigint; lastInsertRowid: number | bigint }): RunResult => ({
  changes: Number(r.changes),
  lastInsertRowid: Number(r.lastInsertRowid),
});

class NodeSqliteDriver implements SqliteDriver {
  readonly engine = 'node:sqlite' as const;
  private readonly db: DatabaseSync;
  /**
   * Prepared-statement cache, keyed by SQL text. Repos call `prepare()` on
   * every read, so without this every hot query re-parses; with it a scan's
   * per-row writes reuse one statement. `iterate()` bypasses it — an open
   * cursor is the one piece of state a shared statement cannot carry.
   */
  private readonly cache = new Map<string, SqlStatement>();
  /** SAVEPOINT nesting depth; 0 means the next `transaction()` opens the real one. */
  private depth = 0;
  /** Closing twice is a no-op, not an error — a fixture may close a handle a caller already did. */
  private open = true;

  constructor(readonly path: string) {
    this.db = new DatabaseSync(path);
    // An in-memory database has no journal to write ahead of; SQLite reports
    // `memory` and ignores the request, so only a file gets WAL.
    if (path !== ':memory:') this.pragma('journal_mode', 'WAL');
    // In WAL mode this fsyncs the WAL on every commit, so a committed action /
    // observation survives an OS power loss (WAL already guarantees no
    // corruption; FULL adds per-commit durability on top).
    this.pragma('synchronous', 'FULL');
    this.pragma('foreign_keys', 'ON');
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): SqlStatement {
    const hit = this.cache.get(sql);
    if (hit !== undefined) return hit;
    const stmt = this.wrap(sql);
    this.cache.set(sql, stmt);
    return stmt;
  }

  private wrap(sql: string): SqlStatement {
    const db = this.db;
    const stmt = db.prepare(sql);
    return {
      run: (...params: SqlParams) => runResult(stmt.run(...(params as never[]))),
      get: <T>(...params: SqlParams) => stmt.get(...(params as never[])) as T | undefined,
      all: <T>(...params: SqlParams) => stmt.all(...(params as never[])) as T[],
      // Fresh statement per call: two interleaved iterations of one cached
      // statement would share a cursor.
      iterate: <T>(...params: SqlParams) =>
        db.prepare(sql).iterate(...(params as never[])) as IterableIterator<T>,
    };
  }

  pragma(key: string): SqlValue;
  pragma(key: string, value: string | number): void;
  pragma(key: string, value?: string | number): SqlValue | undefined {
    // `key`/`value` are internal literals (see the port's docstring); a pragma
    // name cannot be a bound parameter in SQLite.
    if (value === undefined) return scalar(this.db.prepare(`PRAGMA ${key}`).get());
    this.db.exec(`PRAGMA ${key} = ${value}`);
    return undefined;
  }

  transaction<T>(fn: () => T): T {
    const name = `epo_sp${this.depth}`;
    this.db.exec(this.depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${name}`);
    this.depth += 1;
    let result: T;
    try {
      result = fn();
    } catch (e) {
      this.depth -= 1;
      if (this.depth === 0) this.db.exec('ROLLBACK');
      else {
        // ROLLBACK TO leaves the savepoint on the stack; RELEASE pops it.
        this.db.exec(`ROLLBACK TO ${name}`);
        this.db.exec(`RELEASE ${name}`);
      }
      throw e;
    }
    this.depth -= 1;
    this.db.exec(this.depth === 0 ? 'COMMIT' : `RELEASE ${name}`);
    return result;
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.cache.clear();
    this.db.close();
  }
}

/** Open `path` through `node:sqlite` with Epo's durability pragmas applied. */
export const openNodeSqlite = (path: string): SqliteDriver => new NodeSqliteDriver(path);
