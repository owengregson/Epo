export type Rng = () => number;

export interface Point {
  x: number;
  y: number;
}

export interface ElementRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function uniform(rng: Rng, min: number, max: number): number {
  return min + rng() * (max - min);
}

export function gaussian(rng: Rng): number {
  return Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
}

const clampNum = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export const PRESS_MIN_MS = 40;
export const PRESS_MAX_MS = 120;

export function pressDurationMs(rng: Rng): number {
  return Math.round(uniform(rng, PRESS_MIN_MS, PRESS_MAX_MS));
}

export function targetPoint(rect: ElementRect, rng: Rng): Point {
  const marginX = clampNum(rect.width * 0.08, 1, rect.width / 4);
  const marginY = clampNum(rect.height * 0.08, 1, rect.height / 4);
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;

  let dx = gaussian(rng) * (rect.width / 6);
  let dy = gaussian(rng) * (rect.height / 6);
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
    dx = rng() < 0.5 ? -1 : 1;
    dy = rng() < 0.5 ? -0.75 : 0.75;
  }
  return {
    x: clampNum(cx + dx, rect.x + marginX, rect.x + rect.width - marginX),
    y: clampNum(cy + dy, rect.y + marginY, rect.y + rect.height - marginY),
  };
}

export interface PathOpts {
  overshoot?: boolean;
}

export function pathBetween(from: Point, to: Point, rng: Rng, opts: PathOpts = {}): Point[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return [{ ...from }, { ...to }];

  const steps = Math.round(clampNum(dist / 18, 4, 48));

  const arc = uniform(rng, 0.04, 0.14) * dist * (rng() < 0.5 ? -1 : 1);
  const px = -dy / dist;
  const py = dx / dist;

  const wantOvershoot = opts.overshoot ?? (dist > 200 && rng() < 0.3);
  const overshootLen = wantOvershoot ? uniform(rng, 0.03, 0.09) * dist : 0;
  const sweepTarget: Point = wantOvershoot
    ? { x: to.x + (dx / dist) * overshootLen, y: to.y + (dy / dist) * overshootLen }
    : to;

  const cpx = (from.x + sweepTarget.x) / 2 + px * arc;
  const cpy = (from.y + sweepTarget.y) / 2 + py * arc;

  const points: Point[] = [{ ...from }];
  let wobbleX = 0;
  let wobbleY = 0;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    wobbleX = wobbleX * 0.85 + gaussian(rng) * 0.5;
    wobbleY = wobbleY * 0.85 + gaussian(rng) * 0.5;
    const envelope = Math.sin(Math.PI * t);
    points.push({
      x: u * u * from.x + 2 * u * t * cpx + t * t * sweepTarget.x + wobbleX * envelope,
      y: u * u * from.y + 2 * u * t * cpy + t * t * sweepTarget.y + wobbleY * envelope,
    });
  }

  if (wantOvershoot) {
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

export const TRAVEL_BASE_MS = 100;
export const TRAVEL_SCALE_MS = 150;
export const MOVE_MIN_MS = 120;
export const MOVE_MAX_MS = 1400;

export function travelDurationMs(distancePx: number, targetWidthPx: number, rng: Rng): number {
  const w = Math.max(4, targetWidthPx);
  const base = TRAVEL_BASE_MS + TRAVEL_SCALE_MS * Math.log2(Math.max(0, distancePx) / w + 1);
  const noisy = base * (1 + gaussian(rng) * 0.1);
  return Math.round(clampNum(noisy, MOVE_MIN_MS, MOVE_MAX_MS));
}

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

export interface WheelTick {
  deltaPx: number;
  pauseMs: number;
}

export interface WheelPlanOpts {
  overshoot?: boolean;
}

export function wheelPlan(requestedPx: number, rng: Rng, opts: WheelPlanOpts = {}): WheelTick[] {
  if (requestedPx === 0) return [];
  const sign = requestedPx > 0 ? 1 : -1;
  const magnitude = Math.abs(requestedPx);

  const planned = magnitude * uniform(rng, 0.96, 1.05);
  const avgTick = uniform(rng, 60, 130);
  const tickCount = Math.max(1, Math.round(planned / avgTick));

  const overshoot = opts.overshoot ?? (tickCount >= 4 && rng() < 0.35);
  const overshootPx = overshoot ? planned * uniform(rng, 0.04, 0.1) : 0;

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

  const ticks: WheelTick[] = raw.map((w) => ({
    deltaPx: sign * Math.round((mainTotal * w) / rawSum),
    pauseMs: nextPauseMs(rng),
  }));

  if (overshoot) {
    const corrections = 1 + Math.floor(rng() * 3);
    let remaining = Math.round(overshootPx);
    for (let i = 0; i < corrections; i++) {
      const part =
        i === corrections - 1 ? remaining : Math.round(remaining * uniform(rng, 0.3, 0.7));
      if (part <= 0) continue;
      remaining -= part;
      ticks.push({ deltaPx: -sign * part, pauseMs: Math.round(uniform(rng, 120, 300)) });
    }
  }

  const sum = ticks.reduce((a, t) => a + t.deltaPx, 0);
  const drift = Math.round(sign * planned) - sum;
  ticks[Math.min(tickCount - 1, ticks.length - 1)].deltaPx += drift;

  return ticks;
}

function nextPauseMs(rng: Rng): number {
  if (rng() < 0.12) return Math.round(uniform(rng, 180, 450));
  return Math.round(uniform(rng, 30, 90));
}
