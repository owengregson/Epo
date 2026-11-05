import { followbackOutcome } from '../shared/followback-outcome';
import type { KnowledgeStore } from '../store/knowledge-store';
import { FOLLOW_STATES, type FollowRecord } from '../store/types';
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

/** A record as the one classifier reads it (absent fields are null). */
function outcomeOf(r: FollowRecord, windowMs: number, now: number) {
  return followbackOutcome({ state: r.state, followedAt: r.followedAt ?? null, followedBackAt: r.followedBackAt ?? null,
    followbackAfter: r.followbackAfter ?? null, followbackObservedAt: r.followbackObservedAt ?? null,
    reconciledAt: r.reconciledAt ?? null, unfollowReason: r.unfollowReason ?? null }, windowMs, now);
}

/** One pass over the ledger for all sources, folding the one classifier (the UI's target yield folds it too). */
export function matureYields(
  store: Pick<KnowledgeStore, 'followRecordsByState'>,
  now: number,
  windowMs: number = POLICY.outcomeWindowMs,
): Map<string | null, MatureYield> {
  const cohorts = new Map<string | null, MatureYield>([[null, priorYield()]]);
  for (const state of FOLLOW_STATES) {
    for (const record of store.followRecordsByState(state)) {
      if (record.followedAt === undefined) continue;
      const outcome = outcomeOf(record, windowMs, now);
      const keys = record.targetPk === null ? [null] : [null, record.targetPk];
      for (const key of keys) {
        const cohort = cohorts.get(key) ?? priorYield();
        cohorts.set(key, cohort);
        if (outcome === 'pending') cohort.pending += 1;
        // A pre-existing follower cannot be attributed to this follow action: censored with the straddlers.
        else if (outcome === 'censored' || outcome === 'excluded') cohort.censored += 1;
        else {
          cohort.mature += 1;
          if (outcome === 'success') cohort.successes += 1;
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
