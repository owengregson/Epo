/**
 * The journal's step and the follow-back sweep's read: one due intent settled per step (spec §9.8),
 * and the watcher's check before a sweep completes (until the frontier sweep replaces it). There is
 * no batch and no halt: a failed read backs off on the tempo, and an unavailable account parks.
 */

import { tempoOrReference } from '../kernel/tempo';
import type { WaitResult } from '../timing/delay-manager';
import type { DelayPolicy } from '../timing/primitives';
import type { EngineWaitKey } from './engine-waits';
import type { EngineTempo } from './plan-port';
import type { EngineDeps, StepResult } from './ports';
import type { FailureKind } from './recovery';

/** The slice of the Engine the journal and sweep-read steps read and write. */
export interface EngineJournalContext {
  readonly deps: EngineDeps & EngineTempo;
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
    // A known reopening instant is waited exactly (never under a beat); an unknown one backs off.
    const tempo = tempoOrReference(ctx.deps.tempo);
    const wait = result.retryAt === undefined ? tempo.base('backoff.walled')
      : Math.max(tempo.base('beat.transient'), result.retryAt - clock.now());
    await ctx.engineWait(result.deferred === 'read-budget' ? 'engine:read-budget-park' : 'engine:enrich-backoff', wait);
    return 'idle';
  }
  reentry?.noteReconciled({ outcome: 'complete' }, clock.now());
  return null;
}
