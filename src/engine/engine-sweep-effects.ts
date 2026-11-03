/**
 * The follow-back sweep's completion: stamp the persisted cadence, advance the
 * churn timers the sweep made due, and pace before the next branch.
 */

import type { EngineDeps, StepResult, SweepCadence } from './ports';

/** The slice of the Engine the sweep completion reads and writes. */
export interface EngineSweepContext {
  readonly deps: EngineDeps;
  readonly sweepCadence: SweepCadence;
  noteProgress(phase: string): void;
  pacingSleep(): Promise<void>;
}

/** Finish a follow-back sweep whose reconciliation completed. */
export async function completeFollowbackSweep(ctx: EngineSweepContext): Promise<StepResult> {
  const at = ctx.deps.clock.now();
  ctx.sweepCadence.markRun(at);
  ctx.deps.churn.advanceTimers(at);
  ctx.noteProgress('relationships-reconciled');
  await ctx.pacingSleep();
  return 'swept-followback';
}
