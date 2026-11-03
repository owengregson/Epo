import type { Migration } from './migration-types';
import { SURFACE_DRIFT, SURFACE_HEALTH } from './surface-tables';
import { ddl } from './tables';

/**
 * Append-only migration 16: persisted drift signatures and per-plan-day surface
 * health. The DDL is generated from `surface-tables.ts`; `tables.test.ts` pins it.
 */
export const SURFACE_MIGRATION: Migration = {
  id: 16,
  name: 'surface-health',
  sql: `
    ${ddl(SURFACE_DRIFT)}
    CREATE INDEX idx_surface_drift_open ON surface_drift(surface_id, state, last_seen_at);

    ${ddl(SURFACE_HEALTH)}
    `,
};
