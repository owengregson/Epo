/**
 * The migration list's own invariants: ids are positions, the runner refuses a
 * renumbered list, and it refuses a database written by a newer build.
 */

import { openDatabase } from '@/store/driver/index';
import { runMigrations } from '@/store/migrations';
import { MIGRATIONS } from '@/store/schema';

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
