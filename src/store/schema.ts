import { SPANS, TIMERS } from './schema/manifest';
import type { Migration } from './schema/migration-types';
import { REENTRY_MIGRATION } from './schema/reentry-migration';
import { ddl } from './schema/tables';

/**
 * Versioned schema for the knowledge graph.
 *
 * `MIGRATIONS[i].sql` upgrades the database from `user_version === i` to
 * `user_version === i + 1`; `id` restates that index so the binding is data the
 * runner checks (`runMigrations` refuses a mismatch) rather than a comment
 * nobody recounts. Migrations are APPEND-ONLY: never edit, reorder, or
 * renumber a shipped entry — add a new one.
 */
export type { Migration } from './schema/migration-types';

export const MIGRATIONS: Migration[] = [
  {
    id: 0,
    name: 'initial knowledge-graph schema',
    sql: `
    -- Append-only event log: the source of truth from which projections are folded.
    CREATE TABLE observations (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      account_pk   TEXT    NOT NULL,
      observed_at  INTEGER NOT NULL,
      source       TEXT    NOT NULL,
      confidence   INTEGER NOT NULL,
      field_set    TEXT    NOT NULL   -- JSON-encoded AccountFields
    );
    CREATE INDEX idx_observations_account_at ON observations(account_pk, observed_at);

    -- Projection of current best-known account state.
    CREATE TABLE accounts (
      pk                TEXT PRIMARY KEY,
      username          TEXT,
      enrichment        TEXT    NOT NULL DEFAULT 'stub',
      followers         INTEGER,
      following         INTEGER,
      ratio             REAL,
      is_private        INTEGER,   -- 0/1 nullable
      is_verified       INTEGER,   -- 0/1 nullable
      activity_signal   REAL,
      role              TEXT,
      stats_observed_at INTEGER,
      stats_source      TEXT,
      first_seen_at     INTEGER NOT NULL,
      last_seen_at      INTEGER NOT NULL
    );
    CREATE INDEX idx_accounts_role  ON accounts(role);
    CREATE INDEX idx_accounts_ratio ON accounts(ratio);

    -- Usernames change over time; keep the history.
    CREATE TABLE username_history (
      pk        TEXT    NOT NULL,
      username  TEXT    NOT NULL,
      seen_at   INTEGER NOT NULL
    );
    CREATE INDEX idx_username_history_pk ON username_history(pk);

    -- Directed relationship edges with lifecycle. Follow-back = reciprocal active edges.
    CREATE TABLE edges (
      src_pk           TEXT    NOT NULL,
      dst_pk           TEXT    NOT NULL,
      type             TEXT    NOT NULL,
      first_seen_at    INTEGER NOT NULL,
      last_confirmed_at INTEGER NOT NULL,
      status           TEXT    NOT NULL,   -- 'active' | 'removed'
      PRIMARY KEY (src_pk, dst_pk, type)
    );
    CREATE INDEX idx_edges_dst ON edges(dst_pk, type, status);

    -- Churn lifecycle records.
    CREATE TABLE follow_records (
      account_pk       TEXT    PRIMARY KEY,
      state            TEXT    NOT NULL,
      followed_at      INTEGER,
      followed_back_at INTEGER,
      hold_until       INTEGER,
      unfollow_due_at  INTEGER,
      retry_count      INTEGER NOT NULL DEFAULT 0,
      target_pk        TEXT
    );

    -- Chain targets; yield stats computed on demand from edges/observations/follow_records.
    CREATE TABLE targets (
      account_pk   TEXT    PRIMARY KEY,
      source       TEXT    NOT NULL,   -- seed | discovered | own_followers
      status       TEXT    NOT NULL,   -- active | exhausted | retained
      chain_index  INTEGER
    );

    -- Append-only durable action ledger: source of truth for the rate governor.
    CREATE TABLE action_ledger (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      account_pk  TEXT    NOT NULL,
      action      TEXT    NOT NULL,   -- follow | unfollow
      at          INTEGER NOT NULL,
      result      TEXT    NOT NULL    -- ok | fail
    );
    CREATE INDEX idx_action_ledger_at ON action_ledger(at);

    -- Rolling Instagram-request log for the request-budget governor.
    CREATE TABLE request_log (
      id  INTEGER PRIMARY KEY AUTOINCREMENT,
      at  INTEGER NOT NULL
    );
    CREATE INDEX idx_request_log_at ON request_log(at);
    `,
  },

  {
    id: 1,
    name: 'per-target scrape cursor',
    // Persist the followers-list resume cursor (`next_max_id`) per target so a scrape
    // can resume across sessions instead of re-scrolling from the top.
    sql: `
    CREATE TABLE scrape_cursors (
      target_pk   TEXT    PRIMARY KEY,
      cursor      TEXT,
      updated_at  INTEGER NOT NULL
    );
    `,
  },

  {
    id: 2,
    name: 'auto-prune ledger',
    // The prune routine's OWN durable daily-cap ledger, independent of the growth
    // engine's action_ledger.
    sql: `
    CREATE TABLE prune_ledger (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      account_pk  TEXT    NOT NULL,
      at          INTEGER NOT NULL,
      result      TEXT    NOT NULL   -- ok | fail | simulated
    );
    CREATE INDEX idx_prune_ledger_at ON prune_ledger(at);
    `,
  },

  {
    id: 3,
    name: 'durable prune scan snapshot',
    // The latest COMPLETED prune scan (singleton meta row) plus its not-yet-visited
    // candidates, so a restart restores the census counts and the reviewed runnable
    // set instead of resetting the prune panel to zeros. The candidates table is
    // consumed row-by-row as a run visits each account, so a mid-run quit leaves
    // exactly the unvisited remainder.
    sql: `
    CREATE TABLE prune_scan (
      id              INTEGER PRIMARY KEY CHECK (id = 1),   -- singleton row
      at              INTEGER NOT NULL,
      following_count INTEGER NOT NULL,
      followers_count INTEGER NOT NULL,
      candidate_count INTEGER NOT NULL
    );
    CREATE TABLE prune_scan_remaining (
      pk        TEXT PRIMARY KEY,
      username  TEXT
    );
    `,
  },

  {
    id: 4,
    name: 'drop the request-budget log',
    // The request-budget governor was removed (request volume is not a ban vector
    // Instagram meters this way); its rolling log is dead weight. The table stays
    // in migration 0 for fresh DBs and is dropped right here.
    sql: `
    DROP TABLE IF EXISTS request_log;
    `,
  },

  {
    id: 5,
    name: 'durable key/value meta',
    // First use: `followers_baseline_at` — the moment of the FIRST complete
    // followers census. Everything known at that moment is pre-existing STOCK,
    // not growth; the net-growth series only counts edge events after it (so an
    // initial census can never render as "+3000 followers in one day").
    sql: `
    CREATE TABLE meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    `,
  },

  {
    id: 6,
    name: 'mutual-follower count',
    // `mutuals` = how many accounts WE follow also follow this one (the profile
    // header's "followed by x and N others"), captured by profile-info enrichment.
    // A strong follow-back predictor the Scorer weights heavily.
    sql: `
    ALTER TABLE accounts ADD COLUMN mutuals INTEGER;
    `,
  },

  {
    id: 7,
    name: 'persisted candidate score',
    // The Scorer's composite score, stored ON the follow_record so the queue's
    // EXECUTION order (nextDue) and DISPLAY order (queue list) both honor it —
    // the best candidate is followed and shown first. Higher = better; nullable
    // for records created outside the Scanner.
    sql: `
    ALTER TABLE follow_records ADD COLUMN score REAL;
    CREATE INDEX idx_follow_records_state_score ON follow_records(state, score);
    `,
  },

  {
    id: 8,
    name: 'enrichment-failure marker + hot-query indexes',
    // `enrich_failed_at`: stamped when a profile-enrichment fetch returns a
    // PERMANENTLY unusable body (deleted/suspended/unparseable account), so the
    // enrichment batch selector skips it — without this, ~20 dead accounts at the
    // head of a pool consume every enrichment pass of every refill cycle and the
    // fresh candidates behind them are never reached. Transient failures (rate
    // wall, sentinel) never stamp it.
    // The two indexes cover the hottest un-indexed reads: pkByUsername's
    // case-insensitive lookup and the per-target follow_record scans
    // (queuedCountFor / targetYield).
    sql: `
    ALTER TABLE accounts ADD COLUMN enrich_failed_at INTEGER;
    CREATE INDEX idx_accounts_username_nocase ON accounts(username COLLATE NOCASE);
    CREATE INDEX idx_follow_records_target ON follow_records(target_pk);
    `,
  },

  {
    id: 9,
    name: 'profile bio text',
    // NULL = never observed; '' = fetched and genuinely empty — the distinction
    // is what lets the prune engine know whether a fetch is still needed.
    sql: `
    ALTER TABLE accounts ADD COLUMN bio TEXT;
    `,
  },

  {
    id: 10,
    name: 'evidence-stamped target exhaustion',
    // `exhausted_at`: WHEN the chain concluded a target's pool was drained — the
    // fact that makes the 'exhausted' verdict reversible. The engine's chain
    // dead-end self-heal re-verifies only targets stamped within a recent window
    // (a rate-wall outage must not permanently burn live targets). NULL on a
    // deliberate retirement (restart-from-seed), which is never auto-revived.
    sql: `
    ALTER TABLE targets ADD COLUMN exhausted_at INTEGER;
    `,
  },

  {
    id: 11,
    name: 'requeue-healer stamps on follow_records',
    // `abandoned_at`: WHEN the record last transitioned INTO 'abandoned' (stamped
    // by the churn scheduler going forward; NULL on rows abandoned before this
    // shipped) — the fact that lets the recovery healer place an abandonment
    // inside a closed systemic-incident window instead of guessing.
    // `healed_at`: WHEN the healer requeued this record after such a window
    // closed. Non-NULL means the record has spent its ONE heal — it can never be
    // healed twice, however many later windows overlap it. Both are stamps on the
    // existing row, never rewrites of the ledger: the spurious fail rows the
    // incident wrote remain exactly as recorded.
    sql: `
    ALTER TABLE follow_records ADD COLUMN abandoned_at INTEGER;
    ALTER TABLE follow_records ADD COLUMN healed_at INTEGER;
    `,
  },

  {
    id: 12,
    name: 'durable timers and spans',
    // `timers`: every deadline, hold and cadence as one durable row, so
    // "schedules are durable" (docs/PRINCIPLES.md §3) becomes a property of
    // `chronos.due(now)` rather than a rule each caller re-implements against
    // its own meta key. `due_at` is ABSOLUTE with noise already applied, so a
    // relaunch mid-hold serves the REMAINDER, and work that came due while the
    // app was closed comes back oldest-first.
    // `spans`: the cause chain — one row per unit of work, `parent_id` linking
    // a refusal to the tick that caused it, and the measured durations the
    // derived timeouts and poll intervals are fitted to.
    // Both tables' DDL is GENERATED from their defs in `schema/tables.ts`
    // (they are new, so there is no history to rewrite); a test pins this
    // string so a later edit to a def cannot silently change shipped SQL.
    sql: `
    ${ddl(TIMERS)}
    CREATE INDEX idx_timers_due ON timers(due_at);
    CREATE INDEX idx_timers_owner ON timers(owner);

    ${ddl(SPANS)}
    CREATE INDEX idx_spans_name_outcome ON spans(name, outcome, started_at);
    CREATE INDEX idx_spans_parent ON spans(parent_id);
    `,
  },
  REENTRY_MIGRATION,
];
