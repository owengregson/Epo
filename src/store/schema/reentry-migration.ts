import type { Migration } from './migration-types';

/** Append-only migration 13; kept separate to preserve shipped migration text. */
export const REENTRY_MIGRATION: Migration = {
    id: 13,
    name: 'reconciliation evidence and durable mutation intents',
    sql: `
    ALTER TABLE follow_records ADD COLUMN reconciled_at INTEGER;
    ALTER TABLE follow_records ADD COLUMN followback_observed_at INTEGER;
    ALTER TABLE follow_records ADD COLUMN unfollow_reason TEXT;
    ALTER TABLE follow_records ADD COLUMN queued_at INTEGER;
    ALTER TABLE follow_records ADD COLUMN decision_version TEXT;
    CREATE TABLE effect_intents (
      id TEXT PRIMARY KEY,
      account_pk TEXT NOT NULL,
      username TEXT NOT NULL,
      action TEXT NOT NULL,
      channel TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      dispatched_at INTEGER,
      settled_at INTEGER,
      result TEXT,
      ledger TEXT
    );
    CREATE UNIQUE INDEX idx_effect_pending ON effect_intents(account_pk, action, channel)
      WHERE state <> 'settled';
    CREATE INDEX idx_effect_state ON effect_intents(state, created_at);
    `,
  };
