/**
 * The table manifest is only worth having if it is the TRUTH about the
 * database. These are the assertions that keep it so: it must name every live
 * table and every live column, it must refuse a shape it does not describe,
 * and the DDL it generated for a SHIPPED migration must never change again.
 */

import { openDatabase } from '@/store/driver/index';
import { runMigrations } from '@/store/migrations';
import { MIGRATIONS } from '@/store/schema';
import { FOLLOWER_CHANGES, OWN_COUNTS } from '@/store/schema/growth-log-migration';
import { ACCOUNTS, assertSchema, SPANS, TABLES, TIMERS } from '@/store/schema/manifest';
import { SURFACE_DRIFT, SURFACE_HEALTH } from '@/store/schema/surface-tables';
import { ddl, driftOf, upsertSql } from '@/store/schema/tables';
import { memoryStore } from '../kit/store';
import { driverOf, withDriver } from '../kit/store-driver';

const liveTables = (store = memoryStore()): string[] => {
  try {
    return driverOf(store)
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all<{ name: string }>()
      .map((r) => r.name);
  } finally {
    store.close();
  }
};

test('the manifest names exactly the tables a migrated database has', () => {
  expect(liveTables().sort()).toEqual([...TABLES.map((t) => t.name)].sort());
});

test('every table matches its declaration, column for column', () => {
  const store = memoryStore();
  try {
    const db = driverOf(store);
    // Per table, so a failure names the table rather than one giant diff.
    for (const t of TABLES) expect({ [t.name]: driftOf(db, t) }).toEqual({ [t.name]: [] });
  } finally {
    store.close();
  }
});

test('assertSchema REFUSES a column the manifest does not describe', () => {
  const store = memoryStore();
  try {
    const db = driverOf(store);
    expect(() => assertSchema(db)).not.toThrow();
    // Exactly the accident this exists to catch: a migration adds a column and
    // nobody adds it to the manifest.
    db.exec(`ALTER TABLE targets ADD COLUMN surprise TEXT`);
    expect(() => assertSchema(db)).toThrow(/targets\.surprise presence/);
  } finally {
    store.close();
  }
});

test('assertSchema REFUSES a column whose type or nullability drifted', () => {
  withDriver((db) => {
    db.exec(`CREATE TABLE accounts (pk TEXT PRIMARY KEY, username INTEGER NOT NULL)`);
    const drift = driftOf(db, ACCOUNTS);
    expect(drift).toContainEqual(
      expect.objectContaining({ column: 'username', field: 'type', expected: 'TEXT', got: 'INTEGER' }),
    );
    expect(drift).toContainEqual(
      expect.objectContaining({ column: 'username', field: 'notnull', expected: '0', got: '1' }),
    );
    // Everything the manifest declares but the table lacks is reported too.
    expect(drift.filter((d) => d.field === 'presence').length).toBeGreaterThan(10);
  });
});

// The DDL for a SHIPPED migration is frozen: an existing install ran this
// exact text, so a later edit to the def must not silently rewrite history.
// These two strings ARE migration 12. Changing a def so this test fails means
// writing a new ALTER migration, not editing the old one.
test('migration 12 generated exactly this DDL, and must keep generating it', () => {
  expect(ddl(TIMERS)).toBe(
    `CREATE TABLE timers (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  kind TEXT NOT NULL,
  reason TEXT NOT NULL,
  armed_at INTEGER NOT NULL,
  due_at INTEGER NOT NULL,
  base_ms INTEGER NOT NULL,
  noise_class TEXT NOT NULL,
  seed TEXT,
  cadence_ms INTEGER,
  last_run_at INTEGER,
  overdue_policy TEXT NOT NULL,
  generation INTEGER NOT NULL,
  span_id TEXT
);`,
  );
  expect(ddl(SPANS)).toBe(
    `CREATE TABLE spans (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  scope_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mode TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  outcome TEXT,
  reason TEXT,
  attrs TEXT NOT NULL
);`,
  );
  const twelve = MIGRATIONS[12];
  expect(twelve.id).toBe(12);
  expect(twelve.sql).toContain(ddl(TIMERS));
  expect(twelve.sql).toContain(ddl(SPANS));
  expect(twelve.sql).toContain('CREATE INDEX idx_timers_due ON timers(due_at)');
  expect(twelve.sql).toContain('CREATE INDEX idx_spans_name_outcome ON spans(name, outcome, started_at)');
});

// Migrations 15 and 16 shipped these four strings; the same freeze applies.
test('migrations 15 and 16 generated exactly this DDL, and must keep generating it', () => {
  expect(ddl(OWN_COUNTS)).toBe(
    `CREATE TABLE own_counts (
  at INTEGER PRIMARY KEY,
  followers INTEGER NOT NULL,
  following INTEGER NOT NULL
);`,
  );
  expect(ddl(FOLLOWER_CHANGES)).toBe(
    `CREATE TABLE follower_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_pk TEXT NOT NULL,
  delta INTEGER NOT NULL,
  lo INTEGER NOT NULL,
  hi INTEGER NOT NULL,
  source TEXT NOT NULL,
  found_at INTEGER NOT NULL
);`,
  );
  expect(ddl(SURFACE_DRIFT)).toBe(
    `CREATE TABLE surface_drift (
  signature TEXT PRIMARY KEY,
  surface_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  cls TEXT NOT NULL,
  path TEXT NOT NULL,
  detail TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  seen INTEGER NOT NULL DEFAULT 1,
  sample TEXT,
  hint_pattern TEXT,
  witnesses INTEGER NOT NULL DEFAULT 0,
  contradictions INTEGER NOT NULL DEFAULT 0,
  witness_keys TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL DEFAULT 'open',
  clean_reads INTEGER NOT NULL DEFAULT 0
);`,
  );
  expect(ddl(SURFACE_HEALTH)).toBe(
    `CREATE TABLE surface_health (
  day TEXT NOT NULL,
  surface_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  canonical INTEGER NOT NULL DEFAULT 0,
  normalized INTEGER NOT NULL DEFAULT 0,
  recovered INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  walls INTEGER NOT NULL DEFAULT 0,
  row_issues INTEGER NOT NULL DEFAULT 0,
  field_issues INTEGER NOT NULL DEFAULT 0,
  shadow_disagreed INTEGER NOT NULL DEFAULT 0,
  last_read_at INTEGER,
  last_ok_at INTEGER,
  last_fail_at INTEGER,
  PRIMARY KEY (day, surface_id, endpoint)
);`,
  );
  const [fifteen, sixteen] = [MIGRATIONS[15], MIGRATIONS[16]];
  expect([fifteen.id, sixteen.id]).toEqual([15, 16]);
  expect(fifteen.sql).toContain(ddl(OWN_COUNTS));
  expect(fifteen.sql).toContain(ddl(FOLLOWER_CHANGES));
  expect(sixteen.sql).toContain(ddl(SURFACE_DRIFT));
  expect(sixteen.sql).toContain(ddl(SURFACE_HEALTH));
});

test('migrations 14 to 17 are the review, growth-log, surface and feed-index steps, in order', () => {
  expect(MIGRATIONS.slice(14).map((m) => [m.id, m.name])).toEqual([
    [14, 'review-columns'],
    [15, 'growth-log'],
    [16, 'surface-health'],
    [17, 'feed-indexes'],
  ]);
});

test('generated DDL round-trips: a table built from a def matches the def', () => {
  withDriver((db) => {
    for (const def of [TIMERS, SPANS, OWN_COUNTS, FOLLOWER_CHANGES, SURFACE_DRIFT, SURFACE_HEALTH]) {
      db.exec(ddl(def));
      expect({ [def.name]: driftOf(db, def) }).toEqual({ [def.name]: [] });
    }
  });
});

test('upsertSql generates the four lists that must agree, from one list', () => {
  const sql = upsertSql(ACCOUNTS, { columns: ['pk', 'username'], conflict: ['pk'] });
  expect(sql).toBe(
    `INSERT INTO accounts (pk, username)
VALUES (@pk, @username)
ON CONFLICT(pk) DO UPDATE SET
  username = excluded.username`,
  );
  // An expression overrides the default `excluded.<col>` — how the COALESCE
  // and MIN defenses stop being hand-inlined folds.
  expect(
    upsertSql(ACCOUNTS, {
      columns: ['pk', 'followers'],
      conflict: ['pk'],
      expr: { followers: 'COALESCE(excluded.followers, accounts.followers)' },
    }),
  ).toContain('followers = COALESCE(excluded.followers, accounts.followers)');
  // A column that is not in the manifest is a typo, not a new column.
  expect(() => upsertSql(ACCOUNTS, { columns: ['nope'], conflict: ['pk'] })).toThrow(
    /not in the manifest/,
  );
});

test('a database migrated from scratch through the runner satisfies the manifest', () => {
  withDriver((db) => {
    runMigrations(db);
    expect(db.pragma('user_version')).toBe(MIGRATIONS.length);
    expect(() => assertSchema(db)).not.toThrow();
  });
});

test('the timers and spans tables carry their indexes', () => {
  const store = memoryStore();
  try {
    const indexes = driverOf(store)
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL`)
      .all<{ name: string }>()
      .map((r) => r.name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_timers_due',
        'idx_timers_owner',
        'idx_spans_name_outcome',
        'idx_spans_parent',
        'idx_follower_changes_hi',
        'idx_follower_changes_pk',
        'idx_surface_drift_open',
        'idx_edges_dst_status_first_seen',
        'idx_effect_state_settled',
      ]),
    );
  } finally {
    store.close();
  }
});

test('opening a store twice is idempotent — migrations and the assertion both', () => {
  const db = openDatabase(':memory:');
  try {
    runMigrations(db);
    runMigrations(db);
    expect(db.pragma('user_version')).toBe(MIGRATIONS.length);
    expect(() => assertSchema(db)).not.toThrow();
  } finally {
    db.close();
  }
});
