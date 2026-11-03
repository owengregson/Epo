/**
 * Tier 1 — the census guards (spec §10.9). Phase F moves the prune scan's two
 * coverage numbers here unchanged; the parse stream owns and extends the table.
 * One guard line per entry.
 *
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
