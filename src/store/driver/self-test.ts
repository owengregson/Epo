/**
 * The boot self-test: prove the engine underneath us is the one we asked for,
 * BEFORE any fact is written to it.
 *
 * `node:sqlite` is experimental upstream, which means an Electron major could
 * change its behaviour with no compile error. The mitigation is not a version
 * check — it is a round trip. If WAL is not on, `user_version` is unreadable,
 * or a written row does not read back, the store REFUSES TO OPEN rather than
 * degrade: a database that silently lost durability is worse than one that
 * would not open, because the second failure is visible on the first launch.
 */

import type { SqliteDriver } from './driver';

/** Thrown instead of returning a half-working handle. */
export class DriverSelfTestError extends Error {
  constructor(check: string, detail: string) {
    super(`store: SQLite driver self-test failed (${check}): ${detail}`);
    this.name = 'DriverSelfTestError';
  }
}

const expect = (ok: boolean, check: string, detail: string): void => {
  if (!ok) throw new DriverSelfTestError(check, detail);
};

/**
 * Run every check against an open handle. Cheap (five pragmas and one
 * temp-table round trip), so it runs on every open, not behind a flag.
 */
export const runSelfTest = (db: SqliteDriver): void => {
  // 1. Write-ahead logging, on a file. An in-memory database has no journal to
  //    write ahead of and SQLite reports `memory`; anything else is drift.
  const journal = String(db.pragma('journal_mode')).toLowerCase();
  const wantJournal = db.path === ':memory:' ? 'memory' : 'wal';
  expect(journal === wantJournal, 'journal_mode', `expected ${wantJournal}, got ${journal}`);

  // 2. Per-commit durability and referential integrity, as the store assumes.
  expect(db.pragma('synchronous') === 2, 'synchronous', `expected FULL (2), got ${db.pragma('synchronous')}`);
  expect(db.pragma('foreign_keys') === 1, 'foreign_keys', `expected ON (1), got ${db.pragma('foreign_keys')}`);

  // 3. `user_version` is how migrations know where they are. If it does not
  //    read back as a number the migration runner cannot be trusted at all.
  const version = db.pragma('user_version');
  expect(
    typeof version === 'number' && Number.isInteger(version) && version >= 0,
    'user_version',
    `unreadable (${String(version)})`,
  );

  // 4. A real round trip: prepare, bind (positional AND named), write, read
  //    back, and see the write counter. A TEMP table lives in its own schema,
  //    so this never touches the file's contents.
  try {
    db.exec('DROP TABLE IF EXISTS temp._epo_self_test');
    db.exec('CREATE TEMP TABLE _epo_self_test (k INTEGER PRIMARY KEY, v TEXT, n REAL)');
    const wrote = db
      .prepare('INSERT INTO temp._epo_self_test (k, v, n) VALUES (?, ?, ?)')
      .run(1, 'epo', 1.5);
    expect(wrote.changes === 1, 'round-trip', `insert reported ${wrote.changes} changes`);
    const read = db
      .prepare('SELECT k, v, n FROM temp._epo_self_test WHERE k = @k')
      .get<{ k: number; v: string; n: number }>({ k: 1 });
    expect(
      read?.k === 1 && read.v === 'epo' && read.n === 1.5,
      'round-trip',
      `read back ${JSON.stringify(read)}`,
    );
    // A miss must be `undefined`, not a fabricated empty row.
    const miss = db.prepare('SELECT k FROM temp._epo_self_test WHERE k = ?').get(2);
    expect(miss === undefined, 'round-trip', `a missing row read back as ${JSON.stringify(miss)}`);
    // Nesting: the inner failure must roll back to its savepoint and leave the
    // outer transaction intact — the shape every multi-repo write relies on.
    db.transaction(() => {
      db.prepare('INSERT INTO temp._epo_self_test (k, v) VALUES (?, ?)').run(3, 'outer');
      try {
        db.transaction(() => {
          db.prepare('INSERT INTO temp._epo_self_test (k, v) VALUES (?, ?)').run(4, 'inner');
          throw new Error('rollback');
        });
      } catch {
        // expected — this IS the assertion below
      }
    });
    const survived = db
      .prepare('SELECT COUNT(*) AS c FROM temp._epo_self_test WHERE k IN (3, 4)')
      .get<{ c: number }>();
    expect(survived?.c === 1, 'savepoint', `expected the outer row only, found ${survived?.c}`);
    db.exec('DROP TABLE temp._epo_self_test');
  } catch (e) {
    if (e instanceof DriverSelfTestError) throw e;
    throw new DriverSelfTestError('round-trip', String(e));
  }
};
