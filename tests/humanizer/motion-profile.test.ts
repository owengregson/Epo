/**
 * Motion-profile math: pure, deterministic under an injected rng. Covers path
 * endpoint accuracy + monotone approach, overshoot geometry, click-point
 * distribution bounds, Fitts durations, step-delay budgets, scroll-plan sums
 * and cadence bounds, and hold-duration bounds.
 */
import {
  HOLD_MAX_MS,
  HOLD_MIN_MS,
  MOVE_MAX_MS,
  MOVE_MIN_MS,
  clickPoint,
  cursorPath,
  fittsDurationMs,
  gaussian,
  holdDurationMs,
  scrollPlan,
  stepDelays,
  type ElementRect,
  type Point,
} from '@/humanizer/motion-profile';

/** mulberry32 — a tiny deterministic PRNG for reproducible sampling. */
const mulberry32 = (seed: number) => (): number => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

describe('gaussian', () => {
  test('is roughly standard-normal (mean ≈ 0, sd ≈ 1 over many draws)', () => {
    const rng = mulberry32(1);
    const n = 4000;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const g = gaussian(rng);
      sum += g;
      sumSq += g * g;
    }
    const mean = sum / n;
    const sd = Math.sqrt(sumSq / n - mean * mean);
    expect(Math.abs(mean)).toBeLessThan(0.08);
    expect(sd).toBeGreaterThan(0.9);
    expect(sd).toBeLessThan(1.1);
  });
});

describe('holdDurationMs', () => {
  test('always within the documented 40–120 ms band', () => {
    const rng = mulberry32(2);
    for (let i = 0; i < 1000; i++) {
      const ms = holdDurationMs(rng);
      expect(ms).toBeGreaterThanOrEqual(HOLD_MIN_MS);
      expect(ms).toBeLessThanOrEqual(HOLD_MAX_MS);
    }
  });

  test('varies (not a constant)', () => {
    const rng = mulberry32(3);
    const draws = new Set(Array.from({ length: 50 }, () => holdDurationMs(rng)));
    expect(draws.size).toBeGreaterThan(10);
  });
});

describe('clickPoint', () => {
  const rect: ElementRect = { x: 100, y: 200, width: 120, height: 40 };

  test('every sample stays strictly inside the rect, off the edges', () => {
    const rng = mulberry32(4);
    for (let i = 0; i < 2000; i++) {
      const p = clickPoint(rect, rng);
      expect(p.x).toBeGreaterThan(rect.x);
      expect(p.x).toBeLessThan(rect.x + rect.width);
      expect(p.y).toBeGreaterThan(rect.y);
      expect(p.y).toBeLessThan(rect.y + rect.height);
    }
  });

  test('never the exact center', () => {
    const rng = mulberry32(5);
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    for (let i = 0; i < 2000; i++) {
      const p = clickPoint(rect, rng);
      expect(p.x === cx && p.y === cy).toBe(false);
    }
  });

  test('is center-biased: the sample mean sits near the middle', () => {
    const rng = mulberry32(6);
    let sx = 0;
    let sy = 0;
    const n = 2000;
    for (let i = 0; i < n; i++) {
      const p = clickPoint(rect, rng);
      sx += p.x;
      sy += p.y;
    }
    expect(Math.abs(sx / n - (rect.x + rect.width / 2))).toBeLessThan(rect.width * 0.05);
    expect(Math.abs(sy / n - (rect.y + rect.height / 2))).toBeLessThan(rect.height * 0.05);
  });

  test('tiny rects still yield interior points', () => {
    const tiny: ElementRect = { x: 10, y: 10, width: 5, height: 5 };
    const rng = mulberry32(7);
    for (let i = 0; i < 500; i++) {
      const p = clickPoint(tiny, rng);
      expect(p.x).toBeGreaterThan(tiny.x);
      expect(p.x).toBeLessThan(tiny.x + tiny.width);
      expect(p.y).toBeGreaterThan(tiny.y);
      expect(p.y).toBeLessThan(tiny.y + tiny.height);
    }
  });
});

describe('cursorPath', () => {
  const from: Point = { x: 40, y: 60 };
  const to: Point = { x: 640, y: 420 };

  test('starts at from and ends EXACTLY at the target', () => {
    for (let seed = 10; seed < 30; seed++) {
      const path = cursorPath(from, to, mulberry32(seed));
      expect(path[0]).toEqual(from);
      expect(path[path.length - 1]).toEqual(to);
      expect(path.length).toBeGreaterThanOrEqual(4);
    }
  });

  test('without overshoot, distance to the target is monotonically non-increasing (≤2px tolerance)', () => {
    for (let seed = 30; seed < 50; seed++) {
      const path = cursorPath(from, to, mulberry32(seed), { overshoot: false });
      for (let i = 1; i < path.length; i++) {
        expect(dist(path[i], to)).toBeLessThanOrEqual(dist(path[i - 1], to) + 2);
      }
    }
  });

  test('with overshoot, some point passes the target before settling exactly onto it', () => {
    for (let seed = 50; seed < 60; seed++) {
      const path = cursorPath(from, to, mulberry32(seed), { overshoot: true });
      const total = dist(from, to);
      const maxProgress = Math.max(...path.map((p) => dist(from, p)));
      expect(maxProgress).toBeGreaterThan(total + 1); // went past
      expect(maxProgress).toBeLessThan(total * 1.15); // …but only a few percent
      expect(path[path.length - 1]).toEqual(to); // …and settled exactly
    }
  });

  test('the path visibly bows away from the straight line (never ruler-straight)', () => {
    const path = cursorPath(from, to, mulberry32(60), { overshoot: false });
    // Max perpendicular deviation from the from→to line across the path.
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy);
    const dev = Math.max(
      ...path.map((p) => Math.abs(((p.x - from.x) * dy - (p.y - from.y) * dx) / len)),
    );
    expect(dev).toBeGreaterThan(2);
  });

  test('the arc is SMOOTH: consecutive segment headings turn gently (no zig-zag shiver)', () => {
    for (let seed = 62; seed < 72; seed++) {
      const path = cursorPath(from, to, mulberry32(seed), { overshoot: false });
      for (let i = 2; i < path.length; i++) {
        const a = Math.atan2(path[i - 1].y - path[i - 2].y, path[i - 1].x - path[i - 2].x);
        const b = Math.atan2(path[i].y - path[i - 1].y, path[i].x - path[i - 1].x);
        let turn = Math.abs(b - a);
        if (turn > Math.PI) turn = 2 * Math.PI - turn;
        // A parabolic arc with damped-random-walk tremor turns a few degrees per
        // step; independent per-point jitter would zig-zag far harder than 30°.
        expect(turn).toBeLessThan(Math.PI / 6);
      }
    }
  });

  test('noise varies between runs: two seeds trace different paths to the same target', () => {
    const a = cursorPath(from, to, mulberry32(73), { overshoot: false });
    const b = cursorPath(from, to, mulberry32(74), { overshoot: false });
    const differs = a.some((p, i) => b[i] === undefined || p.x !== b[i].x || p.y !== b[i].y);
    expect(differs).toBe(true);
  });

  test('a zero-length move degenerates to [from, to]', () => {
    const p: Point = { x: 5, y: 5 };
    expect(cursorPath(p, p, mulberry32(61))).toEqual([p, p]);
  });
});

describe('fittsDurationMs', () => {
  test('always within the whole-move clamp', () => {
    const rng = mulberry32(70);
    for (const d of [0, 10, 100, 500, 2000]) {
      for (let i = 0; i < 50; i++) {
        const ms = fittsDurationMs(d, 40, rng);
        expect(ms).toBeGreaterThanOrEqual(MOVE_MIN_MS);
        expect(ms).toBeLessThanOrEqual(MOVE_MAX_MS);
      }
    }
  });

  test('longer moves take longer (noise held fixed)', () => {
    const flat: () => number = () => 0.5; // gaussian(0.5, …) → deterministic noise
    expect(fittsDurationMs(1200, 40, flat)).toBeGreaterThan(fittsDurationMs(80, 40, flat));
  });
});

describe('stepDelays', () => {
  test('sums to ≈ the total budget and every delay is positive', () => {
    const rng = mulberry32(80);
    for (const [total, steps] of [
      [400, 12],
      [900, 30],
      [150, 5],
    ] as const) {
      const delays = stepDelays(total, steps, rng);
      expect(delays).toHaveLength(steps);
      for (const d of delays) expect(d).toBeGreaterThan(0);
      const sum = delays.reduce((a, b) => a + b, 0);
      expect(Math.abs(sum - total)).toBeLessThanOrEqual(steps); // ± rounding
    }
  });

  test('bell-shaped velocity: endpoint steps take longer than mid-flight steps', () => {
    const flat: () => number = () => 0.5;
    const delays = stepDelays(600, 20, flat);
    const mid = delays[10];
    expect(delays[0]).toBeGreaterThan(mid);
    expect(delays[delays.length - 1]).toBeGreaterThan(mid);
  });

  test('zero steps yields an empty plan', () => {
    expect(stepDelays(500, 0, mulberry32(81))).toEqual([]);
  });
});

describe('scrollPlan', () => {
  test('signed tick sum lands within the documented 96–105 % band of the request', () => {
    for (let seed = 90; seed < 120; seed++) {
      const plan = scrollPlan(1800, mulberry32(seed));
      const sum = plan.reduce((a, t) => a + t.deltaPx, 0);
      expect(sum).toBeGreaterThanOrEqual(1800 * 0.96 - 1);
      expect(sum).toBeLessThanOrEqual(1800 * 1.05 + 1);
    }
  });

  test('a downward request scrolls down; an upward request scrolls up', () => {
    const down = scrollPlan(900, mulberry32(121), { overshoot: false });
    for (const t of down) expect(t.deltaPx).toBeGreaterThan(0);
    const up = scrollPlan(-900, mulberry32(122), { overshoot: false });
    for (const t of up) expect(t.deltaPx).toBeLessThan(0);
  });

  test('overshoot plans contain opposite-sign corrective ticks yet still sum in band', () => {
    for (let seed = 130; seed < 140; seed++) {
      const plan = scrollPlan(1500, mulberry32(seed), { overshoot: true });
      expect(plan.some((t) => t.deltaPx < 0)).toBe(true); // the correction
      const sum = plan.reduce((a, t) => a + t.deltaPx, 0);
      expect(sum).toBeGreaterThanOrEqual(1500 * 0.96 - 1);
      expect(sum).toBeLessThanOrEqual(1500 * 1.05 + 1);
    }
  });

  test('pauses stay within the human cadence bounds (30–90 ms, micro-pauses ≤ 450 ms)', () => {
    for (let seed = 140; seed < 160; seed++) {
      for (const t of scrollPlan(2400, mulberry32(seed))) {
        expect(t.pauseMs).toBeGreaterThanOrEqual(30);
        expect(t.pauseMs).toBeLessThanOrEqual(450);
      }
    }
  });

  test('zero distance yields an empty plan', () => {
    expect(scrollPlan(0, mulberry32(161))).toEqual([]);
  });
});
