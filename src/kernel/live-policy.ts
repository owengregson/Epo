/**
 * Tier 1 — the live column's bounds (spec §12.9, Appendix C.2): how much of the recent past the feed narrates
 * and how it groups, and how many log lines Diagnostics keeps. Main shapes the feed with these and hands the
 * store its windows as method arguments. Layering: `src/kernel/**` imports nothing from the rest of `src/`.
 */

import { EMPIRICAL } from './fundamentals';
import { MS_PER_DAY } from './units';

export const LIVE = {
  /** Guards: per-push shaping cost and payload size of the feed (items after grouping). */
  FEED_LIMIT: 60,
  /** Guards: the sidebar narrating more than the recent past; older detail lives on the People page. */
  FEED_WINDOW_MS: 7 * MS_PER_DAY,
  /** Guards: one row merging two sittings; the grouping horizon is one session boundary, derived. */
  GROUP_WINDOW_MS: EMPIRICAL.HUMAN_SESSION_BOUNDARY_MS.value,
  /** Guards: a grouped row listing more people than it can show before "+N more". */
  GROUP_PEOPLE_MAX: 20,
} as const;

export const DIAGNOSTICS = {
  /** Guards: memory of the in-process log ring served to the Diagnostics panel. */
  LOG_RING: 500,
} as const;
