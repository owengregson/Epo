import { assertRect, clampNum, type ElementRect, intersectRect, type Point } from '@/interaction/motion-geometry';
import { gaussian, type Rng, uniform, unitRandom } from '@/interaction/motion-random';
import { type PathOpts, windMousePath } from '@/interaction/windmouse';
import { MOTION_REFERENCE, type MotionPolicy } from '@/kernel/tempo';

export { containPoint, type ElementRect, intersectRect, type Point } from '@/interaction/motion-geometry';
export { gaussian, type Rng, uniform } from '@/interaction/motion-random';
export type { PathOpts } from '@/interaction/windmouse';

export function pressDurationMs(rng: Rng, policy: MotionPolicy = MOTION_REFERENCE): number {
  return Math.round(clampNum(policy.pressMedianMs * Math.exp(gaussian(rng) * policy.pressSigma),
    policy.pressMs[0], policy.pressMs[1]));
}

export function targetPoint(target: ElementRect, rng: Rng, bounds?: ElementRect,
  policy: MotionPolicy = MOTION_REFERENCE): Point {
  assertRect(target);
  const rect = bounds ? intersectRect(target, bounds) : target;
  if (!rect) throw new RangeError('Motion target has no visible area in the viewport');
  const marginX = Math.min(Math.max(rect.width * policy.targetMarginFraction, 1),
    rect.width * policy.targetMarginMaxFraction);
  const marginY = Math.min(Math.max(rect.height * policy.targetMarginFraction, 1),
    rect.height * policy.targetMarginMaxFraction);
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  // Rejection avoids a visible mass of click points exactly on the clamp edges.
  const axis = (center: number, size: number, margin: number): number => {
    const extent = size / 2 - margin;
    for (let attempt = 0; attempt < policy.targetRejectionAttempts; attempt++) {
      const offset = gaussian(rng) * size * policy.targetSigmaFraction;
      if (Math.abs(offset) < extent) return center + offset;
    }
    return center + uniform(rng, -extent, extent);
  };
  return { x: axis(cx, rect.width, marginX), y: axis(cy, rect.height, marginY) };
}

export function pathBetween(from: Point, to: Point, rng: Rng, opts: PathOpts = {},
  policy: MotionPolicy = MOTION_REFERENCE): Point[] {
  return windMousePath(from, to, rng, opts, policy);
}

export function travelDurationMs(distancePx: number, targetWidthPx: number, rng: Rng,
  policy: MotionPolicy = MOTION_REFERENCE): number {
  if (!Number.isFinite(distancePx) || distancePx < 0
    || !Number.isFinite(targetWidthPx) || targetWidthPx <= 0) {
    throw new RangeError('Motion distance and target width must be finite and valid');
  }
  const w = Math.max(policy.minTargetWidthPx, targetWidthPx);
  const base = policy.travelBaseMs + policy.travelScaleMs * Math.log2(Math.max(0, distancePx) / w + 1);
  const nominal = clampNum(base, policy.moveMinMs * policy.travelBoundaryInsetFactor,
    policy.moveMaxMs / policy.travelBoundaryInsetFactor);
  for (let attempt = 0; attempt < policy.travelRejectionAttempts; attempt++) {
    const noisy = Math.round(nominal * Math.exp(gaussian(rng) * policy.travelSigma));
    if (noisy >= policy.moveMinMs && noisy <= policy.moveMaxMs) return noisy;
  }
  // Degenerate injected RNGs must terminate without concentrating normal draws
  // at the 120ms/1400ms clamps. The fallback remains local to the nominal time.
  return Math.round(uniform(rng,
    Math.max(policy.moveMinMs, nominal / policy.travelBoundaryInsetFactor),
    Math.min(policy.moveMaxMs, nominal * policy.travelBoundaryInsetFactor)));
}

/** Integer apportionment preserves the exact budget instead of accumulating rounding drift. */
function allocateDelays(totalMs: number, floors: number[], weights: number[]): number[] {
  const budget = Math.max(Math.round(totalMs), floors.reduce((sum, value) => sum + value, 0));
  const available = budget - floors.reduce((sum, value) => sum + value, 0);
  const weightSum = weights.reduce((sum, value) => sum + value, 0);
  const shares = weights.map((weight) => available * weight / weightSum);
  const delays = shares.map((share, index) => floors[index] + Math.floor(share));
  let remainder = budget - delays.reduce((sum, value) => sum + value, 0);
  const order = shares.map((share, index) => ({ index, remainder: share % 1 }))
    .sort((a, b) => b.remainder - a.remainder);
  for (const entry of order) {
    if (remainder-- <= 0) break;
    delays[entry.index]++;
  }
  return delays;
}

export function stepDelays(totalMs: number, steps: number, rng: Rng, policy: MotionPolicy = MOTION_REFERENCE): number[] {
  if (!Number.isFinite(totalMs) || totalMs < 0 || !Number.isInteger(steps) || steps < 0) {
    throw new RangeError('Motion duration and step count must be finite and nonnegative');
  }
  if (steps === 0) return [];
  const weights: number[] = [];
  let cadence = 0;
  for (let i = 0; i < steps; i++) {
    const s = (i + 0.5) / steps;
    const velocity = Math.max(policy.cadenceWeightFloor, 4 * s * (1 - s));
    cadence = cadence * policy.cadenceMemory + gaussian(rng) * policy.cadenceSigma;
    weights.push(Math.exp(cadence) / velocity);
  }
  return allocateDelays(totalMs, Array<number>(steps).fill(1), weights);
}

export interface MovementPlan {
  /** Initial point followed by emitted mouse positions; delay i precedes point i+1. */
  points: Point[];
  delaysMs: number[];
}

export function movementPlan(
  from: Point, to: Point, targetWidthPx: number, rng: Rng, opts: PathOpts = {},
  policy: MotionPolicy = MOTION_REFERENCE,
): MovementPlan {
  const points = pathBetween(from, to, rng, { ...opts, targetWidthPx }, policy);
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  if (distance === 0) return { points: [{ ...from }], delaysMs: [] };
  const total = travelDurationMs(distance, targetWidthPx, rng, policy);
  const lengths = points.slice(1).map((point, index) =>
    Math.hypot(point.x - points[index].x, point.y - points[index].y));
  // The physical simulation already accelerates/decelerates. Reusing the old
  // index-based bell delays would decelerate twice and ignore segment geometry.
  const peakSpeed = policy.peakSpeedPxPerSecond * uniform(rng, ...policy.peakSpeedFactor);
  const floors = lengths.map((length) => Math.max(policy.minEventDelayMs,
    Math.ceil(length * 1_000 / peakSpeed)));
  let cadence = 0;
  const weights = lengths.map(() => {
    cadence = cadence * policy.cadenceMemory + gaussian(rng) * policy.cadenceSigma;
    return Math.max(policy.cadenceWeightFloor, Math.exp(cadence));
  });
  return { points, delaysMs: allocateDelays(total, floors, weights) };
}

export interface WheelTick {
  deltaPx: number;
  pauseMs: number;
}

export interface WheelPlanOpts {
  overshoot?: boolean;
}

export function wheelPlan(requestedPx: number, rng: Rng, opts: WheelPlanOpts = {},
  policy: MotionPolicy = MOTION_REFERENCE): WheelTick[] {
  if (!Number.isFinite(requestedPx) || Math.abs(requestedPx) > policy.maxDistancePx) {
    throw new RangeError('Wheel distance must be finite and within the viewport guardrail');
  }
  if (requestedPx === 0) return [];
  const sign = requestedPx > 0 ? 1 : -1;
  const magnitude = Math.abs(requestedPx);

  const planned = Math.max(1, Math.round(magnitude * uniform(rng, ...policy.wheelDistanceFactor)));
  const avgTick = uniform(rng, ...policy.wheelAverageTickPx);
  const tickCount = Math.max(1, Math.round(planned / avgTick));

  const overshoot = opts.overshoot ?? (tickCount >= policy.wheelOvershootMinTicks
    && unitRandom(rng) < policy.wheelOvershootProbability);
  const overshootPx = overshoot ? planned * uniform(rng, ...policy.wheelOvershootFraction) : 0;

  const raw: number[] = [];
  for (let i = 0; i < tickCount; i++) {
    const s = tickCount === 1 ? 0.5 : i / (tickCount - 1);
    const rampIn = Math.min(1, s / policy.wheelRampFraction + policy.wheelRampFloor);
    const rampOut = Math.min(1, (1 - s) / policy.wheelRampFraction + policy.wheelRampFloor);
    const jitter = 1 + gaussian(rng) * policy.wheelSigma;
    raw.push(Math.max(policy.wheelWeightFloor, Math.min(rampIn, rampOut) * jitter));
  }
  const rawSum = raw.reduce((a, b) => a + b, 0);
  const mainTotal = planned + overshootPx;

  const ticks: WheelTick[] = raw.map((w) => ({
    deltaPx: sign * Math.round((mainTotal * w) / rawSum),
    pauseMs: nextPauseMs(rng, policy),
  }));

  if (overshoot) {
    const corrections = 1 + Math.min(policy.wheelCorrectionMaxTicks - 1,
      Math.floor(unitRandom(rng) * policy.wheelCorrectionMaxTicks));
    let remaining = Math.round(overshootPx);
    for (let i = 0; i < corrections; i++) {
      const part =
        i === corrections - 1 ? remaining : Math.round(remaining * uniform(rng, ...policy.wheelCorrectionFraction));
      if (part <= 0) continue;
      remaining -= part;
      ticks.push({ deltaPx: -sign * part, pauseMs: Math.round(uniform(rng, ...policy.wheelCorrectionPauseMs)) });
    }
  }

  const sum = ticks.reduce((a, t) => a + t.deltaPx, 0);
  const drift = Math.round(sign * planned) - sum;
  ticks[Math.min(tickCount - 1, ticks.length - 1)].deltaPx += drift;

  return ticks.filter((tick) => tick.deltaPx !== 0);
}

function nextPauseMs(rng: Rng, policy: MotionPolicy): number {
  if (unitRandom(rng) < policy.wheelMicroPauseProbability) {
    return Math.round(uniform(rng, ...policy.wheelMicroPauseMs));
  }
  return Math.round(uniform(rng, ...policy.wheelPauseMs));
}
