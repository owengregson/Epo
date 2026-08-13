/**
 * Projected-growth model — pure, deterministic, and unit-testable. Simulates
 * cumulative NET followers over the next N days under the current settings, across
 * three yield scenarios (cautious / expected / optimistic):
 *
 *   net(t) = R · P · ( t − (1−RR) · max(0, t − lag) )
 *
 *   R   = daily operating rate (follows/day)
 *   P   = scenario follow-back rate, modulated by the live settings (audience
 *         yield, private boost, ratio-band tightness, and a volume penalty)
 *   RR  = scenario retention (fraction who STAY after the unfollow)
 *   lag = wait + hold days (when the first cohort starts being unfollowed)
 *
 * A fast early ramp (first cohorts not yet unfollowed) settles into a steady
 * ≈ R·P·RR net/day. A deterministic wiggle models real follow/unfollow churn.
 */

/** Scenario bases: [cautious, expected, optimistic]. */
const PROJ_SCEN: ReadonlyArray<{ P0: number; RR: number }> = [
  { P0: 0.08, RR: 0.55 },
  { P0: 0.15, RR: 0.66 },
  { P0: 0.25, RR: 0.76 },
];

/** The expected (avg) scenario base — the pivot the spread fans out around. */
const PROJ_CENTER = 0.15;
/** >1 → the three cases fan out super-linearly as the yield scalar rises. */
const YIELD_SPREAD_EXP = 2;

function clampN(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Deterministic pseudo-noise in [-1, 1] from an integer seed (stable across recalcs). */
export function pnoise(i: number): number {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

/** Scenario follow-back rate, modulated by the live settings. */
export function projP(base: number, ym: number, pb: number, bandWidth: number, R: number): number {
  // Scale the LEVEL by ym but the SPREAD (deviation from the expected case) by
  // ym^EXP, so stratification grows with the scalar rather than an even multiply.
  let p = Math.max(0, PROJ_CENTER * ym + (base - PROJ_CENTER) * Math.pow(ym, YIELD_SPREAD_EXP));
  p *= 1 + pb * 0.6; // private boost
  p *= clampN(1 + (0.6 - bandWidth) * 0.25, 0.85, 1.15); // band tightness
  p *= clampN(1 - Math.max(0, R - 60) / 320, 0.8, 1); // volume penalty
  return Math.min(0.6, p);
}

/** Cumulative net followers at day t (smooth, noise-free). */
export function projNet(t: number, R: number, P: number, RR: number, lag: number): number {
  return Math.max(0, R * P * (t - (1 - RR) * Math.max(0, t - lag)));
}

export interface ProjectionInput {
  /** Daily operating rate. */
  rate: number;
  /** Audience-yield multiplier (0.5..1.5). */
  yieldMult: number;
  /** Private-account boost (0..0.5). */
  privateBoost: number;
  /** Ratio band width (hi − lo). */
  bandWidth: number;
  waitDays: number;
  holdDays: number;
  /** Horizon in days (default 30). */
  days?: number;
}

export interface Scenario {
  /** Effective follow-back rate for this scenario. */
  P: number;
  /** Noisy cumulative-net series, one entry per day 0..days. */
  pts: number[];
  /** Smooth (noise-free) endpoint at day `days`. */
  end: number;
}

export interface ProjectionResult {
  /** [cautious, expected, optimistic]. */
  scenarios: [Scenario, Scenario, Scenario];
  /** Plot ceiling (optimistic endpoint, ≥ 1). */
  vmax: number;
  days: number;
}

/** Compute the three-scenario projection for the given settings. */
export function computeProjection(input: ProjectionInput): ProjectionResult {
  const days = input.days ?? 30;
  const R = input.rate;
  const lag = input.waitDays + input.holdDays;

  const scenarios = PROJ_SCEN.map((sc, si): Scenario => {
    const P = projP(sc.P0, input.yieldMult, input.privateBoost, input.bandWidth, R);
    const amp = R * P * 2.0; // daily follow/unfollow churn, per scenario
    const pts: number[] = [];
    for (let t = 0; t <= days; t++) {
      const base = projNet(t, R, P, sc.RR, lag);
      const taper = Math.sin((Math.PI * t) / days); // 0 at both ends → clean start & endpoint
      pts.push(Math.max(0, base + amp * pnoise(t * 7 + si * 101) * taper));
    }
    return { P, pts, end: projNet(days, R, P, sc.RR, lag) };
  }) as [Scenario, Scenario, Scenario];

  const vmax = Math.max(1, scenarios[2].end); // optimistic is always the ceiling
  return { scenarios, vmax, days };
}
