/**
 * The journal's step and the follow-back sweep's read: one due intent settled per step (spec §9.8),
 * and the watcher's check before a sweep completes (until the frontier sweep replaces it). There is
 * no batch and no halt: an incomplete read ends its sweep, and an unavailable account parks.
 */

import type { WaitResult } from '../timing/delay-manager';
import type { DelayPolicy } from '../timing/primitives';
import * as log from '../utils/logger';
import type { EngineWaitKey } from './engine-waits';
import type { EngineTempo } from './plan-port';
import type { EngineDeps, StepResult, SweepCadence } from './ports';
import type { FailureKind } from './recovery';

/** The slice of the Engine the journal and sweep-read steps read and write. */
export interface EngineJournalContext {
  readonly deps: EngineDeps & EngineTempo;
  readonly sweepCadence: SweepCadence;
  /** The owed inter-action deadline, re-read from the store after a read that may accept requests. */
  actionDelayDeadline: number | null;
  superseded(token: AbortController): boolean;
  noteProgress(phase: string): void;
  engineWait(key: EngineWaitKey, policyOrMs: DelayPolicy | number): Promise<WaitResult>;
  enterRecovery(token: AbortController, kind: FailureKind): Promise<StepResult>;
  pacingSleep(): Promise<void>;
}

/** Settle one due intent with one read of its account; a wall goes to the recovery ladder. */
export async function settleJournalStep(ctx: EngineJournalContext, token: AbortController): Promise<StepResult> {
  const settle = ctx.deps.settleJournal;
  if (settle === undefined) return 'idle';
  const { outcome } = await settle();
  if (ctx.superseded(token) || outcome === 'aborted') return 'aborted';
  if (outcome === 'walled') return ctx.enterRecovery(token, 'rate-limited');
  if (outcome === 'none') return 'idle';
  ctx.noteProgress('journal-settled');
  await ctx.pacingSleep();
  return 'swept-followback';
}

/** The follow-back sweep's read (the watcher's check): null once complete, else the step's result. */
export async function followbackBeforeSweep(ctx: EngineJournalContext, token: AbortController): Promise<StepResult | null> {
  const { clock, reentry, followback } = ctx.deps;
  const now = clock.now();
  const result = await followback.check({ requireFresh: reentry?.requiresCensus(now) ?? false,
    freshSinceAt: reentry?.snapshot().reconciliationStartedAt ?? undefined });
  if (ctx.superseded(token)) return 'aborted';
  ctx.actionDelayDeadline = ctx.deps.store.getActionDelayDeadline();
  if (result.deferred === 'reconciliation-progress') {
    ctx.noteProgress('relationships-reconciling'); // no park: the visitor paces reads
    return 'idle';
  }
  if (result.deferred !== undefined || (result.outcome ?? 'complete') !== 'complete') {
    // An incomplete read ends this sweep only (spec §9.12): the next one waits its interval, growth goes on.
    log.warn('engine: the follow-back read ended incomplete; the next sweep waits its interval',
      { outcome: result.outcome ?? null, deferred: result.deferred ?? null });
    ctx.sweepCadence.markRun(clock.now());
    await ctx.pacingSleep();
    return 'idle';
  }
  reentry?.noteReconciled({ outcome: 'complete' }, clock.now());
  return null;
}
