/**
 * The day plan's vocabulary (ADR 0607, spec §5.15 and Appendix A) — types only.
 * The plan core (PC) writes the functions over these; every other layer reads
 * them through `src/governors/plan-types.ts` or the engine's plan port.
 *
 * Layering: `src/kernel/**` imports nothing from the rest of `src/`.
 */

/** What a read is for: the read allowance's `use` tag (the plan's read buckets). */
export type ReadUse = 'verify' | 'reconcile' | 'explore' | 'check' | 'census' | 'catch-up';

/** The rhythm/caution reference shape of the action gap at time-scale 1. */
export interface GapShape {
  readonly medianMs: number;
  readonly sigma: number;
  readonly floorMs: number;
  readonly capMs: number;
  readonly hawkesAlpha: number;
  readonly hawkesTauMs: number;
}

/** A session's gap: the reference shape time-scaled by τ toward its target mean. */
export interface GapSpec extends GapShape {
  readonly timeScale: number;
  readonly targetMeanMs: number;
}

/** One session's tempo: the factors every tempo spec resolves against (C25: two orthogonal flags). */
export interface SessionTempo {
  readonly z: number;
  readonly pace: number;
  readonly motion: number;
  readonly depth: number;
  readonly gap: GapSpec;
  readonly mix: 'normal' | 'boost';
  readonly probation: boolean;
}
