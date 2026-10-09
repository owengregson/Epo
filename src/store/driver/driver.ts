/**
 * The SQLite port: everything `src/store/**` is allowed to know about the
 * engine underneath it.
 *
 * One implementation satisfies it today — `node-sqlite.ts`, Node's built-in
 * `node:sqlite` with zero native dependencies (ADR 0702). Keeping the surface
 * this small is what makes an engine swap a non-event: nothing above this
 * file names a vendor type, so a second driver is one file and one union
 * member, never a store change.
 */

/** Every value SQLite stores. No `undefined`, no `boolean` — see `sql-values.ts`. */
export type SqlValue = string | number | null;

/** Named bindings, `@name`-style, bound bare (the `@` is optional in the key). */
export type NamedParams = Readonly<Record<string, SqlValue>>;

/** Positional values, or a single named-parameter object. */
export type SqlParams = readonly (SqlValue | NamedParams)[];

/** What a write reports. `lastInsertRowid` is a plain number (no BigInt). */
export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

/** One prepared statement. Stateless between calls; safe to re-run. */
export interface SqlStatement {
  run(...params: SqlParams): RunResult;
  /** The first row, or `undefined` when the query matched nothing. */
  get<T = unknown>(...params: SqlParams): T | undefined;
  all<T = unknown>(...params: SqlParams): T[];
  /** Streams rows without materializing them; always prepared fresh. */
  iterate<T = unknown>(...params: SqlParams): IterableIterator<T>;
}

/**
 * The database handle. `transaction` nests through SAVEPOINTs, so a write that
 * spans repos composes with the per-repo writes it calls.
 */
export interface SqliteDriver {
  /** The file this handle opened, or `':memory:'`. */
  readonly path: string;
  /** Which implementation is running — reported by the boot self-test. */
  readonly engine: 'node:sqlite';
  /** Run one or more statements with no bindings (DDL, migrations, pragmas). */
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  /** Read a scalar pragma (`user_version`, `journal_mode`, …). */
  pragma(key: string): SqlValue;
  /** Write a pragma. `key` and `value` are internal literals, never user input. */
  pragma(key: string, value: string | number): void;
  /** Runs `fn` in a transaction; nested calls become SAVEPOINTs. Rethrows after rollback. */
  transaction<T>(fn: () => T): T;
  close(): void;
}
