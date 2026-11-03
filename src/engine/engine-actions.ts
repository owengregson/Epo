/**
 * The growth loop's action steps: the paced action gate, one churn action with
 * the ladder's breakers, and one woven prune unfollow, run against the Engine's context.
 */

import { tempoOrReference } from '../kernel/tempo';
import type { FollowRecord } from '../store/types';
import { ENGINE as ENGINE_TIMING, RECOVERY as RECOVERY_TIMING } from '../timing/config';
import type { WaitResult } from '../timing/delay-manager';
import type { DelayPolicy } from '../timing/primitives';
import * as log from '../utils/logger';
import type { EngineWaitKey } from './engine-waits';
import type { FeedCandidate } from './facts';
import type { Pacer } from './pacers';
import type { EngineTempo } from './plan-port';
import type { EngineDeps, EngineState, EngineUnfollowFeed, StepResult } from './ports';
import type { FailureKind, RecoveryIncident, RecoverySupervisor } from './recovery';

/** How long an iteration idles when nothing is due yet (the Engine's `ENGINE_IDLE_MS`). */
const ENGINE_IDLE_MS = ENGINE_TIMING.IDLE_MS;

/** What one action attempt produced: the verb that landed (so the pacer can be
 *  told and the delay armed), or a StepResult that ends the iteration outright. */
export type ActionOutcome =
  | { kind: 'follow' | 'unfollow'; step?: undefined }
  | { kind?: undefined; step: StepResult };

/** The slice of the Engine the action steps read and write. */
export interface EngineActionContext {
  readonly deps: EngineDeps & EngineTempo;
  readonly recovery: RecoverySupervisor;
  readonly pacer: Pacer;
  readonly unfollowFeed: EngineUnfollowFeed;
  /** Consecutive failed actions that enter the recovery ladder (`ACTIONS_FAILING_HALT`). */
  readonly actionsFailingHalt: number;
  /** The owed inter-action deadline (epoch ms), or null; see {@link setActionDeadline}. */
  actionDelayDeadline: number | null;
  /** True once a refill ran since the last action. */
  refillSinceAction: boolean;
  /** Epoch ms of the last action that landed. */
  lastActionAt: number | null;
  stateNow(): EngineState;
  superseded(token: AbortController): boolean;
  engineWait(key: EngineWaitKey, policyOrMs: DelayPolicy | number): Promise<WaitResult>;
  enterRecovery(token: AbortController, kind: FailureKind): Promise<StepResult>;
  noteProgress(phase: string): void;
  healIncidentWindow(incident: RecoveryIncident): void;
}

/**
 * THE one Instagram action per iteration — a growth/lifecycle churn action
 * or, in the organic model with prune woven in, an interleaved prune unfollow
 * drawn from the SAME stream. Returns null when neither stream has work.
 */
export async function performAction(
  ctx: EngineActionContext,
  now: number,
  token: AbortController,
  act: (actAt: number) => Promise<ActionOutcome>,
): Promise<StepResult> {
  const probationUntil = ctx.deps.reentry?.mutationWaitUntil(now);
  if (probationUntil !== null && probationUntil !== undefined) {
    await ctx.engineWait('engine:action-delay', probationUntil - now);
    return 'idle';
  }
  // Pay down an OWED remainder first (armed by a previous action whose delay a
  // pause/offline aborted). Interruptible: a fresh pause during the remainder
  // leaves the deadline armed and parks without acting.
  if (ctx.actionDelayDeadline !== null) {
    const remaining = ctx.actionDelayDeadline - now;
    if (remaining > 0) {
      const res = await ctx.engineWait('engine:action-delay', remaining);
      // Aborted with the remainder still owed: NOTHING was acted on — report
      // 'idle' so lastStep/lastActionAt stay truthful.
      if (!res.completed) return 'idle';
    }
    setActionDeadline(ctx, null);
  }

  const actAt = ctx.deps.clock.now();
  ctx.refillSinceAction = false;
  const outcome = await act(actAt);
  if (outcome.kind === undefined) return outcome.step;

  ctx.lastActionAt = actAt;
  // Arm the delay deadline BEFORE waiting: if a pause/stop/quit lands during
  // the action (or the wait), the persisted deadline survives so the next
  // resume — or app launch — serves the remainder.
  setActionDeadline(ctx, Math.max(ctx.deps.store.getActionDelayDeadline() ?? 0,
    actAt + ctx.pacer.noteAction(actAt, outcome.kind)));
  if (ctx.stateNow() !== 'paused' && !ctx.superseded(token)) {
    const remaining = (ctx.actionDelayDeadline ?? 0) - ctx.deps.clock.now();
    const res = await ctx.engineWait('engine:action-delay', remaining);
    if (res.completed) setActionDeadline(ctx, null);
  }
  return 'acted';
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
  if (status === 'blocked') {
    if (detail?.cause === 'rate-limited') return { step: await ctx.enterRecovery(token, 'rate-limited') };
    // The journal retains unresolved effects; no failed attempt consumes the candidate.
    await ctx.engineWait('engine:prune-park', tempoOrReference(ctx.deps.tempo).base('park.blocked'));
    return { step: 'idle' };
  }
  if (status === 'ok' && !detail?.alreadyInState) {
    ctx.deps.reentry?.noteAction(actAt);
    ctx.noteProgress('mutation-verified');
  }
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

  if (outcome === 'blocked') {
    if (ctx.deps.churn.lastBlockedCause() === 'local-policy') {
      await ctx.engineWait('engine:idle', ENGINE_IDLE_MS);
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
  if ((outcome === 'ok' && !ctx.deps.churn.lastActionOutcome?.()?.alreadyInState) || outcome === 'simulated') {
    ctx.noteProgress(outcome === 'ok' ? 'mutation-verified' : 'simulation-completed');
    if (outcome === 'ok') {
      ctx.deps.reentry?.noteAction(actAt);
      if (rec.state === 'queued') ctx.deps.frontier?.noteFollow(rec.targetPk, actAt);
    }
    // Only a verified new mutation clears the recovery incident.
    const incident = ctx.recovery.noteRecovered();
    if (incident !== null) ctx.healIncidentWindow(incident);
  }
  return { kind: rec.state === 'unfollow_queued' ? 'unfollow' : 'follow' };
}

/**
 * Set the owed inter-action deadline in memory AND the store in one move —
 * the durable mirror is what lets an app relaunch resume the remaining wait.
 */
export function setActionDeadline(ctx: EngineActionContext, at: number | null): void {
  ctx.actionDelayDeadline = at;
  ctx.deps.store.setActionDelayDeadline(at);
}
