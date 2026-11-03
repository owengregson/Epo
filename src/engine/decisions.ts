/**
 * Pure conductor decisions — the predicates and selections `engine.ts` used to
 * inline. Nothing here touches wall-clock time, Instagram, or engine state:
 * every input is an argument, so each rule is unit-testable without a store,
 * a clock, or a fake port (the store slices below are read-only reads).
 */

import { bandDay, u } from '../kernel/plan';
import { MS_PER_MINUTE } from '../kernel/units';
import type { AcquireEndReason } from '../rim/follower-acquisition';
import type { AccountState, FollowRecord, FollowState } from '../store/types';
import { startOfLocalDay } from '../timing/units';
import { EXPLORATION_POLICY } from './exploration-policy';
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
 * Up to `cap` usernames from the target's raw pool that still lack counts and
 * are worth an enrichment fetch: not yet `profiled`, username known, and not
 * outside the failed-enrichment cooldown. Changed profiles and old failures
 * become eligible for a bounded retry after the freshness window.
 */
export function unenrichedUsernames(
  store: DecisionStore,
  targetPk: string,
  cap: number,
  now: number = 0,
): string[] {
  const usernames: string[] = [];
  for (const pk of store.candidatePksForTarget(targetPk)) {
    if (usernames.length >= cap) break;
    const acc = store.getAccount(pk);
    if (acc === null) continue;
    if (acc.enrichment === 'profiled' &&
      (now === 0 || acc.statsObservedAt === undefined || now - acc.statsObservedAt < EXPLORATION_POLICY.profileFreshMs)) continue;
    if (acc.username === undefined) continue;
    if (acc.enrichFailedAt !== undefined && now - acc.enrichFailedAt < EXPLORATION_POLICY.enrichmentRetryMs) continue;
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

/** Ms until the next local `activeHoursStart` o'clock (always strictly future). */
export function msUntilActiveWindow(now: number, activeHoursStart: number): number {
  const next = new Date(now);
  next.setHours(activeHoursStart, 0, 0, 0);
  if (next.getTime() <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now;
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

/**
 * Prune's cap boundary: growth's active-hours cycle start when a governor is
 * wired, else local midnight — so an overnight window's post-midnight tail
 * spends the cycle it belongs to.
 */
export function pruneCycleStart(now: number, cycleStartMs?: (now: number) => number): number {
  return cycleStartMs?.(now) ?? startOfLocalDay(now);
}

/**
 * Today's planned prune volume: the plan's automatic-day band drawn under
 * `dailyLimit` from the plan-day's start (restart-stable; another day or limit
 * draws again), so the amount pruned per day fluctuates under the limit.
 */
export function pruneDailyPlan(dailyLimit: number, cycleStart: number): number {
  return bandDay(dailyLimit, u(Math.floor(cycleStart / MS_PER_MINUTE) >>> 0, 'prune-band', dailyLimit));
}
