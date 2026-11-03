/**
 * The gesture's motion policy (ADR 0607, spec §5.11): the `MOTION` table with
 * its tempo-role durations stretched by the session's motion factor and its
 * speed–accuracy keys co-varying with it. Shape, guardrail and device keys
 * never move. `deriveMotion(1)` is `MOTION_REFERENCE`, exactly.
 */

import { MOTION } from '../motion-policy';
import { TEMPO_POLICY } from '../tempo-policy';
import { scaleAbove } from './resolve';

type Widen<T> = T extends readonly [number, number] ? readonly [number, number] : number;

/** The widened shape of `MOTION`: the same keys, any value of the same kind. */
export type MotionPolicy = { readonly [K in keyof typeof MOTION]: Widen<(typeof MOTION)[K]> };

/** The policy every gesture uses at motion factor 1 — today's `MOTION`. */
export const MOTION_REFERENCE: MotionPolicy = MOTION;

/** Motion-axis duration bands: the lower edge is the floor, the upper edge stretches above it. */
const DURATION_BANDS = ['pressMs', 'hoverSettleMs', 'prePressMs', 'wheelPauseMs', 'wheelMicroPauseMs',
  'wheelCorrectionPauseMs'] as const;

/** A probability or fraction never leaves [0, 1]; a target-relative aim spread never exceeds half the target. */
const UNIT_MAX = 1;
const AIM_SPREAD_MAX = 1 / 2;

const pair = (p: readonly [number, number], f: number, max: number): readonly [number, number] =>
  [Math.min(max, p[0] * f), Math.min(max, p[1] * f)];

/**
 * The motion policy at motion factor `m`: tempo durations scale above their
 * floors (travel's Fitts terms by `m`), speed–accuracy keys by
 * `m^(−SPEED_ACCURACY_ELASTICITY)` within their guardrails, nothing else moves.
 */
export function deriveMotion(m: number): MotionPolicy {
  const s = m ** -TEMPO_POLICY.SPEED_ACCURACY_ELASTICITY;
  const p: { -readonly [K in keyof MotionPolicy]: MotionPolicy[K] } = { ...MOTION };
  for (const key of DURATION_BANDS) {
    const [lo, hi] = MOTION[key];
    p[key] = [lo, scaleAbove(hi, lo, m)];
  }
  p.pressMedianMs = scaleAbove(MOTION.pressMedianMs, MOTION.pressMs[0], m);
  p.travelBaseMs = MOTION.travelBaseMs * m;
  p.travelScaleMs = MOTION.travelScaleMs * m;
  p.moveMaxMs = scaleAbove(MOTION.moveMaxMs, MOTION.moveMinMs, m);
  p.overshootProbability = Math.min(UNIT_MAX, MOTION.overshootProbability * s);
  p.overshootFraction = pair(MOTION.overshootFraction, s, UNIT_MAX);
  p.targetSigmaFraction = Math.min(AIM_SPREAD_MAX, MOTION.targetSigmaFraction * s);
  p.wheelOvershootProbability = Math.min(UNIT_MAX, MOTION.wheelOvershootProbability * s);
  p.wheelOvershootFraction = pair(MOTION.wheelOvershootFraction, s, UNIT_MAX);
  return p;
}
