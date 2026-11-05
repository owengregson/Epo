/**
 * Tier 1 — the corpus scrubber's own bounds (spec §10.8, §16.5): the synthetic ranges a scrubbed body maps real
 * ids and times into, and its walk bounds. None is Instagram-facing; each keeps a committed corpus or a stored
 * sample free of real identity. Layering: `src/kernel/**` imports nothing from the rest of `src/`.
 */

export const SCRUB_POLICY = {
  /** Guards: a synthetic id colliding with a real one; scrubbed ids count up from this reserved 12-digit base. */
  syntheticPkBase: 700_000_000_000,
  /** Guards: the reserved id range reaching real ids; one scrubber mints fewer synthetic ids than this. */
  syntheticPkSpan: 1_000_000,
  /** Guards: a real time surviving a scrub; the earliest scrubbed time maps here, order and intervals kept. */
  syntheticTimeBase: 1_700_000_000,
  /** Guards: shifted times leaving the window the leak rules accept; a body spanning more is dropped. */
  syntheticTimeSpan: 10_000_000,
  /** Guards: an identifying number under an unknown key; only magnitudes below this survive as they are. */
  keptNumberMax: 10_000_000,
  /** Guards: recursion on hostile JSON; deeper values become their type name. */
  maxDepth: 8,
  /** Guards: a short display name matching ordinary words in markup; shorter names are not rewritten. */
  minNameChars: 3,
  /** Guards: corpus bloat; stories and connection edges kept per ingested body. */
  rowsKept: 12,
  /** Guards: a `$ref` cycle in a schema projection; resolution stops after this many hops. */
  refHops: 8,
} as const;
