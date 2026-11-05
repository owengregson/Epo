import type { Migration } from './migration-types';

/**
 * Append-only migration 17: the indexes the live feed reads walk (new followers
 * by first sight, settled effects by settlement time).
 */
export const FEED_INDEX_MIGRATION: Migration = {
  id: 17,
  name: 'feed-indexes',
  sql: `
    CREATE INDEX IF NOT EXISTS idx_edges_dst_status_first_seen ON edges(dst_pk, type, status, first_seen_at);
    CREATE INDEX IF NOT EXISTS idx_effect_state_settled ON effect_intents(state, settled_at);
    `,
};
