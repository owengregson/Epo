/**
 * Tier 1 — the census guards (spec §10.9): the prune scan's two coverage numbers, moved unchanged,
 * and the walk bound. One guard line per entry; the parse stream owns and extends the table.
 * Layering: `src/kernel/**` imports nothing from the rest of `src/`.
 */

export const CENSUS_POLICY = {
  /** Headers below this skip the scan-coverage net: tiny accounts are ghost-dominated. */
  coverageFloor: 50,
  /** Share of the refreshed header a census walk must list, or the scan aborts. */
  scanCoverageMin: 0.85,
  /** Five runaway bounds (5 × LIST_WALK_MAX_PAGES): a census longer than this is never one uninterrupted walk. */
  maxWalkPages: 1_000,
} as const;
