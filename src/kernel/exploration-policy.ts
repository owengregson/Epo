/**
 * Tier 1 — the exploration policy (ADR 0211): how a source visit is sliced and
 * scheduled. These are CHOICES, not measurements, so they live beside
 * {@link ./policy POLICY}; each line says what it guards against. The slice
 * shape also sizes the read allowance (`derive-reads.ts`): what a slice may
 * read is what the plan's exploration costs.
 *
 * Moved here from `src/engine/exploration-policy.ts` (now a re-export shim) so
 * the kernel can derive from it. Layering: `src/kernel/**` imports nothing
 * from the rest of `src/`.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const EXPLORATION_POLICY = {
  /** Live source alternatives kept at once: choices stay bounded. */
  maxSources: 5,
  /** Follows one source visit may yield before rotating: no audience is mined out in one sitting. */
  followsPerVisit: 20,
  /** Candidate profiles one refill slice may read (the enrichment batch). */
  profilesPerSlice: 20,
  /** List pages one refill slice may read on the direct path. */
  pagesPerSlice: 2,
  /** New-to-source rows one slice may collect: the slice ends before the list does. */
  rowsPerSlice: 100,
  /** Reads a slice spends OPENING its source: one profile (pk, counts) and, on the dialog path, one list page. */
  sourceOpenReads: 1,
  /** Queued candidates per source: one large audience cannot fill the global queue. */
  queuedPerSource: 10,
  /** Empty slices before a source is deferred: unproductive sampling stops without claiming exhaustion. */
  emptySlicesBeforeDefer: 2,
  /** Share of follows reserved for under-sampled sources (every fifth). */
  explorationFraction: 0.2,
  /** Most of the recent follows any one source may hold while alternatives exist. */
  sourceShare: 0.4,
  /** How many recent follows the share is measured over. */
  shareWindow: 100,
  /** Prior follow-back rate for an unknown source: regularises small samples, not a yield claim. */
  priorRate: 0.15,
  /** Observations the prior is worth. */
  priorWeight: 20,
  /** Fixed outcome horizon for source quality (the default follow-back wait). */
  outcomeWindowMs: 4 * DAY,
  /** Own followers profiled per fallback pick: a pick never turns into an enrichment burst. */
  ownFollowersPickMax: 15,
  /** Acquisition waits while the unacted pool holds this many plans' worth: selection never starves, reads never pile up. */
  skipPoolFactor: 4,
  /** Never read past this share of a source's followers: the deep tail is old, inactive accounts. */
  maxCoverageFraction: 0.5,
  /** Enrichment passes per refill cycle: one bounded slice, then plan. */
  maxEnrichPassesPerCycle: 1,
  /** Fewer live candidates than this skip the utility ranking: a lone source is simply next. */
  rankMinCandidates: 2,
  /** Overlap assumed for a never-sampled source: neither favoured nor shunned. */
  unknownOverlap: 0.5,
  /** How much observed audience overlap discounts a source's utility. */
  overlapWeight: 0.5,
  /** Utility a source loses per unit of recent follow share: no audience dominates. */
  sharePenalty: 0.1,
  /** Sources needed before the follow-share cap applies (with fewer there is nothing to spread over). */
  shareMinSources: 3,
  /** Fewer ready or working sources than this refill the frontier from own followers. */
  refillBelowLiveSources: 3,
  /** Hubs proposed per chain advance; the gates then filter them. */
  maxDiscovered: 5,
} as const;
