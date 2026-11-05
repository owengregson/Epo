/**
 * Driver-level helpers for store suites.
 *
 * Reaching past the facade is normally the wrong move, but three kinds of
 * assertion genuinely need the handle: that the manifest describes the REAL
 * table shape, that drift is refused, and that the driver port itself behaves
 * the same on both engines. Everything else goes through `KnowledgeStore`.
 */

import type { SqliteDriver } from '@/store/driver/driver';
import { openDatabase } from '@/store/driver/index';
import type { KnowledgeStore } from '@/store/knowledge-store';

/** The driver a store opened — for `PRAGMA` and raw-shape assertions only. */
export const driverOf = (store: KnowledgeStore): SqliteDriver =>
  (store as unknown as { db: SqliteDriver }).db;

/** A bare `:memory:` driver (no migrations), always closed. */
export const withDriver = <T>(fn: (db: SqliteDriver) => T): T => {
  const db = openDatabase(':memory:');
  try {
    return fn(db);
  } finally {
    db.close();
  }
};

/** A clock a suite can advance by hand, plus a deterministic uniform source. */
export const fakeClock = (start = 1_000_000) => {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
      return t;
    },
    set: (ms: number) => {
      t = ms;
      return t;
    },
    at: () => t,
  };
};

/** A fixed-sequence uniform source, so a drawn id or seed is pinned. */
export const seededRng = (seed = 42) => {
  let s = seed >>> 0;
  return (): number => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
};
