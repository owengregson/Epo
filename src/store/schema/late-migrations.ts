import { FEED_INDEX_MIGRATION } from './feed-index-migration';
import { GROWTH_LOG_MIGRATION } from './growth-log-migration';
import type { Migration } from './migration-types';
import { REENTRY_MIGRATION } from './reentry-migration';
import { REVIEW_COLUMNS_MIGRATION } from './review-columns-migration';
import { SURFACE_MIGRATION } from './surface-migration';

/** Migrations 13 onward, one module each; `MIGRATIONS` ends with them, so new ones append here. */
export const LATE_MIGRATIONS: Migration[] = [
  REENTRY_MIGRATION,
  REVIEW_COLUMNS_MIGRATION,
  GROWTH_LOG_MIGRATION,
  SURFACE_MIGRATION,
  FEED_INDEX_MIGRATION,
];
