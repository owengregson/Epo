/**
 * Per-target scrape cursor: the value round-trip, plus the upgrade of a
 * database frozen at the version that predates every later migration — its
 * accounts must survive intact.
 */

import { memoryStore } from '../kit/store';
import { LATEST_SCHEMA_VERSION, withLegacyDb } from '../kit/store-legacy-db';

test('scrape_cursor round-trips a value', () => {
  const s = memoryStore();
  expect(s.getScrapeCursor('t1')).toBeNull(); // absent
  s.setScrapeCursor('t1', 'NEXT_MAX_ID_123', 1000);
  expect(s.getScrapeCursor('t1')).toBe('NEXT_MAX_ID_123');
  // Upsert overwrites in place.
  s.setScrapeCursor('t1', 'NEXT_MAX_ID_456', 2000);
  expect(s.getScrapeCursor('t1')).toBe('NEXT_MAX_ID_456');
  // A null cursor is stored verbatim and reads back as null.
  s.setScrapeCursor('t1', null, 3000);
  expect(s.getScrapeCursor('t1')).toBeNull();
  s.close();
});

test('an existing v1 database migrates forward without data loss', () => {
  withLegacyDb(1, (legacy) => {
    legacy.raw
      .prepare(
        `INSERT INTO accounts (pk, username, enrichment, first_seen_at, last_seen_at)
         VALUES (?, ?, 'profiled', 10, 20)`,
      )
      .run('acc1', 'alice');
    // scrape_cursors does not exist yet at this version.
    expect(
      legacy.raw
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='scrape_cursors'`)
        .get(),
    ).toBeUndefined();

    // Opening through the store runs every pending migration.
    const store = legacy.open();

    // Pre-existing data survived the upgrade.
    const acc = store.getAccount('acc1');
    expect(acc).not.toBeNull();
    expect(acc?.username).toBe('alice');
    expect(acc?.enrichment).toBe('profiled');

    // The new table now exists and works.
    store.setScrapeCursor('acc1', 'CUR', 5000);
    expect(store.getScrapeCursor('acc1')).toBe('CUR');
    store.close();

    expect(legacy.schemaVersion()).toBe(LATEST_SCHEMA_VERSION);
  });
});
