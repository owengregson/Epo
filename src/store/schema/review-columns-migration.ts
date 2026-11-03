import type { Migration } from './migration-types';

/**
 * Append-only migration 14: the review columns. `follow_records` gains the kept
 * state's reason, match and stamp, the shared re-check columns (`recheck_at` =
 * earliest next Instagram read, `check_failures` = consecutive unreadable or
 * unreachable observations), the park reason and the follow-back dating bound;
 * `effect_intents` gains its attempt count and next attempt.
 */
export const REVIEW_COLUMNS_MIGRATION: Migration = {
  id: 14,
  name: 'review-columns',
  sql: `
    ALTER TABLE follow_records ADD COLUMN kept_reason TEXT;
    ALTER TABLE follow_records ADD COLUMN kept_match TEXT;
    ALTER TABLE follow_records ADD COLUMN kept_at INTEGER;
    ALTER TABLE follow_records ADD COLUMN recheck_at INTEGER;
    ALTER TABLE follow_records ADD COLUMN park_reason TEXT;
    ALTER TABLE follow_records ADD COLUMN check_failures INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE follow_records ADD COLUMN followback_after INTEGER;
    ALTER TABLE effect_intents ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE effect_intents ADD COLUMN next_attempt_at INTEGER;
    `,
};
