/**
 * Tier 1 — the read pipeline's guardrails (spec §10.9, Appendix D.1). None is an Instagram-facing
 * timing; every streak, consistency or auto-resolve count reuses `driftConfirmThreshold()`.
 * Layering: `src/kernel/**` imports nothing from the rest of `src/`.
 */

export const SURFACE_BOUNDS = {
  /** Guards the structural search against pathological bodies. */
  searchMaxNodes: 20_000,
  /** Guards recursion on hostile JSON (profile records nest four deep today). */
  searchMaxDepth: 12,
  /** Bodies above this read canonically or fail; they are never searched. */
  searchMaxBytes: 4_000_000,
  /** Share of sampled elements that must be rows; share of a page's rows that must read. */
  rowMajority: 0.9,
  /** Identity-continuity conflict share that rejects a location (renames are legitimate). */
  identityConflictMax: 0.05,
  /** Unrouted GraphQL references buffered per armed context (references, not bodies). */
  fallbackCandidates: 8,
  /** Array elements sampled by novelty and the locator (rows share a shape). */
  sampleRows: 8,
  /** How deep the novelty walk descends. */
  noveltyMaxDepth: 6,
  /** Drift signatures kept per endpoint; informational ones are evicted first. */
  maxSignaturesPerEndpoint: 200,
  /** One scrubbed sample's size cap. */
  sampleMaxBytes: 16_384,
  /** Samples written per plan-day across all signatures. */
  samplesPerDay: 12,
  /** Plan-days of health rows kept. */
  healthRetentionDays: 30,
  /** Days a resolved drift signature is kept. */
  driftRetentionDays: 90,
  /** Latency samples kept per metric. */
  meterReservoir: 128,
  /** Unmatched POSTs a mutation window keeps for diagnosis (the newest win). */
  unmatchedPostsKept: 12,
  /** Non-JSON head kept in a log line. */
  logHeadChars: 80,
  /** Non-JSON head an in-page fetch envelope carries back. */
  envelopeHeadChars: 256,
  /** Request-body capture cap (only with the optional request-field capture). */
  requestBodyMaxBytes: 65_536,
  /** Scrubbed counts keep this many significant digits at or above the floor. */
  scrubCountDigits: 2,
  /** Scrubbed counts below this are kept exactly. */
  scrubCountFloor: 100,
  /** A failed list page is retried once on its cursor; the next failure ends the walk, never as an end. */
  listWalkFetchRetries: 1,
  /** Event times before 2010-01-01 UTC are a unit error, never a date (I9). */
  timeFloorMs: 1_262_304_000_000,
} as const;

/** Protocol facts the observed gate reads (HTTP status codes; geometry of the protocol, not tuning). */
export const HTTP_STATUS = {
  /** The first success status. */
  okMin: 200,
  /** The first status past the success range. */
  okEnd: 300,
  /** A request the server could not serve as asked (the list's past-the-limit refusal). */
  badRequest: 400,
  /** The session is not signed in. */
  unauthorized: 401,
  /** The session may not read this. */
  forbidden: 403,
  /** The resource does not exist. */
  notFound: 404,
  /** The server is limiting requests. */
  tooManyRequests: 429,
  /** The first server-error status. */
  serverErrorMin: 500,
} as const;
