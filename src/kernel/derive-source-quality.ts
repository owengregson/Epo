/** Source readiness derives from the configured plan, never the few writes left near day-end. */
import { EXPLORATION_POLICY } from './exploration-policy';

export function sourceQueueCapacity(dailyPlanSize: number): number {
  return Math.max(0, Math.min(Math.floor(dailyPlanSize), EXPLORATION_POLICY.queuedPerSource));
}

export function sourceCohortSize(s: { dailyPlanSize: number; lowWaterCandidates: number }): number {
  const capacity = sourceQueueCapacity(s.dailyPlanSize);
  return capacity === 0 ? 0 : Math.max(1, Math.min(Math.floor(s.lowWaterCandidates), capacity));
}
