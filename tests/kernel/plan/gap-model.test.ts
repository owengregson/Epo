/**
 * The gap model (spec §5.10, laws L2 and L4): rate-neutral targets (Balanced 303.9 s), τ ≥ 1 solved
 * against a memoized seeded estimate, τ = 1 reproducing today's planner draw, an exact velocity wake
 * and a cap that never lets a gap end a session.
 */
import fc from 'fast-check';
import { CAUTION, RHYTHM, SESSION } from '@/kernel/derive';
import {
  drawGapMs,
  effectiveGapAtPace1,
  gapCapMax,
  scaleShape,
  solveGapSpec,
  stationaryMeanGapMs,
  sustainedGapMs,
  targetMeanMs,
  velocityWakeAt,
} from '@/kernel/plan/gap';
import { inverseNormal } from '@/kernel/plan/seed';
import type { GapShape } from '@/kernel/plan/types';
import { mulberry32 } from '@/kernel/rng';
import { MS_PER_HOUR, MS_PER_MINUTE, MS_PER_SECOND } from '@/kernel/units';
import { clamp, logNormal } from '@/timing/distributions';
import { sample } from '@/timing/primitives';
import { testIntent } from '../../kit/plan';

const shapeOf = (rhythm: keyof typeof RHYTHM, caution: keyof typeof CAUTION): GapShape => ({
  medianMs: RHYTHM[rhythm].gapMedianSeconds * MS_PER_SECOND,
  sigma: SESSION.GAP_SIGMA,
  floorMs: Math.min(CAUTION[caution].floorSeconds, RHYTHM[rhythm].gapMedianSeconds) * MS_PER_SECOND,
  capMs: SESSION.GAP_CAP_MS,
  hawkesAlpha: SESSION.HAWKES_ALPHA,
  hawkesTauMs: SESSION.HAWKES_TAU_MS,
});
const BALANCED = shapeOf('sessions', 'standard');

/** A session simulated with fresh uniforms: its gaps and the dispatch times. */
function simulate(spec: GapShape, budget: number, sessions: number, seed: number): { gaps: number[]; times: number[][] } {
  const rng = mulberry32(seed);
  const u = (): number => (Math.floor(rng() * 4294967296) + 0.5) / 4294967296;
  const gaps: number[] = [];
  const times: number[][] = [];
  for (let s = 0; s < sessions; s += 1) {
    const t = [0];
    for (let k = 1; k < budget; k += 1) {
      const g = drawGapMs(spec, t, t[t.length - 1], u);
      gaps.push(g);
      t.push(t[t.length - 1] + g);
    }
    times.push(t);
  }
  return { gaps, times };
}
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

describe('targets', () => {
  test('Standard 303.9 s, Cautious 477.6 s, Bold 222.9 s at pace 1; the briskest session runs at H/1.3', () => {
    expect(targetMeanMs(CAUTION.standard.cap, 1, null) / MS_PER_SECOND).toBeCloseTo(303.9, 1);
    expect(targetMeanMs(CAUTION.cautious.cap, 1, null) / MS_PER_SECOND).toBeCloseTo(477.6, 1);
    expect(targetMeanMs(CAUTION.bold.cap, 1, null) / MS_PER_SECOND).toBeCloseTo(222.9, 1);
    expect(MS_PER_HOUR / targetMeanMs(CAUTION.standard.cap, 0.7, null)).toBeCloseTo(CAUTION.standard.cap / 1.3, 6);
  });

  test('an override only lengthens the target', () => {
    const derived = sustainedGapMs(CAUTION.standard.cap);
    expect(targetMeanMs(CAUTION.standard.cap, 1, derived / 2)).toBe(derived);
    expect(targetMeanMs(CAUTION.standard.cap, 1.2, 400_000)).toBe(480_000);
  });
});

describe('the solved spec', () => {
  test('Balanced: the model mean is 303.9 s ± 1 % with τ ≈ 2.9 and a floor ≈ 130 s', () => {
    const target = targetMeanMs(CAUTION.standard.cap, 1, null);
    const spec = solveGapSpec(BALANCED, target, 11, null);
    expect(stationaryMeanGapMs(spec, 11) / target).toBeGreaterThan(0.99);
    expect(stationaryMeanGapMs(spec, 11) / target).toBeLessThan(1.01);
    expect(spec.timeScale).toBeGreaterThan(2.6);
    expect(spec.timeScale).toBeLessThan(3.2);
    expect(spec.floorMs / MS_PER_SECOND).toBeGreaterThan(115);
    expect(spec.floorMs / MS_PER_SECOND).toBeLessThan(145);
    expect(spec.targetMeanMs).toBeCloseTo(target, 6);
  });

  test('the estimate is memoized and deterministic', () => {
    const a = stationaryMeanGapMs(BALANCED, 9);
    expect(stationaryMeanGapMs({ ...BALANCED }, 9)).toBe(a);
    expect(a / MS_PER_SECOND).toBeGreaterThan(95);
    expect(a / MS_PER_SECOND).toBeLessThan(115);
  });

  test('L2: target ≥ 3600·1.3/H; the realized mean lies in [0.97, 1.05] × target; the rolling hour rarely passes H', () => {
    const cases = (['cautious', 'standard', 'bold'] as const).flatMap((c) =>
      (['trickle', 'sessions', 'bursts'] as const).flatMap((r) => [0.7, 1, 1.45].map((pace) => ({ c, r, pace }))));
    for (const { c, r, pace } of cases) {
      const h = CAUTION[c].cap;
      const spec = solveGapSpec(shapeOf(r, c), targetMeanMs(h, pace, null), 12, null);
      expect(spec.targetMeanMs).toBeGreaterThanOrEqual((3600_000 * 1.3) / h);
      expect(spec.timeScale).toBeGreaterThanOrEqual(1);
      const sim = simulate(spec, 12, 400, 0xa11ce);
      const ratio = mean(sim.gaps) / spec.targetMeanMs;
      expect(ratio).toBeGreaterThan(0.97);
      expect(ratio).toBeLessThan(1.05);
      let over = 0;
      let total = 0;
      for (const t of sim.times) {
        for (let i = 0; i < t.length; i += 1) {
          total += 1;
          if (t.filter((x) => x > t[i] - MS_PER_HOUR && x <= t[i]).length > h) over += 1;
        }
      }
      expect(over / total).toBeLessThan(0.01);
    }
  });

  test('L4: cap·τ ≤ CAP_MAX ≈ 28.7 min, and CAP_MAX plus the slowest pre-action span stays under the boundary', () => {
    const capMax = gapCapMax();
    expect(capMax / MS_PER_MINUTE).toBeCloseTo(28.7, 1);
    expect(capMax).toBeLessThan(SESSION.SESSION_BOUNDARY_MS);
    fc.assert(fc.property(fc.constantFrom('cautious', 'standard', 'bold'), fc.constantFrom('trickle', 'sessions', 'bursts'),
      fc.double({ min: 0.7, max: 1.45, noNaN: true }), (c, r, pace) => {
        const spec = solveGapSpec(shapeOf(r, c), targetMeanMs(CAUTION[c].cap, pace, null), 10, null);
        return spec.capMs <= capMax && spec.floorMs <= spec.capMs;
      }), { numRuns: 30 });
  });

  test('the floor override only lengthens the effective floor', () => {
    const target = targetMeanMs(CAUTION.standard.cap, 1, null);
    const plain = solveGapSpec(BALANCED, target, 11, null);
    expect(solveGapSpec(BALANCED, target, 11, 60_000).floorMs).toBe(plain.floorMs);
    expect(solveGapSpec(BALANCED, target, 11, 200_000).floorMs).toBe(200_000);
  });
});

describe('the draw', () => {
  /** An rng whose Box–Muller pairs yield exactly the given normals. */
  const boxMullerFor = (zs: number[]): (() => number) => {
    const vals = zs.flatMap((zz) => [1 - Math.exp(-(zz * zz) / 2), zz >= 0 ? 0 : 0.5]);
    let i = 0;
    return () => vals[i++];
  };

  test('τ = 1 reproduces today\'s planner formula (clamped log-normal, compressed above the floor)', () => {
    fc.assert(fc.property(fc.array(fc.double({ min: 0.001, max: 0.999, noNaN: true }), { minLength: 4, maxLength: 4 }),
      fc.array(fc.integer({ min: 1, max: 3_500_000 }), { maxLength: 8 }), (us, ago) => {
        const now = 10 * MS_PER_HOUR;
        const recent = [now, ...ago.map((a) => now - a)];
        const zs = us.map(inverseNormal);
        const base = sample(clamp(logNormal(BALANCED.medianMs, BALANCED.sigma), BALANCED.floorMs, BALANCED.capMs), boxMullerFor(zs));
        let excitation = 1;
        for (const t of recent) excitation += BALANCED.hawkesAlpha * Math.exp(-(now - t) / BALANCED.hawkesTauMs);
        const legacy = BALANCED.floorMs + Math.round(Math.max(0, base - BALANCED.floorMs) / excitation);
        return drawGapMs(scaleShape(BALANCED, 1), recent, now, (a) => us[a]) === legacy;
      }), { numRuns: 300 });
  });

  test('the velocity wake is exact: the instant the rolling hour holds H − 1', () => {
    const now = 5 * MS_PER_HOUR;
    const times = Array.from({ length: 22 }, (_, i) => now - 50 * MS_PER_MINUTE + i * MS_PER_MINUTE);
    expect(velocityWakeAt(times, 22, now)).toBe(times[0] + MS_PER_HOUR);
    expect(velocityWakeAt(times, 23, now)).toBeNull();
    expect(velocityWakeAt([...times, now - 2 * MS_PER_HOUR], 22, now)).toBe(times[0] + MS_PER_HOUR);
    expect(velocityWakeAt([...times, now], 22, now)).toBe(times[1] + MS_PER_HOUR);
  });
});

describe('the gap rows on the effective scale (Settings recommendations)', () => {
  test('Standard ≈ 304 s typical and ≈ 130 s shortest; Cautious ≈ 477 s; Bold ≈ 223 s', () => {
    const std = effectiveGapAtPace1(testIntent());
    expect(std.typicalMs / MS_PER_SECOND).toBeCloseTo(303.9, 0);
    expect(std.minimumMs / MS_PER_SECOND).toBeGreaterThan(115);
    expect(std.minimumMs / MS_PER_SECOND).toBeLessThan(145);
    const cautious = effectiveGapAtPace1(testIntent({ hourlyCap: CAUTION.cautious.cap }));
    expect(cautious.typicalMs / MS_PER_SECOND).toBeCloseTo(477.6, 0);
    const bold = effectiveGapAtPace1(testIntent({ hourlyCap: CAUTION.bold.cap }));
    expect(bold.typicalMs / MS_PER_SECOND).toBeCloseTo(222.9, 0);
  });

  test('overrides lengthen both rows and never shorten them', () => {
    const base = effectiveGapAtPace1(testIntent());
    const slower = effectiveGapAtPace1(testIntent({ gapTargetOverrideMs: 400_000, gapFloorOverrideMs: 180_000 }));
    expect(slower.typicalMs).toBe(400_000);
    expect(slower.minimumMs).toBeGreaterThanOrEqual(180_000);
    const faster = effectiveGapAtPace1(testIntent({ gapTargetOverrideMs: 60_000, gapFloorOverrideMs: 10_000 }));
    expect(faster).toEqual(base);
  });
});
