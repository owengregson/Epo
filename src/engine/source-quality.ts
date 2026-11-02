import type { KnowledgeStore } from '../store/knowledge-store';
import { FOLLOW_STATES } from '../store/types';
import { EXPLORATION_POLICY as POLICY } from './exploration-policy';

export interface MatureYield {
  mature: number;
  successes: number;
  pending: number;
  censored: number;
  rate: number;
}

export function priorYield(): MatureYield {
  return { mature: 0, successes: 0, pending: 0, censored: 0, rate: POLICY.priorRate };
}

/** One pass over the ledger for all sources, independent of how many hubs are ranked. */
export function matureYields(
  store: Pick<KnowledgeStore, 'followRecordsByState'>,
  now: number,
  windowMs: number = POLICY.outcomeWindowMs,
): Map<string | null, MatureYield> {
  const cohorts = new Map<string | null, MatureYield>([[null, priorYield()]]);
  for (const state of FOLLOW_STATES) {
    for (const record of store.followRecordsByState(state)) {
      if (record.followedAt === undefined) continue;
      const horizon = record.followedAt + windowMs;
      const keys = record.targetPk === null ? [null] : [null, record.targetPk];
      for (const key of keys) {
        const cohort = cohorts.get(key) ?? priorYield();
        cohorts.set(key, cohort);
        if (horizon > now) cohort.pending += 1;
        // An unknown event time cannot establish which side of the horizon it occurred.
        // A pre-existing follower cannot be attributed to this follow action either.
        else if ((record.followedBackAt !== undefined && record.followedBackAt < record.followedAt) ||
          (record.followedBackAt === undefined && (record.followbackObservedAt !== undefined ||
            record.reconciledAt === undefined || record.reconciledAt < horizon))) cohort.censored += 1;
        else {
          cohort.mature += 1;
          if (record.followedBackAt !== undefined && record.followedBackAt <= horizon) cohort.successes += 1;
        }
      }
    }
  }
  for (const cohort of cohorts.values()) {
    cohort.rate = (cohort.successes + POLICY.priorRate * POLICY.priorWeight) / (cohort.mature + POLICY.priorWeight);
  }
  return cohorts;
}

/** Fixed-horizon outcomes: a follow made yesterday is not evidence of failure. */
export function matureYield(
  store: Pick<KnowledgeStore, 'followRecordsByState'>,
  targetPk: string | null,
  now: number,
  windowMs: number = POLICY.outcomeWindowMs,
): MatureYield {
  return matureYields(store, now, windowMs).get(targetPk) ?? priorYield();
}

/** Overlap with recently worked sources, over observed memberships only. Unknown is not zero. */
export function observedOverlap(
  store: Pick<KnowledgeStore, 'followersOf'>,
  targetPk: string,
  comparisonPks: readonly string[],
): number | null {
  const audience = store.followersOf(targetPk);
  if (audience.length === 0) return null;
  const previous = new Set(comparisonPks.filter((pk) => pk !== targetPk).flatMap((pk) => store.followersOf(pk)));
  return audience.filter((pk) => previous.has(pk)).length / audience.length;
}
