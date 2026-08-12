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
];
