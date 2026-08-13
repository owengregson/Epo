import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { KnowledgeStore } from '@/store/knowledge-store';
import { MIGRATIONS } from '@/store/schema';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epo-cursor-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('scrape_cursor round-trips a value', () => {
  const s = new KnowledgeStore(':memory:');
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

test('an existing v0 database migrates to v1 without data loss', () => {
  const dbPath = path.join(dir, 'v0.db');

  // Build a database at exactly migration 0 (the initial schema), as it would
  // exist before this task shipped: apply MIGRATIONS[0] and stamp user_version=1.
  const raw = new Database(dbPath);
  raw.exec(MIGRATIONS[0]);
  raw.pragma('user_version = 1');
  raw
    .prepare(
      `INSERT INTO accounts (pk, username, enrichment, first_seen_at, last_seen_at)
       VALUES (?, ?, 'profiled', 10, 20)`,
    )
    .run('acc1', 'alice');
  expect(raw.pragma('user_version', { simple: true })).toBe(1);
  // scrape_cursors does not exist yet at v0.
  const before = raw
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='scrape_cursors'`)
    .get();
  expect(before).toBeUndefined();
  raw.close();

  // Opening through the store runs the pending migration (index 1).
  const store = new KnowledgeStore(dbPath);

  // Pre-existing data survived the upgrade.
  const acc = store.getAccount('acc1');
  expect(acc).not.toBeNull();
  expect(acc!.username).toBe('alice');
  expect(acc!.enrichment).toBe('profiled');

  // The new table now exists and works.
  store.setScrapeCursor('acc1', 'CUR', 5000);
  expect(store.getScrapeCursor('acc1')).toBe('CUR');
  store.close();

  // user_version advanced to MIGRATIONS.length.
  const check = new Database(dbPath);
  expect(check.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
  check.close();
});
