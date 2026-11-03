/**
 * Tier 1 — each `MOTION` key's role (ADR 0607): a TEMPO duration, a SPEED–ACCURACY key (co-varies with
 * the motion factor), a SHAPE dial (fixed per install; guard line + provenance), a GUARDRAIL or a
 * DEVICE fact. The motion golden holds MOTION to the frozen snapshot plus {@link MOTION_ADDED}.
 */

import type { MOTION } from './motion-policy';

export type MotionRole = 'tempo' | 'speed-accuracy' | 'shape' | 'guardrail' | 'device';
type MotionKey = keyof typeof MOTION;

export const MOTION_ROLE = {
  maxDistancePx: 'guardrail',
  maxIntegrationSteps: 'guardrail',
  arrivalPx: 'guardrail',
  gravity: 'shape',
  windGravityRatio: 'shape',
  windMemory: 'shape',
  momentum: 'shape',
  maxStepPx: 'shape',
  referenceDistancePx: 'guardrail',
  distanceScale: 'guardrail',
  dampingRadiusPx: 'shape',
  brakingScale: 'shape',
  speedMemory: 'shape',
  speedVariation: 'shape',
  corridorFraction: 'guardrail',
  corridorMinPx: 'guardrail',
  overshootProbability: 'speed-accuracy',
  overshootMinDistancePx: 'guardrail',
  overshootFraction: 'speed-accuracy',
  overshootMaxPx: 'guardrail',
  overshootTargetFraction: 'guardrail',
  peakSpeedPxPerSecond: 'guardrail',
  peakSpeedFactor: 'device',
  minEventDelayMs: 'guardrail',
  cadenceMemory: 'shape',
  cadenceSigma: 'shape',
  cadenceWeightFloor: 'guardrail',
  travelBaseMs: 'tempo',
  travelScaleMs: 'tempo',
  moveMinMs: 'tempo',
  moveMaxMs: 'tempo',
  travelSigma: 'shape',
  travelBoundaryInsetFactor: 'guardrail',
  travelRejectionAttempts: 'guardrail',
  minTargetWidthPx: 'guardrail',
  hoverSettleMs: 'tempo',
  profileDwellMedianMs: 'tempo',
  profileDwellSigma: 'tempo',
  profileDwellMs: 'tempo',
  pressMs: 'tempo',
  pressMedianMs: 'tempo',
  pressSigma: 'tempo',
  targetMarginFraction: 'guardrail',
  targetMarginMaxFraction: 'guardrail',
  targetSigmaFraction: 'speed-accuracy',
  targetRejectionAttempts: 'guardrail',
  wheelDistanceFactor: 'shape',
  wheelAverageTickPx: 'device',
  wheelOvershootMinTicks: 'guardrail',
  wheelOvershootProbability: 'speed-accuracy',
  wheelOvershootFraction: 'speed-accuracy',
  wheelRampFraction: 'shape',
  wheelRampFloor: 'guardrail',
  wheelWeightFloor: 'guardrail',
  wheelSigma: 'shape',
  wheelPauseMs: 'tempo',
  wheelMicroPauseProbability: 'tempo',
  wheelMicroPauseMs: 'tempo',
  wheelCorrectionPauseMs: 'tempo',
  wheelCorrectionMaxTicks: 'shape',
  wheelCorrectionFraction: 'shape',
  prePressMs: 'tempo',
  driftProbability: 'shape',
  driftPx: 'shape',
  initialCursorXPx: 'device',
  initialCursorYPx: 'device',
} as const satisfies { readonly [K in MotionKey]: MotionRole };

type ShapeKey = { [K in MotionKey]: (typeof MOTION_ROLE)[K] extends 'shape' ? K : never }[MotionKey];

/** Path-geometry provenance: the WindMouse force model, implemented independently in `windmouse.ts`. */
const WINDMOUSE = 'WindMouse force model (Ben Land), independent implementation; gains chosen for viewport input';
/** Wheel-plan provenance: the burst planner in `motion-profile.ts`. */
const WHEEL = 'wheel burst planner in motion-profile.ts; chosen, not measured';

/** Every shape dial: a guard line (what it keeps from going wrong) and where it comes from. */
export const MOTION_SHAPE_DIALS: { readonly [K in ShapeKey]: { readonly guard: string; readonly provenance: string } } = {
  gravity: { guard: 'Pull toward the target per step: lower wanders, higher snaps straight.', provenance: WINDMOUSE },
  windGravityRatio: { guard: 'Wind against pull: enough to curve a path, never enough to orbit.', provenance: WINDMOUSE },
  windMemory: { guard: 'How long a gust persists between steps: curvature stays smooth.', provenance: WINDMOUSE },
  momentum: { guard: 'Share of the last step kept: paths glide instead of zigzagging.', provenance: WINDMOUSE },
  maxStepPx: { guard: 'Largest step before distance scaling: bounds the speed of one step.', provenance: WINDMOUSE },
  dampingRadiusPx: { guard: 'Where wind fades near the target: the approach straightens.', provenance: WINDMOUSE },
  brakingScale: { guard: 'How hard the approach brakes: speed alone never overshoots.', provenance: WINDMOUSE },
  speedMemory: { guard: 'Smoothing of the per-step speed factor: speed drifts, never jumps.', provenance: WINDMOUSE },
  speedVariation: { guard: 'Range the per-step speed factor draws from.', provenance: WINDMOUSE },
  cadenceMemory: { guard: 'Correlation of consecutive event delays: cadence drifts smoothly.', provenance: WINDMOUSE },
  cadenceSigma: { guard: 'Spread of the event-delay cadence: never a fixed period.', provenance: WINDMOUSE },
  travelSigma: { guard: 'Spread of a move duration around its Fitts estimate.', provenance: 'Fitts-law travel time in motion-profile.ts' },
  wheelDistanceFactor: { guard: 'Where a wheel burst lands against its request: slightly short or long.', provenance: WHEEL },
  wheelRampFraction: { guard: 'Share of a burst spent ramping in and out.', provenance: WHEEL },
  wheelSigma: { guard: 'Spread of per-tick wheel deltas.', provenance: WHEEL },
  wheelCorrectionFraction: { guard: 'Share of an overshoot each correction tick takes back.', provenance: WHEEL },
  wheelCorrectionMaxTicks: { guard: 'Most correction ticks after a wheel overshoot.', provenance: WHEEL },
  driftProbability: { guard: 'Chance per wheel tick that a free-resting cursor shifts slightly.', provenance: 'moved from the Interactor scroll loop' },
  driftPx: { guard: 'Largest such shift, in px each way.', provenance: 'moved from the Interactor scroll loop' },
};

/**
 * Keys added to MOTION after the snapshot froze, with the literal each replaced.
 * `motion-golden.test.ts` asserts MOTION equals the snapshot plus these values.
 */
export const MOTION_ADDED = {
  prePressMs: { value: [30, 120], from: 'Interactor.click pre-press uniform(30, 120)', adr: '0607' },
  driftProbability: { value: 0.15, from: 'Interactor scroll drift chance 0.15', adr: '0607' },
  driftPx: { value: 3, from: 'Interactor scroll drift uniform(-3, 3)', adr: '0607' },
  initialCursorXPx: { value: [180, 720], from: 'Interactor constructor uniform(180, 720)', adr: '0607' },
  initialCursorYPx: { value: [160, 560], from: 'Interactor constructor uniform(160, 560)', adr: '0607' },
} as const satisfies { readonly [K in MotionKey]?: { readonly value: unknown; readonly from: string; readonly adr: string } };
