/**
 * The engine kit's plan-side fakes: the in-memory follow-back sweep cadence, and
 * the plan over a real store as production builds it (the plan integration tests).
 * Re-exported by `engine-harness.ts`, so suites import from either.
 */

import type { SweepCadence } from '@/engine/engine';
import { PlanService } from '@/governors/plan-service';
import type { PlanView } from '@/governors/plan-types';
import { MS_PER_DAY } from '@/kernel/units';
import { effectiveFromV1 } from '@/settings/effective';
import { toPlanIntent } from '@/settings/plan-intent';
import { DEFAULT_SETTINGS, type Settings } from '@/settings/settings';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { emptyDemand } from './plan';

/**
 * The in-memory follow-back cadence: starts due (a fresh Engine's first
 * eligible step performs a catch-up sweep), then honours the configured
 * interval. Production injects a PERSISTED cadence instead (PRINCIPLES §3).
 */
export const memorySweepCadence = (): SweepCadence => {
  let last = 0;
  return {
    isDue: (now, everyMs) => now - last >= everyMs,
    markRun: (now) => {
      last = now;
    },
  };
};

/** A settable clock the plan reads. */
export interface PlanClock {
  t: number;
  now(): number;
}

export const planClock = (t: number): PlanClock => {
  const c = { t, now: () => c.t };
  return c;
};

/** The plan service over a real store and the given v1 settings, the way the plan wiring builds it. */
export function storePlan(store: KnowledgeStore, clock: PlanClock, settings: Settings = DEFAULT_SETTINGS): PlanService {
  const installEntropy = store.installEntropy();
  return new PlanService({
    store,
    clock,
    installEntropy,
    launchSeed: installEntropy,
    intent: () => toPlanIntent(effectiveFromV1(settings)),
    demand: () => emptyDemand(),
    lastMutationBefore: (t) => store.recentMutationTimes(0).filter((x) => x < t).at(-1) ?? null,
    outsideSince: () => 0,
    deadline: () => null,
    journal: { blocks: () => false },
    runIntent: () => 'running',
    unconfirmed: () => null,
    surfaceGate: { paused: () => false },
  });
}

/** The first plan-day from `from` on whose ideal plan has at least `sessions` sessions with budget. */
export function busyDay(plan: PlanService, from: number, sessions = 3): PlanView {
  for (let d = 0; d < 28; d += 1) {
    const v = plan.view(plan.view(from + d * MS_PER_DAY).window.startsAt);
    if (v.plan.sessions.filter((s) => s.budget > 0).length >= sessions) return v;
  }
  throw new Error('no busy plan-day in four weeks');
}
