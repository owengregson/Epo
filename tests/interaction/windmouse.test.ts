import {
  containPoint, gaussian, intersectRect, movementPlan, pathBetween, stepDelays, targetPoint, travelDurationMs, wheelPlan,
} from '@/interaction/motion-profile';
import { MOTION } from '@/kernel/motion-policy';
import { motionEvidence, motionRng, separation } from './motion-evidence';

describe('WindMouse trajectory invariants', () => {
  test('is reproducible under a seeded source', () => {
    const from = { x: 10, y: 20 };
    const to = { x: 810, y: 620 };
    expect(movementPlan(from, to, 40, motionRng(42)))
      .toEqual(movementPlan(from, to, 40, motionRng(42)));
  });

  test('bounded finite steps, exact endpoints and a speed cap across distances and directions', () => {
    let checked = 0;
    for (const distance of [0.2, 1, 10, 100, 700, 2000]) {
      for (const angle of [0, Math.PI / 3, Math.PI, Math.PI * 1.6]) {
        for (let seed = 0; seed < 32; seed++) {
          const from = { x: 3000.2, y: 3000.7 };
          const to = { x: from.x + Math.cos(angle) * distance,
            y: from.y + Math.sin(angle) * distance };
          const { points, delaysMs } = movementPlan(from, to, 32, motionRng(seed));
          expect(points[0]).toEqual(from);
          expect(points[points.length - 1]).toEqual(to);
          expect(points.length).toBeLessThan(MOTION.maxIntegrationSteps);
          expect(delaysMs).toHaveLength(points.length - 1);
          for (let i = 1; i < points.length; i++) {
            const length = separation(points[i - 1], points[i]);
            expect(Number.isFinite(length)).toBe(true);
            expect(length).toBeGreaterThan(0);
            expect(length).toBeLessThanOrEqual(MOTION.maxStepPx[1] * MOTION.distanceScale[1] + 1e-9);
            expect(delaysMs[i - 1]).toBeGreaterThanOrEqual(MOTION.minEventDelayMs);
            expect(length * 1_000 / delaysMs[i - 1]).toBeLessThanOrEqual(MOTION.peakSpeedPxPerSecond);
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(20_000);
  });

  test('keeps complete trajectories inside the viewport at every edge', () => {
    const bounds = { x: 0, y: 0, width: 800, height: 600 };
    const corners = [{ x: 0, y: 0 }, { x: 800, y: 0 }, { x: 0, y: 600 }, { x: 800, y: 600 }];
    for (let seed = 0; seed < 64; seed++) {
      const from = corners[seed % corners.length];
      const to = corners[(seed + 1) % corners.length];
      const points = pathBetween(from, to, motionRng(seed), { bounds, overshoot: true });
      for (const [i, point] of points.entries()) {
        expect(point.x).toBeGreaterThanOrEqual(0);
        expect(point.x).toBeLessThanOrEqual(bounds.width);
        expect(point.y).toBeGreaterThanOrEqual(0);
        expect(point.y).toBeLessThanOrEqual(bounds.height);
        if (i > 0) expect(separation(points[i - 1], point)).toBeGreaterThan(0);
      }
    }
  });

  test('converges even with degenerate random sources at both interval endpoints', () => {
    for (const draw of [0, 0.5, 1]) {
      const to = { x: 1_000, y: 100 };
      const points = pathBetween({ x: 0, y: 0 }, to, () => draw);
      expect(points[points.length - 1]).toEqual(to);
      expect(points.length).toBeLessThan(MOTION.maxIntegrationSteps * 2);
      expect(points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
    }
  });

  test('a zero-distance plan emits no duplicate motion or artificial wait', () => {
    expect(movementPlan({ x: 5, y: 5 }, { x: 5, y: 5 }, 40, motionRng(8)))
      .toEqual({ points: [{ x: 5, y: 5 }], delaysMs: [] });
  });

  test('rejects invalid coordinates, widths, viewport bounds and distances', () => {
    const point = { x: 5, y: 5 };
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(() => pathBetween(point, { x: bad, y: 0 }, motionRng(9))).toThrow(RangeError);
      expect(() => targetPoint({ x: 0, y: 0, width: bad, height: 5 }, motionRng(9))).toThrow(RangeError);
      expect(() => wheelPlan(bad, motionRng(9))).toThrow(RangeError);
      expect(() => travelDurationMs(bad, 5, motionRng(9))).toThrow(RangeError);
    }
    expect(() => movementPlan(point, point, 0, motionRng(9))).toThrow(RangeError);
    expect(() => pathBetween(point, { x: 100_000, y: 0 }, motionRng(9))).toThrow(RangeError);
    expect(() => pathBetween(point, { x: 11, y: 2 }, motionRng(9),
      { bounds: { x: 0, y: 0, width: 10, height: 10 } })).toThrow(RangeError);
  });
});

describe('motion distribution evidence', () => {
  test('500 seeded trajectories vary spatially and temporally while arriving precisely', () => {
    const evidence = motionEvidence();
    expect(evidence.exactEndpoints).toBe(evidence.samples);
    expect(evidence.uniquePaths).toBe(evidence.samples);
    expect(evidence.uniqueCadences).toBe(evidence.samples);
    expect(evidence.durationMs.cv).toBeGreaterThan(0.1);
    expect(evidence.durationMs.cv).toBeLessThan(0.25);
    expect(evidence.overshoots).toBeGreaterThan(50);
    expect(evidence.overshoots).toBeLessThan(150);
    expect(evidence.peakSpeedPxPerSecond.max).toBeLessThanOrEqual(MOTION.peakSpeedPxPerSecond);
    expect(evidence.pathLengthRatio.max).toBeLessThan(1.4);
    expect(evidence.lateralDeviationPx.median).toBeGreaterThan(8);
    expect(evidence.tailToMidSpeedRatio.p90).toBeLessThan(0.4);
  });

  test('longer and smaller-target moves have longer median durations', () => {
    const durations = (distance: number, width: number): number => {
      const totals = Array.from({ length: 100 }, (_, seed) => {
        const plan = movementPlan({ x: 0, y: 0 }, { x: distance, y: 0 }, width, motionRng(seed));
        return plan.delaysMs.reduce((sum, value) => sum + value, 0);
      }).sort((a, b) => a - b);
      return totals[totals.length / 2];
    };
    expect(durations(700, 40)).toBeGreaterThan(durations(100, 40));
    expect(durations(700, 8)).toBeGreaterThan(durations(700, 80));
  });

  test('very short and duration-capped moves retain timing variation at their bounds', () => {
    for (const distance of [1, 30_000]) {
      const durations = Array.from({ length: 500 }, (_, seed) =>
        travelDurationMs(distance, 40, motionRng(seed)));
      expect(new Set(durations).size).toBeGreaterThan(30);
      expect(durations.filter((value) => value === MOTION.moveMinMs || value === MOTION.moveMaxMs).length)
        .toBeLessThan(20);
    }
  });

  test('click sampling has no clamp-edge pileups and handles subpixel controls', () => {
    const rng = motionRng(40);
    const rect = { x: 10, y: 20, width: 100, height: 40 };
    const tiny = { x: 0.2, y: 0.3, width: 0.1, height: 0.1 };
    for (let i = 0; i < 1_000; i++) {
      const point = targetPoint(rect, rng);
      expect(point.x).toBeGreaterThan(18);
      expect(point.x).toBeLessThan(102);
      const subpixel = targetPoint(tiny, rng);
      expect(subpixel.x).toBeGreaterThan(tiny.x);
      expect(subpixel.x).toBeLessThan(tiny.x + tiny.width);
      expect(subpixel.y).toBeGreaterThan(tiny.y);
      expect(subpixel.y).toBeLessThan(tiny.y + tiny.height);
    }
  });

  test('nonzero tiny scrolls never produce a zero wheel event', () => {
    for (const delta of [-1, -0.01, 0.01, 1]) {
      const plan = wheelPlan(delta, motionRng(41));
      expect(plan.length).toBeGreaterThan(0);
      expect(plan.every((tick) => Math.sign(tick.deltaPx) === Math.sign(delta))).toBe(true);
    }
  });

  test('partially clipped controls are targeted only inside their visible hit area', () => {
    const viewport = { x: 0, y: 0, width: 160, height: 100 };
    const target = { x: -10, y: 90, width: 30, height: 40 };
    expect(intersectRect(target, viewport)).toEqual({ x: 0, y: 90, width: 20, height: 10 });
    for (let seed = 0; seed < 100; seed++) {
      const point = targetPoint(target, motionRng(seed), viewport);
      expect(point.x).toBeGreaterThan(0);
      expect(point.x).toBeLessThan(20);
      expect(point.y).toBeGreaterThan(90);
      expect(point.y).toBeLessThan(100);
    }
    const hidden = { x: 160, y: 0, width: 20, height: 20 };
    expect(intersectRect(hidden, viewport)).toBeNull();
    expect(() => targetPoint(hidden, motionRng(1), viewport)).toThrow(RangeError);
    expect(() => containPoint({ x: 10, y: 20 }, { ...viewport, width: NaN })).toThrow(RangeError);
  });

  test('step delay apportionment conserves the exact feasible duration', () => {
    for (let steps = 1; steps < 100; steps++) {
      const total = 271 + steps;
      expect(stepDelays(total, steps, motionRng(steps)).reduce((sum, value) => sum + value, 0))
        .toBe(total);
    }
    expect(() => stepDelays(Infinity, 10, motionRng(42))).toThrow(RangeError);
    expect(Number.isFinite(gaussian(() => 1))).toBe(true);
    expect(() => gaussian(() => NaN)).toThrow(RangeError);
  });
});
