import type { Migration } from './migration-types';
import { col, ddl, table } from './tables';

/** Every own-header observation: the followers and following counts Instagram showed at `at`. */
export const OWN_COUNTS = table('own_counts', {
  at: col.int().key(),
  followers: col.int(),
  following: col.int(),
});

/**
 * One row per transition of an own-follower edge (`+1` none/removed → active,
 * `−1` active → removed), dated by the interval `[lo, hi]` the change is known
 * to fall in; `found_at` is when Epo learned of it.
 */
export const FOLLOWER_CHANGES = table('follower_changes', {
  id: col.int().autoId(),
  account_pk: col.text(),
  delta: col.int(),
  lo: col.int(),
  hi: col.int(),
  source: col.text(),
  found_at: col.int(),
});

/**
 * Append-only migration 15: the follower change log and the own header series.
 * The DDL is generated from the defs above; `tables.test.ts` pins its text.
 */
export const GROWTH_LOG_MIGRATION: Migration = {
  id: 15,
  name: 'growth-log',
  sql: `
    ${ddl(OWN_COUNTS)}

    ${ddl(FOLLOWER_CHANGES)}
    CREATE INDEX idx_follower_changes_hi ON follower_changes(hi);
    CREATE INDEX idx_follower_changes_pk ON follower_changes(account_pk, hi);
    `,
};
