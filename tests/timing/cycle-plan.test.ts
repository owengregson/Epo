import { PATTERN } from '@/timing/config';
import { cyclePlan } from '@/timing/cycle-plan';

describe('cyclePlan — per-cycle volume drawn just under the cap', () => {
  const CYCLE = new Date(2026, 7, 20, 11, 0, 0, 0).getTime();

  test('deterministic: the same cycle and cap always draw the same plan', () => {
    expect(cyclePlan(165, CYCLE)).toBe(cyclePlan(165, CYCLE));
    expect(cyclePlan(100, CYCLE)).toBe(cyclePlan(100, CYCLE));
  });

  test('stays inside the configured band, strictly under the cap', () => {
    for (const cap of [10, 50, 100, 130, 165, 500]) {
      for (let day = 0; day < 30; day += 1) {
        const plan = cyclePlan(cap, CYCLE + day * 86_400_000);
        expect(plan).toBeLessThan(cap);
        expect(plan).toBeGreaterThanOrEqual(Math.floor(cap * PATTERN.CYCLE_PLAN_MIN_FRACTION));
        expect(plan).toBeLessThanOrEqual(Math.ceil(cap * PATTERN.CYCLE_PLAN_MAX_FRACTION));
      }
    }
  });

  test('varies from cycle to cycle', () => {
    const draws = new Set(
      Array.from({ length: 14 }, (_, day) => cyclePlan(165, CYCLE + day * 86_400_000)),
    );
    expect(draws.size).toBeGreaterThan(3);
  });

  test('different caps draw independently within the same cycle', () => {
    const a = cyclePlan(165, CYCLE) / 165;
    const b = cyclePlan(100, CYCLE) / 100;
    expect(a).not.toBeCloseTo(b, 3);
  });

  test('caps too small for a meaningful under-shoot pass through unchanged', () => {
    expect(PATTERN.CYCLE_PLAN_MIN_CAP).toBeGreaterThan(1);
    for (let cap = 1; cap < PATTERN.CYCLE_PLAN_MIN_CAP; cap += 1) {
      expect(cyclePlan(cap, CYCLE)).toBe(cap);
    }
  });
});
