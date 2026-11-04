/**
 * Pure conductor decisions — the predicates and selections `engine.ts` used to
 * inline. Nothing here touches wall-clock time, Instagram, or engine state:
 * every input is an argument, so each rule is unit-testable without a store,
 * a clock, or a fake port (the store slices below are read-only reads).
 */

import type { AcquireEndReason } from '../rim/follower-acquisition';
import type { AccountState, FollowRecord, FollowState } from '../store/types';
import type { FailureKind } from './recovery';

/** The read-only store slice these decisions consult. */
export interface DecisionStore {
  followRecordsByState(state: FollowState): FollowRecord[];
  candidatePksForTarget(targetPk: string): string[];
  getAccount(pk: string): AccountState | null;
}

/** How many `queued` follow-records aim at this target. */
export function queuedCountFor(store: DecisionStore, targetPk: string): number {
  return store.followRecordsByState('queued').filter((r) => r.targetPk === targetPk).length;
}

/**
 * Up to `cap` usernames from the target's raw pool worth an enrichment fetch: username known, neither
 * profiled nor failed since `freshSince` (the weekly cycle of plan-days, spec §5.16; absent, nothing
 * observed lapses). A changed profile or an old failure is retried once its window lapses.
 */
export function unenrichedUsernames(
  store: DecisionStore,
  targetPk: string,
  cap: number,
  freshSince: number = Number.NEGATIVE_INFINITY,
): string[] {
  const usernames: string[] = [];
  for (const pk of store.candidatePksForTarget(targetPk)) {
    if (usernames.length >= cap) break;
    const acc = store.getAccount(pk);
    if (acc === null) continue;
    if (acc.enrichment === 'profiled' && (acc.statsObservedAt === undefined || acc.statsObservedAt >= freshSince)) continue;
    if (acc.username === undefined) continue;
    if (acc.enrichFailedAt !== undefined && acc.enrichFailedAt >= freshSince) continue;
    usernames.push(acc.username);
  }
  return usernames;
}

/** Which action a step takes; null when neither stream has work. */
export type ActionChoice = 'lifecycle' | 'prune' | null;

export interface PickActionOpts {
  /** Interleave probability ceiling for a woven prune unfollow. */
  unfollowFraction: number;
  /**
   * The interleave draw, or null when no draw was taken. PURE by construction:
   * the fact source takes the draw (exactly when both streams have work and the
   * lifecycle record is not itself an unfollow), so this decision consumes no
   * randomness and can be property-tested.
   */
  draw: number | null;
}

/**
 * Lifecycle churn and woven prune unfollows share ONE action stream. When both
 * are available they interleave with a bounded probability so a session is
 * never unfollow-dominated — but a DUE lifecycle unfollow is never displaced
 * (it is time-sensitive).
 */
export function pickAction(
  due: FollowRecord | null,
  pruneCand: { pk: string; username: string } | null,
  opts: PickActionOpts,
): ActionChoice {
  if (due !== null && pruneCand !== null) {
    if (due.state !== 'unfollow_queued' && opts.draw !== null && opts.draw < opts.unfollowFraction) {
      return 'prune';
    }
    return 'lifecycle';
  }
  if (due !== null) return 'lifecycle';
  if (pruneCand !== null) return 'prune';
  return null;
}

/**
 * The refill path's verdict on a FAILED acquire: the first walled cycles take
 * the long backoff park (a rate wall must not spin the refill loop at pacing
 * speed); the `entryThreshold`-th in a row escalates to the recovery ladder,
 * carrying drift evidence when the read itself reported shape drift.
 */
export type AcquireFailureVerdict =
  | { action: 'backoff'; walledCycles: number }
  | { action: 'recover'; kind: FailureKind };

export function acquireFailureVerdict(
  walledCycles: number,
  endReason: AcquireEndReason,
  entryThreshold: number,
): AcquireFailureVerdict {
  const next = walledCycles + 1;
  if (next >= entryThreshold) {
    return { action: 'recover', kind: endReason === 'shape-mismatch' ? 'drift' : 'rate-limited' };
  }
  return { action: 'backoff', walledCycles: next };
}
