/**
 * The day law (spec §5.4 step 2, laws L1 and L6): a plan-day's automatic volume is today's realized
 * law `min(planner volume, cyclePlan)`, drawn once, so no automatic day exceeds automaticDayMax(P0).
 * The oracle below is today's code path: the planner's day draw and the real `cyclePlan`.
 */
import fc from 'fast-check';
import { ACTIVITY, dailyHardCeiling, PATTERN } from '@/kernel/derive';
import { planSeed } from '@/kernel/plan/seed';
import { automaticDayMax, bandDay, dayLawQuantiles, drawVolume } from '@/kernel/plan/volume';
import { mulberry32 } from '@/kernel/rng';
import { normal01 } from '@/timing/distributions';
import { CONSISTENCIES, testIntent } from '../../kit/plan';

/** The legacy per-cycle plan, verbatim (its module retired once the plan drew the day). */
function cyclePlan(cap: number, cycleStartMs: number): number {
  if (cap < PATTERN.CYCLE_PLAN_MIN_CAP) return Math.max(1, Math.round(cap));
  const seed = Math.imul(Math.floor(cycleStartMs / 60_000) >>> 0, 0x9e3779b1) ^ Math.imul(cap, 0x85ebca6b);
  const u = mulberry32(seed)();
  const { CYCLE_PLAN_MIN_FRACTION: lo, CYCLE_PLAN_MAX_FRACTION: hi } = PATTERN;
  return Math.min(cap - 1, Math.max(1, Math.round(cap * (lo + u * (hi - lo)))));
}

/** Today's realized automatic day: the planner's volume capped by the cycle plan. */
function legacyDay(p0: number, ceiling: number, sigma: number, restP: number, rng: () => number, cycleAt: number): number {
  let target: number;
  if (rng() < restP) target = Math.round(p0 * (rng() * PATTERN.REST_DAY_MAX_FRACTION));
  else target = Math.round(p0 * Math.exp(sigma * normal01(rng)));
  return Math.min(Math.max(0, Math.min(ceiling, target)), cyclePlan(p0, cycleAt));
}

/** Two-sample Kolmogorov–Smirnov statistic over integer samples. */
function ks(a: number[], b: number[]): number {
  const xs = [...new Set([...a, ...b])].sort((x, y) => x - y);
  const sa = [...a].sort((x, y) => x - y);
  const sb = [...b].sort((x, y) => x - y);
  let ia = 0;
  let ib = 0;
  let d = 0;
  for (const x of xs) {
    while (ia < sa.length && sa[ia] <= x) ia += 1;
    while (ib < sb.length && sb[ib] <= x) ib += 1;
    d = Math.max(d, Math.abs(ia / sa.length - ib / sb.length));
  }
  return d;
}

const N = 4000;
const LEVELS = [ACTIVITY.minimal, ACTIVITY.light, ACTIVITY.moderate, ACTIVITY.active, ACTIVITY.aggressive];

describe('automaticDayMax', () => {
  test('is the supremum of today\'s cycle plan (14 at 15, 29 at 30, 48 at 50, 73 at 75, 97 at 100)', () => {
    expect(LEVELS.map(automaticDayMax)).toEqual([14, 29, 48, 73, 97]);
    expect(automaticDayMax(9)).toBe(9);
  });

  test('no cycle-plan draw ever exceeds it, and the band reaches it', () => {
    for (let p0 = 1; p0 <= 150; p0 += 1) {
      let seen = 0;
      for (let i = 0; i < 400; i += 1) seen = Math.max(seen, cyclePlan(p0, i * 60_000 * 7919));
      expect(seen).toBeLessThanOrEqual(automaticDayMax(p0));
      expect(bandDay(p0, 0.999999)).toBe(automaticDayMax(p0));
    }
  });
});

describe('L1/L6: the drawn volume', () => {
  test('V ≤ automaticDayMax(P0) at every point and override; a light day is ≤ ⌈0.15 P0⌉', () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 200 }), fc.double({ min: 0, max: 1.5, noNaN: true }),
      fc.double({ min: 0, max: 0.6, noNaN: true }), fc.integer({ min: 0, max: 0xffffffff }),
      (p0, sigma, restP, entropy) => {
        const v = drawVolume(planSeed(entropy, '2026-11-03'), testIntent({ operatingRate: p0, volumeSigma: sigma, restDayProbability: restP }));
        const okRest = !v.rest || v.drawn <= Math.ceil(p0 * PATTERN.REST_DAY_MAX_FRACTION);
        return v.drawn >= 0 && v.drawn <= automaticDayMax(p0) && v.drawn === Math.min(v.lognormal, v.band) && okRest;
      },
    ), { numRuns: 500 });
  });

  test.each(CONSISTENCIES)('$name: the law equals today\'s realized law in distribution (two-sample KS)', (c) => {
    for (const p0 of LEVELS) {
      const intent = testIntent({ operatingRate: p0, volumeSigma: c.volumeSigma, restDayProbability: c.restDayProbability });
      const plan = Array.from({ length: N }, (_, i) => drawVolume(planSeed(0x5eed + p0, `d${i}`), intent).drawn);
      const rng = mulberry32(0xbeef + p0);
      const legacy = Array.from({ length: N }, (_, i) =>
        legacyDay(p0, dailyHardCeiling('moderate') * 4, c.volumeSigma, c.restDayProbability, rng, (i + 1) * 60_000 * 7919));
      expect(ks(plan, legacy)).toBeLessThan(1.63 * Math.sqrt(2 / N));
      expect(Math.max(...plan)).toBeLessThanOrEqual(automaticDayMax(p0));
    }
  });

  test('at P0 = 50, Typical: mean ≈ 0.79·P0, median ≈ 0.88, p10 ≈ 0.58, p90 ≈ 0.94; Even ≈ 0.90, Varied ≈ 0.68', () => {
    const meanOf = (c: (typeof CONSISTENCIES)[number]): number => {
      const intent = testIntent({ operatingRate: 50, volumeSigma: c.volumeSigma, restDayProbability: c.restDayProbability });
      let sum = 0;
      for (let i = 0; i < 20_000; i += 1) sum += drawVolume(planSeed(99, `m${i}`), intent).drawn;
      return sum / 20_000 / 50;
    };
    const [even, typical, varied] = CONSISTENCIES.map(meanOf);
    expect(typical).toBeCloseTo(0.79, 1);
    expect(even).toBeCloseTo(0.9, 1);
    expect(varied).toBeCloseTo(0.68, 1);
    const q = dayLawQuantiles(testIntent({ operatingRate: 50 }));
    expect(q.median / 50).toBeCloseTo(0.88, 1);
    expect(q.p10 / 50).toBeCloseTo(0.58, 1);
    expect(q.p90 / 50).toBeCloseTo(0.94, 1);
  });

  test('binding names what bound the day', () => {
    const intent = testIntent();
    for (let i = 0; i < 500; i += 1) {
      const v = drawVolume(planSeed(3, `b${i}`), intent);
      if (v.rest) expect(v.binding).toBe('light-day');
      else expect(v.binding).toBe(v.lognormal > v.band ? 'band' : 'none');
    }
  });

  test('a draw is a property of the day: the same seed redraws the same volume', () => {
    const seed = planSeed(1234, '2026-11-03');
    expect(drawVolume(seed, testIntent())).toEqual(drawVolume(seed, testIntent()));
  });
});
