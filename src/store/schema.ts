/**
 * Versioned schema for the knowledge graph.
 *
 * `MIGRATIONS[i]` is the SQL that upgrades the database from `user_version === i`
 * to `user_version === i + 1`. Migrations are append-only: never edit an existing
 * entry once shipped — add a new one. The migration runner (see `migrations.ts`)
 * applies each pending migration inside a transaction and bumps `user_version`.
 */
export const MIGRATIONS: string[] = [
  // --- Migration 0: initial knowledge-graph schema ------------------------------
  `
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

  -- Churn lifecycle records (§3.4).
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

  // --- Migration 1: per-target scrape cursor (R4) -------------------------------
  // Persist the followers-list resume cursor (`next_max_id`) per target so a scrape
  // can resume across sessions instead of re-scrolling from the top (kills the
  // dead-cursor debt). Append-only: never edit migration 0 above.
  `
  CREATE TABLE scrape_cursors (
    target_pk   TEXT    PRIMARY KEY,
    cursor      TEXT,
    updated_at  INTEGER NOT NULL
  );
  `,

  // --- Migration 2: auto-prune ledger (Phase 5) ----------------------------------
  // The prune routine's OWN durable daily-cap ledger, independent of the growth
  // engine's action_ledger. Append-only: never edit the migrations above.
  `
  CREATE TABLE prune_ledger (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    account_pk  TEXT    NOT NULL,
    at          INTEGER NOT NULL,
    result      TEXT    NOT NULL   -- ok | fail | simulated
  );
  CREATE INDEX idx_prune_ledger_at ON prune_ledger(at);
  `,

  // --- Migration 3: durable prune scan snapshot -----------------------------------
  // The latest COMPLETED prune scan (singleton meta row) plus its not-yet-visited
  // candidates, so a restart restores the census counts and the reviewed runnable
  // set instead of resetting the prune panel to zeros. The candidates table is
  // consumed row-by-row as a run visits each account, so a mid-run quit leaves
  // exactly the unvisited remainder. Append-only: never edit the migrations above.
  `
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
  // --- Migration 4: drop the request-budget log ---------------------------------
  // The request-budget governor was removed (request volume is not a ban vector
  // Instagram meters this way); its rolling log is dead weight. Append-only:
  // the table stays in migration 0 for fresh DBs and is dropped right here.
  `
  DROP TABLE IF EXISTS request_log;
  `,

  // --- Migration 5: durable key/value meta ---------------------------------------
  // First use: `followers_baseline_at` — the moment of the FIRST complete
  // followers census. Everything known at that moment is pre-existing STOCK,
  // not growth; the net-growth series only counts edge events after it (so an
  // initial census can never render as "+3000 followers in one day").
  `
  CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,

  // --- Migration 6: mutual-follower count ------------------------------------------
  // `mutuals` = how many accounts WE follow also follow this one (the profile
  // header's "followed by x and N others"), captured by profile-info enrichment.
  // A strong follow-back predictor the Scorer weights heavily. Append-only:
  // never edit the migrations above.
  `
  ALTER TABLE accounts ADD COLUMN mutuals INTEGER;
  `,

  // --- Migration 7: persisted candidate score --------------------------------------
  // The Scorer's composite score, stored ON the follow_record so the queue's
  // EXECUTION order (nextDue) and DISPLAY order (queue list) both honor it —
  // the best candidate is followed and shown first. Before this, the score was
  // computed at scan time then discarded, so ordering fell back to account_pk /
  // insertion order (the "improperly sorted" bug). Higher = better; nullable for
  // records created outside the Scanner. Append-only: never edit the above.
  `
  ALTER TABLE follow_records ADD COLUMN score REAL;
  CREATE INDEX idx_follow_records_state_score ON follow_records(state, score);
  `,

  // --- Migration 8: enrichment-failure marker + hot-query indexes -------------------
  // `enrich_failed_at`: stamped when a profile-enrichment fetch returns a
  // PERMANENTLY unusable body (deleted/suspended/unparseable account), so the
  // enrichment batch selector skips it — without this, ~20 dead accounts at the
  // head of a pool consume every enrichment pass of every refill cycle and the
  // fresh candidates behind them are never reached. Transient failures (rate
  // wall, sentinel) never stamp it.
  // The two indexes cover the hottest un-indexed reads: pkByUsername's
  // case-insensitive lookup and the per-target follow_record scans
  // (queuedCountFor / targetYield).
  `
  ALTER TABLE accounts ADD COLUMN enrich_failed_at INTEGER;
  CREATE INDEX idx_accounts_username_nocase ON accounts(username COLLATE NOCASE);
  CREATE INDEX idx_follow_records_target ON follow_records(target_pk);
  `,

  // --- Migration: profile bio text (the fact behind the prune bio filter).
  // NULL = never observed; '' = fetched and genuinely empty — the distinction
  // is what lets the prune engine know whether a fetch is still needed.
  `
  ALTER TABLE accounts ADD COLUMN bio TEXT;
  `,

  // --- Migration: evidence-stamped target exhaustion --------------------------------
  // `exhausted_at`: WHEN the chain concluded a target's pool was drained — the
  // fact that makes the 'exhausted' verdict reversible. The engine's chain
  // dead-end self-heal re-verifies only targets stamped within a recent window
  // (a rate-wall outage must not permanently burn live targets). NULL on a
  // deliberate retirement (restart-from-seed), which is never auto-revived.
  // Append-only: never edit the migrations above.
  `
  ALTER TABLE targets ADD COLUMN exhausted_at INTEGER;
  `,
];
