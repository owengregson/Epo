/**
 * Tier 1 — the reopen reconciliation's bounds (ADR 0213). Phase F creates the
 * table; the reopen stream owns it afterwards. One guard line per entry.
 *
 * Layering: `src/kernel/**` imports nothing from the rest of `src/`.
 */

export const BOUNDS_REENTRY = {
  /** A walk averaging fewer rows per page than this is a parse or server fault, never a census to size by. */
  MIN_ROWS_PER_PAGE: 10,
  /** About a week of gains at measured page sizes; a longer gap stops with `gap` and waits for the census. */
  FRONTIER_PAGES_MAX: 5,
  /** The ordered following form answers the whole list in one response; one plain probe proves its end. */
  FOLLOWING_WALK_PAGES: 2,
} as const;
