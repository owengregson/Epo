/**
 * The SQLite port: the behaviours every engine under it must agree on, and
 * the self-test that refuses to hand back a database which does not.
 *
 * `node:sqlite` is the only engine; an unrecognised name is refused, never guessed.
 */

import { DriverSelfTestError, runSelfTest, selectedDriver } from '@/store/driver/index';
import { withDriver } from '../kit/store-driver';

test('the default driver is node:sqlite, and an unknown name is refused, never guessed', () => {
  expect(selectedDriver({})).toBe('node:sqlite');
  expect(selectedDriver({ EPO_SQLITE_DRIVER: '' })).toBe('node:sqlite');
  expect(selectedDriver({ EPO_SQLITE_DRIVER: 'node:sqlite' })).toBe('node:sqlite');
  expect(() => selectedDriver({ EPO_SQLITE_DRIVER: 'better-sqlite3' })).toThrow(/refusing to guess/);
  expect(() => selectedDriver({ EPO_SQLITE_DRIVER: 'postgres' })).toThrow(/refusing to guess/);
});

test('opening applies the durability pragmas and passes its own self-test', () => {
  withDriver((db) => {
    // `:memory:` has no journal to write ahead of — WAL is a file property.
    expect(db.pragma('journal_mode')).toBe('memory');
    expect(db.pragma('synchronous')).toBe(2);
    expect(db.pragma('foreign_keys')).toBe(1);
    expect(() => runSelfTest(db)).not.toThrow();
  });
});

test('the self-test REFUSES rather than degrading when durability is lost', () => {
  withDriver((db) => {
    db.pragma('synchronous', 'OFF');
    expect(() => runSelfTest(db)).toThrow(DriverSelfTestError);
    expect(() => runSelfTest(db)).toThrow(/synchronous/);
    db.pragma('synchronous', 'FULL');
    db.pragma('foreign_keys', 'OFF');
    expect(() => runSelfTest(db)).toThrow(/foreign_keys/);
  });
});

test('a missing row is `undefined`, never a fabricated empty row', () => {
  withDriver((db) => {
    db.exec('CREATE TABLE t (k TEXT PRIMARY KEY, v INTEGER)');
    expect(db.prepare('SELECT * FROM t WHERE k = ?').get('nope')).toBeUndefined();
    expect(db.prepare('SELECT * FROM t').all()).toEqual([]);
  });
});

test('bindings work positionally and by name, and report what they wrote', () => {
  withDriver((db) => {
    db.exec('CREATE TABLE t (k TEXT PRIMARY KEY, v INTEGER, r REAL)');
    const positional = db.prepare('INSERT INTO t (k, v, r) VALUES (?, ?, ?)').run('a', 1, 1.5);
    expect(positional).toEqual({ changes: 1, lastInsertRowid: expect.any(Number) });
    db.prepare('INSERT INTO t (k, v, r) VALUES (@k, @v, @r)').run({ k: 'b', v: 2, r: 2.5 });
    expect(db.prepare('SELECT k, v, r FROM t ORDER BY k').all()).toEqual([
      { k: 'a', v: 1, r: 1.5 },
      { k: 'b', v: 2, r: 2.5 },
    ]);
    // NULL is a value; the codecs in sql-values.ts are what turn it into
    // `undefined` at the domain edge.
    db.prepare('INSERT INTO t (k, v, r) VALUES (?, ?, ?)').run('c', null, null);
    expect(db.prepare('SELECT v FROM t WHERE k = ?').get('c')).toEqual({ v: null });
    // `lastInsertRowid` is a plain number — BigInt must never reach a caller.
    const wrote = db.prepare('INSERT INTO t (k) VALUES (?)').run('d');
    expect(Number.isSafeInteger(wrote.lastInsertRowid)).toBe(true);
  });
});

test('iterate streams rows without materializing them', () => {
  withDriver((db) => {
    db.exec('CREATE TABLE t (k INTEGER PRIMARY KEY)');
    const insert = db.prepare('INSERT INTO t (k) VALUES (?)');
    for (let i = 0; i < 5; i++) insert.run(i);
    const seen: number[] = [];
    for (const row of db.prepare('SELECT k FROM t ORDER BY k').iterate<{ k: number }>()) {
      seen.push(row.k);
    }
    expect(seen).toEqual([0, 1, 2, 3, 4]);
  });
});

test('transactions nest through savepoints: an inner rollback spares the outer work', () => {
  withDriver((db) => {
    db.exec('CREATE TABLE t (k TEXT PRIMARY KEY)');
    const insert = db.prepare('INSERT INTO t (k) VALUES (?)');
    db.transaction(() => {
      insert.run('outer');
      expect(() =>
        db.transaction(() => {
          insert.run('inner');
          throw new Error('inner failed');
        }),
      ).toThrow('inner failed');
      insert.run('after');
    });
    expect(db.prepare('SELECT k FROM t ORDER BY k').all()).toEqual([{ k: 'after' }, { k: 'outer' }]);
  });
});

test('an outer rollback discards everything, including committed savepoints', () => {
  withDriver((db) => {
    db.exec('CREATE TABLE t (k TEXT PRIMARY KEY)');
    const insert = db.prepare('INSERT INTO t (k) VALUES (?)');
    expect(() =>
      db.transaction(() => {
        db.transaction(() => insert.run('inner'));
        throw new Error('outer failed');
      }),
    ).toThrow('outer failed');
    expect(db.prepare('SELECT COUNT(*) AS c FROM t').get()).toEqual({ c: 0 });
  });
});

test('a transaction returns its value, and the handle is reusable afterwards', () => {
  withDriver((db) => {
    db.exec('CREATE TABLE t (k TEXT PRIMARY KEY)');
    expect(db.transaction(() => 7)).toBe(7);
    db.prepare('INSERT INTO t (k) VALUES (?)').run('a');
    expect(db.prepare('SELECT COUNT(*) AS c FROM t').get()).toEqual({ c: 1 });
  });
});

test('closing twice is a no-op, not an error', () => {
  withDriver((db) => {
    db.close();
    expect(() => db.close()).not.toThrow();
  });
});
