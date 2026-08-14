/**
 * Motion profile — the PURE human-likeness math behind the Humanizer.
 *
 * Everything here is deterministic given an injected rng (`() => number` in
 * [0,1)), touches no DOM/Electron/timers, and is unit-tested directly:
 * cursor paths (Bezier arc + optional overshoot-and-settle + tremor jitter),
 * Fitts's-law move durations with a bell-shaped per-step velocity profile,
 * gaussian click-point sampling inside a hitbox, wheel-tick scroll plans with
 * human cadence, and the mouse-button hold time.
 *
 * Every numeric range carries a comment justifying it; keep the justifications
 * honest when tuning. NOTE (timing-branch coordination): these are INPUT-GESTURE
 * micro-timings, not inter-action delays — they deliberately do not use the
 * engine's sleep/delay helpers.
 */

/** Injectable randomness source: uniform in [0, 1). */
export type Rng = () => number;

export interface Point {
  x: number;
  y: number;
}

/** A DOM-style bounding rect (viewport CSS px, as getBoundingClientRect gives). */
export interface ElementRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// Random helpers
// ---------------------------------------------------------------------------

/** Uniform draw in [min, max). */
export function uniform(rng: Rng, min: number, max: number): number {
  return min + rng() * (max - min);
}

/**
 * Standard-normal draw (Box–Muller). `1 - rng()` keeps the log argument in
 * (0, 1] so a raw 0 from the rng can never produce -Infinity.
 */
export function gaussian(rng: Rng): number {
  return Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
}

const clampNum = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

// ---------------------------------------------------------------------------
// Mouse-button hold
// ---------------------------------------------------------------------------

/**
 * Button press → release: routine mouse clicks measure ~60–100 ms of button-down
 * time in input-latency studies; 40/120 cover the fast-clicker and deliberate
 * tails without ever looking machine-instant (<20 ms) or hesitant (>200 ms).
 */
export const HOLD_MIN_MS = 40;
export const HOLD_MAX_MS = 120;

/** Randomized mouse-button hold duration, uniform in [40, 120] ms. */
export function holdDurationMs(rng: Rng): number {
  return Math.round(uniform(rng, HOLD_MIN_MS, HOLD_MAX_MS));
}

// ---------------------------------------------------------------------------
// Click-point sampling
// ---------------------------------------------------------------------------

/**
 * Where inside a hitbox a human actually clicks: a 2D gaussian centered on the
 * middle of the element (people aim for the middle), with σ = dimension / 6 so
 * ~99.7 % of raw samples land inside ±half the dimension — biased toward the
 * center but visibly spread. Samples are clamped to an inner margin of 8 % of
 * each dimension (min 1 px, never more than a quarter) so a click can never
 * land ON the edge, and a dead-center hit (a robot tell — humans are never
 * pixel-exact) is nudged off by ~1 px.
 */
export function clickPoint(rect: ElementRect, rng: Rng): Point {
  const marginX = clampNum(rect.width * 0.08, 1, rect.width / 4);
  const marginY = clampNum(rect.height * 0.08, 1, rect.height / 4);
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;

  let dx = gaussian(rng) * (rect.width / 6);
  let dy = gaussian(rng) * (rect.height / 6);
  // Never the exact center: nudge a (vanishingly rare) dead-center sample.
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
    dx = rng() < 0.5 ? -1 : 1;
    dy = rng() < 0.5 ? -0.75 : 0.75;
  }
  return {
    x: clampNum(cx + dx, rect.x + marginX, rect.x + rect.width - marginX),
    y: clampNum(cy + dy, rect.y + marginY, rect.y + rect.height - marginY),
  };
}

// ---------------------------------------------------------------------------
// Cursor paths
// ---------------------------------------------------------------------------

export interface CursorPathOpts {
  /**
   * Force the overshoot decision (tests). When omitted it is drawn from the
   * rng: fast, long mouse moves overshoot the target and settle back — pointing
   * studies see this on roughly a quarter to a third of ballistic moves — so
   * ~30 % of moves longer than 200 px get an overshoot leg here.
   */
  overshoot?: boolean;
}

/**
 * A human cursor path from `from` to `to`:
 *
 *  - Quadratic (parabolic) Bezier whose control point sits perpendicular to
 *    the straight line at 4–14 % of the distance — real mouse traces bow along
 *    a smooth arc, never ruler-straight. Side (left/right) is a coin flip.
 *  - Optional overshoot-and-settle: the main sweep lands 3–9 % of the distance
 *    PAST the target, then 3–5 short settle points come back onto it.
 *  - Smooth tremor: a DAMPED RANDOM WALK (per-step gaussian kicks of σ≈0.5 px,
 *    decayed 15 %/step) scaled by a sin(πt) envelope so the wobble fades in
 *    from the start and back out on approach. Correlated noise waves like a
 *    hand; independent per-point jitter would pixel-shiver — a synthetic tell.
 *  - The FINAL point is exactly `to` (the click lands where it was aimed).
 *
 * Point count scales with distance (one point per ~16 ms frame over a
 * Fitts-scaled duration, clamped 4–48) so short hops are a few points and long
 * sweeps stay smooth.
 */
export function cursorPath(from: Point, to: Point, rng: Rng, opts: CursorPathOpts = {}): Point[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return [{ ...from }, { ...to }];

  // ~1 point per 16 ms frame of a typical Fitts-scaled move, clamped 4–48.
  const steps = Math.round(clampNum(dist / 18, 4, 48));

  // Bow: perpendicular arc of 4–14 % of distance, side chosen by coin flip.
  const arc = uniform(rng, 0.04, 0.14) * dist * (rng() < 0.5 ? -1 : 1);
  const px = -dy / dist; // unit perpendicular
  const py = dx / dist;

  const wantOvershoot = opts.overshoot ?? (dist > 200 && rng() < 0.3);
  // Overshoot lands 3–9 % of the distance past the target along the travel line.
  const overshootLen = wantOvershoot ? uniform(rng, 0.03, 0.09) * dist : 0;
  const sweepTarget: Point = wantOvershoot
    ? { x: to.x + (dx / dist) * overshootLen, y: to.y + (dy / dist) * overshootLen }
    : to;

  const cpx = (from.x + sweepTarget.x) / 2 + px * arc;
  const cpy = (from.y + sweepTarget.y) / 2 + py * arc;

  const points: Point[] = [{ ...from }];
  // Smooth tremor state: a damped random walk (correlated noise), not
  // independent per-point jitter — hands wave, they do not pixel-shiver.
  let wobbleX = 0;
  let wobbleY = 0;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    // σ ≈ 0.5 px kicks, 15 %/step decay → a few px of slow waviness at most;
    // the sin(πt) envelope pins the wobble to zero at launch and arrival.
    wobbleX = wobbleX * 0.85 + gaussian(rng) * 0.5;
    wobbleY = wobbleY * 0.85 + gaussian(rng) * 0.5;
    const envelope = Math.sin(Math.PI * t);
    points.push({
      x: u * u * from.x + 2 * u * t * cpx + t * t * sweepTarget.x + wobbleX * envelope,
      y: u * u * from.y + 2 * u * t * cpy + t * t * sweepTarget.y + wobbleY * envelope,
    });
  }

  if (wantOvershoot) {
    // Settle: 3–5 short corrective points easing from the overshoot back onto
    // the target (a decelerating second sub-movement, per pointing models).
    points.push({ ...sweepTarget });
    const settleSteps = 3 + Math.floor(rng() * 3);
    for (let i = 1; i < settleSteps; i++) {
      const t = i / settleSteps;
      const ease = 1 - (1 - t) ** 2;
      points.push({
        x: sweepTarget.x + (to.x - sweepTarget.x) * ease + gaussian(rng) * 0.3,
        y: sweepTarget.y + (to.y - sweepTarget.y) * ease + gaussian(rng) * 0.3,
      });
    }
  }

  points.push({ ...to });
  return points;
}

// ---------------------------------------------------------------------------
// Move timing (Fitts's law + bell-shaped velocity)
// ---------------------------------------------------------------------------

/**
 * Fitts's-law constants for mouse pointing: MT = a + b·log2(D/W + 1) with
 * a ≈ 100 ms (reaction/settling floor) and b ≈ 150 ms/bit — mid-range of the
 * classic mouse regressions (MacKenzie reports a in ‑100…200, b in 100…200).
 */
export const FITTS_A_MS = 100;
export const FITTS_B_MS = 150;
/** Whole-move clamp: no human move completes under ~120 ms or drags past 1.4 s. */
export const MOVE_MIN_MS = 120;
export const MOVE_MAX_MS = 1400;

/**
 * Total duration for a move of `distancePx` onto a target of effective width
 * `targetWidthPx`, with ±10 % gaussian noise (repeated human moves over the
 * same distance vary by roughly that much), clamped to [120, 1400] ms.
 */
export function fittsDurationMs(distancePx: number, targetWidthPx: number, rng: Rng): number {
  const w = Math.max(4, targetWidthPx);
  const base = FITTS_A_MS + FITTS_B_MS * Math.log2(Math.max(0, distancePx) / w + 1);
  const noisy = base * (1 + gaussian(rng) * 0.1);
  return Math.round(clampNum(noisy, MOVE_MIN_MS, MOVE_MAX_MS));
}

/**
 * Split a total move duration into per-step delays with a bell-shaped velocity
 * profile: velocity peaks mid-flight (minimum-jerk-like, v ∝ s·(1−s) along the
 * normalized path), so equal-space steps take LONGER at both ends (slow start,
 * decelerating arrival) and less time in the middle. The velocity floor (0.15)
 * keeps endpoint steps finite. Each step gets ±15 % gaussian jitter, then the
 * whole vector is rescaled so the delays sum to `totalMs` exactly (± rounding).
 */
export function stepDelays(totalMs: number, steps: number, rng: Rng): number[] {
  if (steps <= 0) return [];
  const weights: number[] = [];
  for (let i = 0; i < steps; i++) {
    const s = (i + 0.5) / steps;
    const velocity = Math.max(0.15, 4 * s * (1 - s));
    const jitter = 1 + gaussian(rng) * 0.15;
    weights.push(Math.max(0.05, jitter / velocity));
  }
  const sum = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => Math.max(1, Math.round((totalMs * w) / sum)));
}

// ---------------------------------------------------------------------------
// Scroll plans
// ---------------------------------------------------------------------------

/** One wheel tick: a scroll delta (DOM sign: positive = content down) + the pause after it. */
export interface ScrollTick {
  deltaPx: number;
  pauseMs: number;
}

export interface ScrollPlanOpts {
  /** Force the over-scroll decision (tests); default drawn from the rng. */
  overshoot?: boolean;
}

/**
 * A human wheel-scroll plan covering ~`requestedPx` (sign = direction):
 *
 *  - Total distance is randomized to 96–105 % of the request — nobody scrolls
 *    an exact pixel amount; the caller re-measures next round anyway.
 *  - Tick sizes: one wheel notch scrolls ~60–130 px in desktop Chrome
 *    (default ~100 px/notch, varying with OS "lines per notch" settings), so
 *    the average tick is drawn from that band per plan.
 *  - Envelope: magnitudes ramp up over the first ~30 % of ticks and decay over
 *    the last ~30 % — flick-style scrolling accelerates then trails off.
 *  - Cadence: 30–90 ms between notches (sustained scrolling runs ~10–25
 *    notches/sec), with a 12 % chance per tick of a 180–450 ms micro-pause
 *    (skim-reading stalls mid-scroll).
 *  - Over-scroll: ~35 % of plans overshoot by 4–10 % of the distance and then
 *    correct with 1–3 opposite-sign ticks — people flick past and nudge back.
 *
 * The SIGNED sum of all ticks always lands within the 96–105 % band of the
 * request (tested), so callers can treat the plan as "≈ the distance asked".
 */
export function scrollPlan(requestedPx: number, rng: Rng, opts: ScrollPlanOpts = {}): ScrollTick[] {
  if (requestedPx === 0) return [];
  const sign = requestedPx > 0 ? 1 : -1;
  const magnitude = Math.abs(requestedPx);

  // 96–105 % of the request: slight under/over, never exact.
  const planned = magnitude * uniform(rng, 0.96, 1.05);
  // Average wheel notch 60–130 px (Chrome default ≈ 100 px/notch).
  const avgTick = uniform(rng, 60, 130);
  const tickCount = Math.max(1, Math.round(planned / avgTick));

  // ~35 % of longer scrolls overshoot and correct back.
  const overshoot = opts.overshoot ?? (tickCount >= 4 && rng() < 0.35);
  // Overshoot by 4–10 % of the planned distance.
  const overshootPx = overshoot ? planned * uniform(rng, 0.04, 0.1) : 0;

  // Raw magnitudes under the ramp-up/decay envelope (30 % ramps each side).
  const raw: number[] = [];
  for (let i = 0; i < tickCount; i++) {
    const s = tickCount === 1 ? 0.5 : i / (tickCount - 1);
    const rampIn = Math.min(1, s / 0.3 + 0.35);
    const rampOut = Math.min(1, (1 - s) / 0.3 + 0.35);
    const jitter = 1 + gaussian(rng) * 0.12;
    raw.push(Math.max(0.2, Math.min(rampIn, rampOut) * jitter));
  }
  const rawSum = raw.reduce((a, b) => a + b, 0);
  const mainTotal = planned + overshootPx;

  const ticks: ScrollTick[] = raw.map((w) => ({
    deltaPx: sign * Math.round((mainTotal * w) / rawSum),
    pauseMs: nextPauseMs(rng),
  }));

  if (overshoot) {
    // 1–3 corrective ticks of the opposite sign, summing the overshoot back out.
    const corrections = 1 + Math.floor(rng() * 3);
    let remaining = Math.round(overshootPx);
    for (let i = 0; i < corrections; i++) {
      const part =
        i === corrections - 1 ? remaining : Math.round(remaining * uniform(rng, 0.3, 0.7));
      if (part <= 0) continue;
      remaining -= part;
      // A beat before the correction: noticing the overshoot takes a moment.
      ticks.push({ deltaPx: -sign * part, pauseMs: Math.round(uniform(rng, 120, 300)) });
    }
  }

  // Rounding drift correction on the last main tick: keep the signed sum in band.
  const sum = ticks.reduce((a, t) => a + t.deltaPx, 0);
  const drift = Math.round(sign * planned) - sum;
  ticks[Math.min(tickCount - 1, ticks.length - 1)].deltaPx += drift;

  return ticks;
}

/** Inter-notch pause: 30–90 ms cadence with a 12 % chance of a 180–450 ms skim stall. */
function nextPauseMs(rng: Rng): number {
  if (rng() < 0.12) return Math.round(uniform(rng, 180, 450));
  return Math.round(uniform(rng, 30, 90));
}
