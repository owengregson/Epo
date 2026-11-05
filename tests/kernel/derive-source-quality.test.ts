import fc from 'fast-check';
import { sourceCohortSize, sourceQueueCapacity } from '@/kernel/derive-source-quality';
import { EXPLORATION_POLICY } from '@/kernel/exploration-policy';

test('the configured plan supplies readiness even when no writes remain today', () => {
  for (const remaining of [0, 1, 4, 5, 100]) {
    const settings = { dailyPlanSize: 100, lowWaterCandidates: 5, remaining };
    expect(sourceQueueCapacity(settings.dailyPlanSize)).toBe(EXPLORATION_POLICY.queuedPerSource);
    expect(sourceCohortSize(settings)).toBe(5);
  }
});

test.each([0, -1, 0.9])('a plan with no whole actions (%s) cannot prepare a cohort', (dailyPlanSize) => {
  expect(sourceQueueCapacity(dailyPlanSize)).toBe(0);
  expect(sourceCohortSize({ dailyPlanSize, lowWaterCandidates: 5 })).toBe(0);
});

test('a small configured plan caps readiness while a large low-water value cannot exceed source capacity', () => {
  expect(sourceCohortSize({ dailyPlanSize: 3, lowWaterCandidates: 5 })).toBe(3);
  expect(sourceCohortSize({ dailyPlanSize: 100, lowWaterCandidates: 100 })).toBe(EXPLORATION_POLICY.queuedPerSource);
  expect(sourceCohortSize({ dailyPlanSize: 100, lowWaterCandidates: 0 })).toBe(1);
  expect(sourceCohortSize({ dailyPlanSize: 100, lowWaterCandidates: 4.9 })).toBe(4);
});

test('positive configured plans always require a whole cohort within both plan and source limits', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 500 }), fc.integer({ min: 0, max: 100 }),
    (dailyPlanSize, lowWaterCandidates) => {
      const size = sourceCohortSize({ dailyPlanSize, lowWaterCandidates });
      expect(Number.isInteger(size)).toBe(true);
      expect(size).toBeGreaterThanOrEqual(1);
      expect(size).toBeLessThanOrEqual(dailyPlanSize);
      expect(size).toBeLessThanOrEqual(sourceQueueCapacity(dailyPlanSize));
      expect(size).toBeLessThanOrEqual(EXPLORATION_POLICY.queuedPerSource);
    }));
});
