/**
 * The reconciliation half of the `sweep-followback` effect: run the
 * ReconciliationRunner and turn its outcome into the step's result.
 */

import type { WaitResult } from '../timing/delay-manager';
import type { DelayPolicy } from '../timing/primitives';
import type { EngineWaitKey } from './engine-waits';
import type { HaltReason } from './halt-reason';
import type { EngineDeps, StepResult } from './ports';
import type { ReconciliationRunner } from './reconciliation-runner';

/** The slice of the Engine the reconciliation step reads and writes. */
export interface EngineJournalContext {
  readonly deps: EngineDeps;
  readonly reconciliation: ReconciliationRunner;
  /** The owed inter-action deadline, re-read from the store after the run. */
  actionDelayDeadline: number | null;
  superseded(token: AbortController): boolean;
  halt(reason: HaltReason): 'halted';
  noteProgress(phase: string): void;
  engineWait(key: EngineWaitKey, policyOrMs: DelayPolicy | number): Promise<WaitResult>;
}

/** Run the reconciliation before a follow-back sweep: null once complete, else the step's result. */
export async function reconcileBeforeSweep(
  ctx: EngineJournalContext,
  now: number,
  token: AbortController,
): Promise<StepResult | null> {
  const result = await ctx.reconciliation.run(now, () => ctx.superseded(token));
  if (result.outcome === 'aborted') return 'aborted';
  ctx.actionDelayDeadline = ctx.deps.store.getActionDelayDeadline();
  if (result.outcome === 'halt') return ctx.halt({ kind: 'reconciliation-failed' });
  if (result.outcome === 'progress') ctx.noteProgress('relationships-reconciling'); // no park: the visitor paces reads
  if (result.outcome === 'wait') await ctx.engineWait(result.reason === 'read-budget' ? 'engine:read-budget-park' : 'engine:reconcile-backoff', result.delayMs);
  if (result.outcome !== 'complete') return 'idle';
  return null;
}
