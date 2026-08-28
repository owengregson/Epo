/**
 * Projection-vs-actual overlay model — pure and unit-tested. Continues the
 * realized cumulative-net line into the future with the same three-scenario
 * model the Settings simulator uses (growth-model.ts), RE-ANCHORED so the
 * projection's day 0 IS today's realized cumulative value: every path starts
 * exactly at the realized endpoint and fans out from there.
 *
 * Yield honesty: once enough follow outcomes exist ({@link
 * CONVERSION_VERDICT_MIN}, the same sample gate conversion verdicts use), the
 * expected path is centered on the MEASURED aggregate follow-back rate — the
 * cautious/optimistic spread scales with it. Below the sample gate the model
 * falls back to the settings-derived scenario yields, and says so.
 *
 * The measured rate counts records still awaiting a follow-back in its
 * denominator, so early on it reads conservatively — it can only converge
 * upward as outcomes resolve.
 */

import { CONVERSION_VERDICT_MIN } from '@/types';
import { clamp } from '../lib/format';
import { PROJ_SCEN, projNet, projP } from './growth-model';

/** Sanity clamp on measured/settings yield ratio (guards a degenerate model P). */
const LIVE_RATIO_MIN = 0.2;
const LIVE_RATIO_MAX = 5;

export interface GrowthOverlayInput {
  /** Daily operating rate (settings). */
  rate: number;
  /** Private-account boost (settings). */
  privateBoost: number;
  /** Ratio band width, `bandHigh - bandLow` (settings). */
  bandWidth: number;
  waitDays: number;
  holdDays: number;
  /** How many days ahead to project. */
  horizonDays: number;
  /** Today's realized cumulative net — the anchor every path starts from. */
  realizedEnd: number;
  /** Aggregate realized follow-back sample across all chain targets, or null. */
  sample: { followedBack: number; total: number } | null;
}

export interface GrowthOverlay {
  horizonDays: number;
  /** Noise-free cumulative paths, one entry per day 0..horizonDays; index 0
   *  equals `realizedEnd` exactly on all three. */
  cautious: number[];
  expected: number[];
  optimistic: number[];
  /** True when the yield came from measured follow-backs (sample ≥ gate). */
  measuredYield: boolean;
  /** The effective expected-scenario follow-back rate driving the center path. */
  expectedP: number;
}

/** Compute the re-anchored projection continuation for the Overview chart. */
export function computeGrowthOverlay(input: GrowthOverlayInput): GrowthOverlay {
  const lag = input.waitDays + input.holdDays;
  const R = input.rate;

  // Settings-derived scenario yields (yieldMult 1 — the live-data path below
  // replaces the hypothesis slider, it does not stack with it).
  let ps = PROJ_SCEN.map((sc) => projP(sc.P0, 1, input.privateBoost, input.bandWidth, R));

  // Enough measured outcomes → center the expected path on the realized rate.
  const s = input.sample;
  const measuredYield = s !== null && s.total >= CONVERSION_VERDICT_MIN && ps[1] > 0;
  if (measuredYield && s !== null) {
    const liveP = s.followedBack / s.total;
    const ratio = clamp(liveP / ps[1], LIVE_RATIO_MIN, LIVE_RATIO_MAX);
    ps = ps.map((p) => clamp(p * ratio, 0, 1));
  }

  const path = (P: number, RR: number): number[] => {
    const pts: number[] = [];
    for (let t = 0; t <= input.horizonDays; t++) {
      pts.push(input.realizedEnd + projNet(t, R, P, RR, lag));
    }
    return pts;
  };

  return {
    horizonDays: input.horizonDays,
    cautious: path(ps[0], PROJ_SCEN[0].RR),
    expected: path(ps[1], PROJ_SCEN[1].RR),
    optimistic: path(ps[2], PROJ_SCEN[2].RR),
    measuredYield,
    expectedP: ps[1],
  };
}
