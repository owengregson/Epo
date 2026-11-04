/**
 * Tier 1 — diagnostic capture bounds (ADR 0807), independent of application pacing.
 * Layering: `src/kernel/**` imports nothing from the rest of `src/`.
 */
export const PROBE_BOUNDS = {
  /** Guards: native/CDP event timestamp skew during request association; ambiguous matches still fail. */
  CAPTURE_EVENT_SKEW_MS: 250,
} as const;
