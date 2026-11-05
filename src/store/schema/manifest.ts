/**
 * The tables themselves — every column of every table, declared once.
 *
 * `./tables.ts` is the ALGEBRA (column constructors, codecs, `ddl()`,
 * `upsertSql()`, `driftOf()`); this file is the DECLARATION it operates on.
 * The split is what keeps the algebra free of any particular table, and it is
 * the reason the dependency runs one way only: manifest → algebra, never back.
 *
 * Every column here restates what the MIGRATIONS actually built, because
 * `assertSchema` compares this file against `PRAGMA table_info` at open. Two
 * SQLite reporting quirks are therefore load-bearing and are folded into the
 * declaration rather than worked around at the comparison:
 *
 *  - A single-column PRIMARY KEY declared inline (`pk TEXT PRIMARY KEY`) is
 *    reported NULLABLE. `table()` normalises that, so `key()` is all a column
 *    needs to say.
 *  - `INTEGER PRIMARY KEY AUTOINCREMENT` is a rowid alias, reported nullable
 *    and non-autoincrement-agnostic — that is `autoId()`.
 *
 * `request_log` is deliberately absent: migration 0 created it and migration 4
 * dropped it, so it is history, not shape.
 */

import type { SqliteDriver } from '../driver/driver';
import type { EdgeType, EnrichmentLevel, FollowState, Source, Target } from '../types';
import { FOLLOWER_CHANGES, OWN_COUNTS } from './growth-log-migration';
import { SURFACE_DRIFT, SURFACE_HEALTH } from './surface-tables';
import { col, driftOf, type TableDef, table } from './tables';

/** Append-only event log: the source of truth projections are folded from. */
export const OBSERVATIONS = table('observations', {
  id: col.int().autoId(),
  account_pk: col.text(),
  observed_at: col.int(),
  source: col.text<Source>(),
  confidence: col.int(),
  /** JSON-encoded `AccountFields`. */
  field_set: col.text(),
});

/** Projection of current best-known account state. */
export const ACCOUNTS = table('accounts', {
  pk: col.text().key(),
  username: col.optText(),
  enrichment: col.text<EnrichmentLevel>().def(`'stub'`),
  followers: col.optInt(),
  following: col.optInt(),
  ratio: col.optReal(),
  is_private: col.bool(),
  is_verified: col.bool(),
  activity_signal: col.optReal(),
  role: col.optText(),
  stats_observed_at: col.optInt(),
  stats_source: col.optText<Source>(),
  first_seen_at: col.int(),
  last_seen_at: col.int(),
  // Added by later migrations, and therefore reported LAST by `table_info`
  // (6: mutuals, 8: enrich_failed_at, 9: bio). Order does not affect drift,
  // but keeping it honest means the declaration reads like the real table.
  mutuals: col.optInt(),
  enrich_failed_at: col.optInt(),
  bio: col.optText(),
});

/** Usernames change over time; the history is kept rather than overwritten. */
export const USERNAME_HISTORY = table('username_history', {
  pk: col.text(),
  username: col.text(),
  seen_at: col.int(),
});

/** Directed relationship edges with lifecycle; a follow-back is two active ones. */
export const EDGES = table('edges', {
  src_pk: col.text().key(1),
  dst_pk: col.text().key(2),
  type: col.text<EdgeType>().key(3),
  first_seen_at: col.int(),
  last_confirmed_at: col.int(),
  status: col.text<'active' | 'removed'>(),
});

/** The churn lifecycle, one row per account we have acted on. */
export const FOLLOW_RECORDS = table('follow_records', {
  account_pk: col.text().key(),
  state: col.text<FollowState>(),
  followed_at: col.optInt(),
  followed_back_at: col.optInt(),
  hold_until: col.optInt(),
  unfollow_due_at: col.optInt(),
  retry_count: col.int().def('0'),
  target_pk: col.optText(),
  /** The Scorer's composite; NULL for records created outside the Scanner. */
  score: col.optReal(),
  abandoned_at: col.optInt(),
  healed_at: col.optInt(),
  reconciled_at: col.optInt(),
  followback_observed_at: col.optInt(),
  unfollow_reason: col.optText(),
  queued_at: col.optInt(),
  decision_version: col.optText(),
  // Migration 14: the kept state, the shared re-check columns, parks and follow-back dating.
  kept_reason: col.optText(),
  kept_match: col.optText(),
  kept_at: col.optInt(),
  recheck_at: col.optInt(),
  park_reason: col.optText(),
  check_failures: col.int().def('0'),
  followback_after: col.optInt(),
});

export const EFFECT_INTENTS = table('effect_intents', {
  id: col.text().key(),
  account_pk: col.text(),
  username: col.text(),
  action: col.text(),
  channel: col.text(),
  state: col.text(),
  created_at: col.int(),
  dispatched_at: col.optInt(),
  settled_at: col.optInt(),
  result: col.optText(),
  ledger: col.optText(),
  attempts: col.int().def('0'),
  next_attempt_at: col.optInt(),
});

/** Nodes of the chain. Yield stats are computed on demand, never stored. */
export const TARGETS = table('targets', {
  account_pk: col.text().key(),
  source: col.text<Target['source']>(),
  status: col.text<Target['status']>(),
  chain_index: col.optInt(),
  exhausted_at: col.optInt(),
});

/** Append-only durable action ledger: the rate governor's source of truth. */
export const ACTION_LEDGER = table('action_ledger', {
  id: col.int().autoId(),
  account_pk: col.text(),
  action: col.text<'follow' | 'unfollow'>(),
  at: col.int(),
  result: col.text<'ok' | 'fail'>(),
});

/** The followers-list resume cursor (`next_max_id`) per target. */
export const SCRAPE_CURSORS = table('scrape_cursors', {
  target_pk: col.text().key(),
  cursor: col.optText(),
  updated_at: col.int(),
});

/** The prune routine's OWN daily-cap ledger, independent of `action_ledger`. */
export const PRUNE_LEDGER = table('prune_ledger', {
  id: col.int().autoId(),
  account_pk: col.text(),
  at: col.int(),
  result: col.text<'ok' | 'fail' | 'simulated'>(),
});

/**
 * The latest COMPLETED prune scan, as a singleton row. The live table carries
 * `CHECK (id = 1)`, which `table_info` does not report and `ddl()` therefore
 * cannot regenerate — migration 3 owns that text, and this table is never a
 * `ddl()` argument.
 */
export const PRUNE_SCAN = table('prune_scan', {
  id: col.int().key(),
  at: col.int(),
  following_count: col.int(),
  followers_count: col.int(),
  candidate_count: col.int(),
});

/** Scan candidates a run has not visited yet; consumed row by row. */
export const PRUNE_SCAN_REMAINING = table('prune_scan_remaining', {
  pk: col.text().key(),
  username: col.optText(),
});

/** Durable key/value meta — first use: `followers_baseline_at`. */
export const META = table('meta', {
  key: col.text().key(),
  value: col.text(),
});

/**
 * Every deadline, hold and cadence as one durable row (ADR: docs/PRINCIPLES.md
 * §3). `due_at` is ABSOLUTE with noise already applied.
 *
 * FROZEN: migration 12 shipped `ddl(TIMERS)`, so this declaration's generated
 * text is history. A change here means a new ALTER migration, never an edit.
 */
export const TIMERS = table('timers', {
  id: col.text().key(),
  owner: col.text(),
  kind: col.text(),
  reason: col.text(),
  armed_at: col.int(),
  due_at: col.int(),
  base_ms: col.int(),
  noise_class: col.text(),
  seed: col.optText(),
  cadence_ms: col.optInt(),
  last_run_at: col.optInt(),
  overdue_policy: col.text(),
  generation: col.int(),
  span_id: col.optText(),
});

/**
 * The cause chain: one row per unit of work, `parent_id` linking a refusal to
 * the tick that caused it.
 *
 * FROZEN for the same reason as {@link TIMERS} — migration 12 shipped it.
 */
export const SPANS = table('spans', {
  id: col.text().key(),
  parent_id: col.optText(),
  scope_id: col.text(),
  name: col.text(),
  mode: col.text(),
  started_at: col.int(),
  ended_at: col.optInt(),
  outcome: col.optText(),
  reason: col.optText(),
  /** JSON; `{}` when the span carries nothing. */
  attrs: col.text(),
});

/**
 * THE manifest. A migrated database has exactly these tables — a test asserts
 * that both ways, so a new migration that forgets to declare its table fails
 * before the shape can be read by anything.
 */
export const TABLES: readonly TableDef[] = [
  OBSERVATIONS,
  ACCOUNTS,
  USERNAME_HISTORY,
  EDGES,
  FOLLOW_RECORDS,
  TARGETS,
  ACTION_LEDGER,
  SCRAPE_CURSORS,
  PRUNE_LEDGER,
  PRUNE_SCAN,
  PRUNE_SCAN_REMAINING,
  META,
  TIMERS,
  SPANS,
  EFFECT_INTENTS,
  OWN_COUNTS,
  FOLLOWER_CHANGES,
  SURFACE_DRIFT,
  SURFACE_HEALTH,
];

/**
 * The boot-time assertion, over EVERY table. A migration that adds a column
 * without adding it to the manifest fails at OPEN — loudly and immediately —
 * instead of at whatever runtime read first meets the unknown shape.
 */
export const assertSchema = (db: SqliteDriver, tables: readonly TableDef[] = TABLES): void => {
  const drift = tables.flatMap((t) => driftOf(db, t));
  if (drift.length === 0) return;
  const detail = drift
    .map((d) => `${d.table}.${d.column} ${d.field}: expected ${d.expected}, got ${d.got}`)
    .join('; ');
  throw new Error(`store: schema does not match the table manifest — ${detail}`);
};
