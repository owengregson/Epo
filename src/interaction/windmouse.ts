/**
 * Independent implementation of WindMouse's documented force model, not a port
 * of the GPL reference code: attraction + correlated wind + inertial motion.
 * Uses continuous braking, a bounded corridor, viewport constraints and an
 * explicit convergence tail instead of the reference's repeated random clipping.
 * Model attribution: Ben Land, https://ben.land/post/2021/04/25/windmouse-human-mouse-movement/
 */
import {
  assertPoint, assertRect, clampNum, containPoint, type ElementRect, type Point,
} from '@/interaction/motion-geometry';
import { gaussian, type Rng, uniform, unitRandom } from '@/interaction/motion-random';
import { MOTION_REFERENCE, type MotionPolicy } from '@/kernel/tempo';

export interface PathOpts {
  overshoot?: boolean;
  /** Controls correction amplitude for small controls. */
  targetWidthPx?: number;
  /** Both endpoints must be inside these optional viewport bounds. */
  bounds?: ElementRect;
}

function segment(from: Point, to: Point, rng: Rng, policy: MotionPolicy, bounds?: ElementRect): Point[] {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  if (distance <= policy.arrivalPx) return [{ ...to }];
  const direction = { x: (to.x - from.x) / distance, y: (to.y - from.y) / distance };
  const gravity = uniform(rng, ...policy.gravity);
  const windGain = gravity * uniform(rng, ...policy.windGravityRatio);
  const memory = uniform(rng, ...policy.windMemory);
  const innovation = windGain * Math.sqrt(1 - memory * memory);
  const momentum = uniform(rng, ...policy.momentum);
  const scale = clampNum(Math.sqrt(distance / policy.referenceDistancePx), ...policy.distanceScale);
  const maxStep = uniform(rng, ...policy.maxStepPx) * scale;
  const dampingRadius = uniform(rng, ...policy.dampingRadiusPx) * scale;
  const corridor = Math.max(policy.corridorMinPx, distance * policy.corridorFraction);
  let position = { ...from };
  let velocity = { x: 0, y: 0 };
  let wind = { x: 0, y: 0 };
  let speedFactor = uniform(rng, ...policy.speedVariation);
  const points: Point[] = [];

  for (let iteration = 0; iteration < policy.maxIntegrationSteps; iteration++) {
    const dx = to.x - position.x;
    const dy = to.y - position.y;
    const remaining = Math.hypot(dx, dy);
    if (remaining <= policy.arrivalPx) break;
    const approach = Math.min(1, remaining / dampingRadius);
    wind = {
      x: wind.x * memory + gaussian(rng) * innovation * approach,
      y: wind.y * memory + gaussian(rng) * innovation * approach,
    };
    velocity = {
      x: velocity.x * momentum + gravity * dx / remaining + wind.x * approach,
      y: velocity.y * momentum + gravity * dy / remaining + wind.y * approach,
    };
    speedFactor = speedFactor * policy.speedMemory
      + uniform(rng, ...policy.speedVariation) * (1 - policy.speedMemory);
    const speedLimit = Math.min(maxStep * speedFactor,
      Math.sqrt(2 * gravity * remaining) * policy.brakingScale, remaining);
    const speed = Math.hypot(velocity.x, velocity.y);
    if (speed > speedLimit) {
      velocity.x *= speedLimit / speed;
      velocity.y *= speedLimit / speed;
    }
    // Preserve wind's course changes while preventing a stalled/backward tail.
    if (velocity.x * dx + velocity.y * dy <= 0) {
      velocity = { x: speedLimit * dx / remaining, y: speedLimit * dy / remaining };
    }
    let next = { x: position.x + velocity.x, y: position.y + velocity.y };
    const progress = (next.x - from.x) * direction.x + (next.y - from.y) * direction.y;
    const lateral = clampNum((next.y - from.y) * direction.x
      - (next.x - from.x) * direction.y, -corridor, corridor);
    const boundedProgress = clampNum(progress, 0, distance);
    next = containPoint({
      x: from.x + boundedProgress * direction.x - lateral * direction.y,
      y: from.y + boundedProgress * direction.y + lateral * direction.x,
    }, bounds);
    velocity = { x: next.x - position.x, y: next.y - position.y };
    if (Math.hypot(velocity.x, velocity.y) <= Number.EPSILON) break;
    points.push(next);
    position = next;
  }

  // A pathological RNG must still converge without one large final teleport.
  const remaining = Math.hypot(to.x - position.x, to.y - position.y);
  if (remaining === 0) return points;
  const tailSteps = Math.max(1, Math.ceil(remaining / maxStep));
  for (let i = 1; i <= tailSteps; i++) {
    const fraction = i / tailSteps;
    points.push(i === tailSteps ? { ...to } : {
      x: position.x + (to.x - position.x) * fraction,
      y: position.y + (to.y - position.y) * fraction,
    });
  }
  return points;
}

export function windMousePath(from: Point, to: Point, rng: Rng, opts: PathOpts = {},
  policy: MotionPolicy = MOTION_REFERENCE): Point[] {
  assertPoint(from);
  assertPoint(to);
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  if (!Number.isFinite(distance) || distance > policy.maxDistancePx) {
    throw new RangeError('Motion distance exceeds the viewport guardrail');
  }
  if (opts.targetWidthPx !== undefined
    && (!Number.isFinite(opts.targetWidthPx) || opts.targetWidthPx <= 0)) {
    throw new RangeError('Motion target width must be finite and positive');
  }
  if (opts.bounds) {
    assertRect(opts.bounds);
    for (const point of [from, to]) {
      const contained = containPoint(point, opts.bounds);
      if (contained.x !== point.x || contained.y !== point.y) {
        throw new RangeError('Motion endpoints must lie within the viewport bounds');
      }
    }
  }
  if (distance <= policy.arrivalPx) return [{ ...from }, { ...to }];
  const overshoot = opts.overshoot ?? (distance >= policy.overshootMinDistancePx
    && unitRandom(rng) < policy.overshootProbability);
  if (!overshoot) return [{ ...from }, ...segment(from, to, rng, policy, opts.bounds)];
  const amount = Math.min(distance * uniform(rng, ...policy.overshootFraction),
    policy.overshootMaxPx,
    (opts.targetWidthPx ?? policy.overshootMaxPx / policy.overshootTargetFraction)
      * policy.overshootTargetFraction);
  const beyond = containPoint({
    x: to.x + (to.x - from.x) / distance * amount,
    y: to.y + (to.y - from.y) / distance * amount,
  }, opts.bounds);
  if (beyond.x === to.x && beyond.y === to.y) {
    return [{ ...from }, ...segment(from, to, rng, policy, opts.bounds)];
  }
  return [{ ...from }, ...segment(from, beyond, rng, policy, opts.bounds),
    ...segment(beyond, to, rng, policy, opts.bounds)];
}
