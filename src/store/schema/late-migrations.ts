import type { Migration } from './migration-types';
import { REENTRY_MIGRATION } from './reentry-migration';

/** Migrations 13 onward, one module each; `MIGRATIONS` ends with them, so new ones append here. */
export const LATE_MIGRATIONS: Migration[] = [REENTRY_MIGRATION];
