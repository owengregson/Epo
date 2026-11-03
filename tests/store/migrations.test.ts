/**
 * The migration list's own invariants: ids are positions, the runner refuses a
 * renumbered list, and it refuses a database written by a newer build.
 */

import { openDatabase } from '@/store/driver/index';
import { runMigrations } from '@/store/migrations';
import { MIGRATIONS } from '@/store/schema';
import { assertSchema } from '@/store/schema/manifest';
import { driverOf } from '../kit/store-driver';
import { LATEST_SCHEMA_VERSION, withLegacyDb } from '../kit/store-legacy-db';

test('a database at schema 13 upgrades through migrations 13–17 and satisfies the manifest', () => {
  withLegacyDb(13, (legacy) => {
    const store = legacy.open();
    expect(legacy.schemaVersion()).toBe(LATEST_SCHEMA_VERSION);
    expect(LATEST_SCHEMA_VERSION).toBe(18);
    expect(() => assertSchema(driverOf(store))).not.toThrow();
  });
});

test('rows written before migration 14 read the review columns as their defaults', () => {
  withLegacyDb(14, (legacy) => {
    legacy.raw.exec(`INSERT INTO follow_records (account_pk, state, retry_count)
      VALUES ('p1', 'pending_followback', 0)`);
    legacy.raw.exec(`INSERT INTO effect_intents
      (id, account_pk, username, action, channel, state, created_at)
      VALUES ('i1', 'p1', 'one', 'unfollow', 'growth', 'prepared', 5)`);
    const db = driverOf(legacy.open());
    expect(
      db.prepare(`SELECT kept_reason, kept_match, kept_at, recheck_at, park_reason,
        check_failures, followback_after FROM follow_records`).get(),
    ).toEqual({
      kept_reason: null, kept_match: null, kept_at: null, recheck_at: null,
      park_reason: null, check_failures: 0, followback_after: null,
    });
    expect(db.prepare(`SELECT attempts, next_attempt_at FROM effect_intents`).get()).toEqual({
      attempts: 0, next_attempt_at: null,
    });
  });
});

test('every migration declares its own index as its id, with a name', () => {
  MIGRATIONS.forEach((m, i) => {
    expect(m.id).toBe(i);
    expect(m.name.length).toBeGreaterThan(0);
    expect(m.sql.trim().length).toBeGreaterThan(0);
  });
});

test('runMigrations refuses a list whose ids no longer match their positions', () => {
  const db = openDatabase(':memory:');
  const original = MIGRATIONS[0];
  // Simulate the exact accident the assertion exists to catch: a shipped entry
  // renumbered (or a new one inserted ahead of it).
  MIGRATIONS[0] = { ...original, id: 1 };
  try {
    expect(() => runMigrations(db)).toThrow(/append-only/);
  } finally {
    MIGRATIONS[0] = original;
    db.close();
  }
});

test('runMigrations refuses a database from a newer build', () => {
  const db = openDatabase(':memory:');
  try {
    db.pragma('user_version', MIGRATIONS.length + 1);
    expect(() => runMigrations(db)).toThrow(/newer than this build supports/);
  } finally {
    db.close();
  }
});

test('runMigrations is idempotent once the database is at head', () => {
  const db = openDatabase(':memory:');
  try {
    runMigrations(db);
    expect(db.pragma('user_version')).toBe(MIGRATIONS.length);
    // A second pass must be a no-op, not a re-application of the final entry.
    runMigrations(db);
    expect(db.pragma('user_version')).toBe(MIGRATIONS.length);
  } finally {
    db.close();
  }
});
