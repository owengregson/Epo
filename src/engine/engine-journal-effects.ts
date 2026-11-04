/**
 * The journal's step: one due intent settled per step (spec §9.8). There is no batch and no halt:
 * an unavailable account parks.
 */

import type { WaitResult } from '../timing/delay-manager';
import type { DelayPolicy } from '../timing/primitives';
import type { EngineWaitKey } from './engine-waits';
import type { EngineTempo } from './plan-port';
import type { EngineDeps, StepResult } from './ports';
import type { FailureKind } from './recovery';

/** The slice of the Engine the journal step reads and writes. */
export interface EngineJournalContext {
  readonly deps: EngineDeps & EngineTempo;
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
