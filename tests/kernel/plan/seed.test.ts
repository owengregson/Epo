/**
 * Counter-based seeding (spec §5.2): draws are pure functions of their coordinates, so a new draw
 * site shifts no other, a lost plan re-derives the same numbers, and the phase never moves.
 */
import fc from 'fast-check';
import { inverseNormal, phaseFromUniform, phaseOffsetHours, planSeed, u, z } from '@/kernel/plan/seed';
import { BOUNDS } from '@/kernel/policy';

const entropy = fc.integer({ min: 0, max: 0xffffffff });
const coord = fc.oneof(fc.string({ maxLength: 12 }), fc.integer({ min: 0, max: 50 }));

describe('u and z', () => {
  test('u lies strictly inside (0, 1) at every seed and coordinate', () => {
    fc.assert(fc.property(entropy, fc.array(coord, { maxLength: 4 }), (seed, coords) => {
      const x = u(seed, ...coords);
      return x > 0 && x < 1;
    }));
  });

  test('order independence: a coordinate draws the same value whatever was drawn before or after', () => {
    fc.assert(fc.property(entropy, fc.array(fc.array(coord, { maxLength: 3 }), { maxLength: 8 }), (seed, others) => {
      const before = u(seed, 'volume');
      const tempo = z(seed, 'tempo', 2);
      for (const c of others) u(seed, ...c);
      return u(seed, 'volume') === before && z(seed, 'tempo', 2) === tempo;
    }));
  });

  test('distinct coordinates spread: no two of 200 sessions share a start draw', () => {
    const seed = planSeed(12345, '2026-11-03');
    const draws = new Set(Array.from({ length: 200 }, (_, s) => u(seed, 'start', s)));
    expect(draws.size).toBe(200);
  });

  test('z is Φ⁻¹(u): the Acklam approximation matches known quantiles', () => {
    expect(inverseNormal(0.5)).toBeCloseTo(0, 12);
    expect(inverseNormal(0.975)).toBeCloseTo(1.959964, 5);
    expect(inverseNormal(0.025)).toBeCloseTo(-1.959964, 5);
    expect(inverseNormal(0.9)).toBeCloseTo(1.281552, 5);
    expect(inverseNormal(0.001)).toBeCloseTo(-3.090232, 5);
    expect(inverseNormal(0)).toBe(Number.NEGATIVE_INFINITY);
    expect(inverseNormal(1)).toBe(Number.POSITIVE_INFINITY);
  });

  test('z over many coordinates is standard normal (mean ≈ 0, variance ≈ 1)', () => {
    const seed = planSeed(7, '2026-01-01');
    const xs = Array.from({ length: 20_000 }, (_, i) => z(seed, 'tempo', i));
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
    expect(Math.abs(mean)).toBeLessThan(0.03);
    expect(Math.abs(variance - 1)).toBeLessThan(0.05);
  });
});

describe('the day seed and the phase', () => {
  test('a day seed depends on the install and the day key only (A → B → A restores A)', () => {
    fc.assert(fc.property(entropy, (e) => {
      const a = planSeed(e, '2026-11-03');
      const b = planSeed(e, '2026-11-04');
      return a !== b && planSeed(e, '2026-11-03') === a && Number.isInteger(a) && a >= 0;
    }));
  });

  test('the phase is install-seeded: no day key reaches it, and it stays inside the jitter band', () => {
    const max = BOUNDS.CIRCADIAN.PHASE_JITTER_MAX_HOURS;
    fc.assert(fc.property(entropy, (e) => {
      const p = phaseOffsetHours(e);
      return p === phaseOffsetHours(e) && p >= -max && p <= max;
    }));
  });

  test('a repair re-derives the identical phase, so the current window never moves', () => {
    const phases = [1, 2, 3].map(() => phaseOffsetHours(0xdeadbeef));
    expect(new Set(phases).size).toBe(1);
  });

  test('phaseFromUniform spans the symmetric band', () => {
    expect(phaseFromUniform(0, 1.5)).toBe(-1.5);
    expect(phaseFromUniform(0.5, 1.5)).toBe(0);
    expect(phaseFromUniform(1, 1.5)).toBe(1.5);
  });
});
