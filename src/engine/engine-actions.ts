/**
 * The growth loop's action steps: the paced action gate, one churn action with
 * the ladder's breakers, and one woven prune unfollow, run against the Engine's context.
 */

import { tempoOrReference } from '../kernel/tempo';
import type { FollowRecord } from '../store/types';
import { RECOVERY as RECOVERY_TIMING } from '../timing/config';
import type { WaitResult } from '../timing/delay-manager';
import type { DelayPolicy } from '../timing/primitives';
import * as log from '../utils/logger';
import type { ChurnActionOutcome } from './churn-types';
import type { EngineWaitKey } from './engine-waits';
import type { FeedCandidate } from './facts';
import { isUnverifiedOutcome } from './mutation-outcome';
import type { EngineTempo, EngineWriteKind } from './plan-port';
import type { EngineDeps, EngineState, EngineUnfollowFeed, StepResult } from './ports';
import type { FailureKind, RecoveryIncident, RecoverySupervisor } from './recovery';
import { UnconfirmedBreaker } from './unconfirmed-breaker';

/** What one action attempt produced: the verb that landed, or a StepResult that ends the iteration outright. */
export type ActionOutcome =
  | { kind: 'follow' | 'unfollow'; step?: undefined }
  | { kind?: undefined; step: StepResult };

/** The slice of the Engine the action steps read and write. */
export interface EngineActionContext {
  readonly deps: EngineDeps & EngineTempo;
  readonly recovery: RecoverySupervisor;
  readonly unfollowFeed: EngineUnfollowFeed;
  /** Consecutive failed actions that enter the recovery ladder (`ACTIONS_FAILING_HALT`). */
  readonly actionsFailingHalt: number;
  /** True once a refill ran since the last action. */
  refillSinceAction: boolean;
  /** Epoch ms of the last action that landed. */
  lastActionAt: number | null;
  stateNow(): EngineState;
  superseded(token: AbortController): boolean;
  engineWait(key: EngineWaitKey, policyOrMs: DelayPolicy | number): Promise<WaitResult>;
  /** The idle beat until the next known event (spec §5.16). */
  idleWait(now: number): Promise<WaitResult>;
  enterRecovery(token: AbortController, kind: FailureKind): Promise<StepResult>;
  noteProgress(phase: string): void;
  healIncidentWindow(incident: RecoveryIncident): void;
}

/** The plan's own park for a refusal before the visit (spec §5.13 S2 item 3); none for a refusal with no instant. */
const DEFERRAL_PARK: Readonly<Record<string, EngineWaitKey>> = {
  deadline: 'engine:action-delay',
  'session-closed': 'engine:session-park',
  'quiet-hours': 'engine:session-park',
  'day-off': 'engine:session-park',
  'day-done': 'engine:daily-ceiling-park',
  ceiling: 'engine:daily-ceiling-park',
  'hourly-cap': 'engine:velocity-park',
  probation: 'engine:velocity-park',
  'read-budget': 'engine:read-budget-park',
};

/** Park exactly until a typed deferral's instant (no idle-and-revisit), else the idle beat. */
async function serveDeferral(ctx: EngineActionContext, outcome: ChurnActionOutcome | null | undefined): Promise<void> {
  const now = ctx.deps.clock.now();
  const v = outcome?.verdict;
  const key = v?.kind === 'deferred' ? DEFERRAL_PARK[v.reason] : undefined;
  if (v?.kind === 'deferred' && key !== undefined && v.until !== null && v.until > now) {
    await ctx.engineWait(key, v.until - now);
    return;
  }
  await ctx.idleWait(now);
}

/** The owed deadline, when it is still in the future. */
function owedMs(ctx: EngineActionContext): number {
  return (ctx.deps.store.getActionDelayDeadline() ?? 0) - ctx.deps.clock.now();
}

/**
 * THE one Instagram action per iteration (spec §5.13 S2): serve the deadline still owed (armed at a
 * previous dispatch, persisted, so a relaunch serves its remainder), act, then wait on the deadline
 * the dispatch closure armed. The loop draws no gap of its own.
 */
export async function performAction(
  ctx: EngineActionContext,
  _now: number,
  token: AbortController,
  act: (actAt: number) => Promise<ActionOutcome>,
): Promise<StepResult> {
  // Interruptible: a fresh pause during the remainder leaves the deadline owed and parks without acting.
  const owed = owedMs(ctx);
  if (owed > 0) {
    const res = await ctx.engineWait('engine:action-delay', owed);
    if (!res.completed) return 'idle';
  }
  const actAt = ctx.deps.clock.now();
  ctx.refillSinceAction = false;
  const outcome = await act(actAt);
  if (outcome.kind === undefined) return outcome.step;
  ctx.lastActionAt = actAt;
  if (ctx.stateNow() !== 'paused' && !ctx.superseded(token)) {
    const remaining = owedMs(ctx);
    if (remaining > 0) await ctx.engineWait('engine:action-delay', remaining);
  }
  return 'acted';
}

/**
 * Feed a dispatched write's evidence to the plan's breaker (spec §11.1 F7). An unverified one parks
 * (pace-up), or enters the ladder once the streak reaches the blocked entry; null when nothing was unverified.
 */
async function unverifiedStep(ctx: EngineActionContext, kind: EngineWriteKind, outcome: ChurnActionOutcome | null | undefined,
  actAt: number, token: AbortController, park: EngineWaitKey): Promise<StepResult | null> {
  const unverified = isUnverifiedOutcome(outcome);
  // Instagram answered: the write landed, was refused, or drifted — evidence either way. A tab stall is neither.
  const confirmed = outcome?.status === 'ok' || outcome?.status === 'failed'
    || (outcome?.status === 'blocked' && outcome.cause === 'rate-limited');
  if (!unverified && !confirmed) return null;
  const streak = ctx.deps.pacing.noteOutcome(kind, unverified, actAt);
  if (!unverified) return null;
  if (UnconfirmedBreaker.entersLadder(streak)) {
    log.warn('engine: Instagram confirmed none of the last writes of this kind — entering recovery', { kind, streak });
    return ctx.enterRecovery(token, 'rate-limited');
  }
  // Dispatched with no Instagram evidence (ADR 0308): a park, never a rate-wall signal by itself.
  await ctx.engineWait(park, tempoOrReference(ctx.deps.tempo).base('park.blocked'));
  return 'idle';
}

/** One woven prune unfollow: the feed owns the ledger row + edge reconcile. */
export async function actWovenUnfollow(
  ctx: EngineActionContext,
  cand: FeedCandidate,
  actAt: number,
  token: AbortController,
): Promise<ActionOutcome> {
  const status = await ctx.unfollowFeed.executeUnfollow(cand, actAt);
  // A stop()+start() landed during the await: the new generation owns pacing
  // now — bail before recording, arming, or serving anything.
  if (ctx.superseded(token)) return { step: 'aborted' };
  const detail = ctx.unfollowFeed.lastActionOutcome?.();
  const unverified = await unverifiedStep(ctx, 'unfollow', detail, actAt, token, 'engine:prune-park');
  if (unverified !== null) return { step: unverified };
  if (status === 'blocked') {
    if (detail?.cause === 'rate-limited') return { step: await ctx.enterRecovery(token, 'rate-limited') };
    // A refusal before the visit yields: an instant the plan names is served exactly, otherwise the next
    // tick's mix sees the refusal and takes a follow (spec §9.7); the candidate stays unvisited.
    if (detail?.cause === 'local-policy') {
      await serveDeferral(ctx, detail);
      return { step: 'idle' };
    }
    // The journal retains unresolved effects; no failed attempt consumes the candidate.
    await ctx.engineWait('engine:prune-park', tempoOrReference(ctx.deps.tempo).base('park.blocked'));
    return { step: 'idle' };
  }
  if (status === 'simulated') ctx.deps.pacing.practiced(actAt);
  if (status === 'ok' && !detail?.alreadyInState) ctx.noteProgress('mutation-verified');
  return { kind: 'unfollow' };
}

/** One lifecycle churn action, with the ladder's breakers on its outcome. */
export async function actChurn(
  ctx: EngineActionContext,
  rec: FollowRecord,
  actAt: number,
  token: AbortController,
): Promise<ActionOutcome> {
  const outcome = await ctx.deps.churn.execute(rec, actAt);
  // A stop()+start() landed during the await: the superseded step's owed gap
  // is dropped rather than allowed to overwrite the new run's deadline.
  if (ctx.superseded(token)) return { step: 'aborted' };

  const kind: EngineWriteKind = rec.state === 'unfollow_queued' ? 'unfollow' : 'follow';
  const detail = ctx.deps.churn.lastActionOutcome?.();
  const unverified = await unverifiedStep(ctx, kind, detail, actAt, token, 'engine:blocked-park');
  if (unverified !== null) return { step: unverified };
  if (outcome === 'blocked') {
    if (ctx.deps.churn.lastBlockedCause() === 'local-policy') {
      await serveDeferral(ctx, detail);
      return { step: 'idle' };
    }
    // Nothing was clicked and the record is untouched. Re-driving the SAME
    // record at full pace hammers the wall invisibly — park briefly instead,
    // and ladder up once the streak (or IG's own verdict) proves a wall.
    ctx.recovery.noteOutcome('rate-limited');
    const blockedStreak = ctx.deps.churn.streaks().blocked;
    if (ctx.deps.churn.lastBlockedCause() === 'rate-limited') {
      // A definitive server refusal: every further attempt deepens the block.
      log.warn('engine: Instagram refused the action as rate-limited — entering recovery', {
        blockedStreak,
      });
      return { step: await ctx.enterRecovery(token, 'rate-limited') };
    }
    if (blockedStreak >= RECOVERY_TIMING.BLOCKED_STREAK_ENTRY) {
      return { step: await ctx.enterRecovery(token, 'rate-limited') };
    }
    log.info('engine: action blocked — short park before the next attempt', { blockedStreak });
    await ctx.engineWait('engine:blocked-park', tempoOrReference(ctx.deps.tempo).base('park.blocked'));
    return { step: 'idle' };
  }

  // Systemic-breakage breaker: when every action fails identically across
  // records the problem is the machinery, so enter the ladder instead of
  // burning the queue on clicks that do nothing. An ALL-drift window carries
  // drift evidence; anything ambiguous is presumed rate-limited.
  const { failed, drift } = ctx.deps.churn.streaks();
  if (failed >= ctx.recovery.failingEntryThreshold(ctx.actionsFailingHalt)) {
    const kind: FailureKind = drift >= failed ? 'drift' : 'rate-limited';
    return { step: await ctx.enterRecovery(token, kind) };
  }
  if (outcome === 'simulated') ctx.deps.pacing.practiced(actAt);
  if ((outcome === 'ok' && !detail?.alreadyInState) || outcome === 'simulated') {
    ctx.noteProgress(outcome === 'ok' ? 'mutation-verified' : 'simulation-completed');
    if (outcome === 'ok' && rec.state === 'queued') ctx.deps.frontier?.noteFollow(rec.targetPk, actAt);
    // Only a verified new mutation clears the recovery incident.
    const incident = ctx.recovery.noteRecovered();
    if (incident !== null) ctx.healIncidentWindow(incident);
  }
  return { kind: rec.state === 'unfollow_queued' ? 'unfollow' : 'follow' };
}
