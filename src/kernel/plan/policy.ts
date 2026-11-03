/**
 * Tier 1 — the day plan's own numeric bounds (ADR 0607): grids, estimator sizes and the few
 * cut-offs the plan core needs that no fundamental or dial already names. One guard line each.
 * Layering: `src/kernel/**` imports nothing from the rest of `src/`.
 */

export const PLAN_BOUNDS = {
  /** Draws per gap-model estimate: about 1 % standard error on the mean gap, cheap enough to memoize per shape. */
  GAP_MODEL_DRAWS: 4096,
  /** Bisection steps when the gap cap binds: 2^-24 of the bracket, far below a millisecond. */
  GAP_SOLVE_ITERATIONS: 24,
  /** Bounded re-draws of a clamped log-normal before projecting onto the nearer bound: no probability spike at a bound. */
  CLAMP_REDRAWS: 4,
  /** A transition plan-day ends at the first new quiet minute at least this many hours after the old boundary. */
  TRANSITION_MIN_HOURS: 12,
  /** A plan-day shorter than this many hours prorates its counters; DST days (23 or 25 h) keep them whole. */
  PRORATE_BELOW_HOURS: 23,
  /** The λ field is read on this grid (minutes): the quiet minute, session mass and placement. */
  GRID_MINUTES: 1,
  /** A Boost inserts a session now only inside the day's central λ mass (the 2.5 %–97.5 % quantiles). */
  BOOST_INSERT_MASS: { LO: 0.025, HI: 0.975 },
  /** Session pace words: ~15 % slower or brisker than the reference, symmetric in log space (1.15 ≈ 1 / 0.87). */
  PACE_WORDS: { RELAXED_ABOVE: 1.15, QUICK_BELOW: 0.87 },
} as const;
