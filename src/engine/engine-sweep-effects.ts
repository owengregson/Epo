/**
 * The follow-back sweep (spec §9.6): the frontier sweep in session or check mode — every step's failure
 * ends that step only, so a sweep always ends — then the churn timers it made due, and pacing.
 */

import type { EngineDeps, StepResult, SweepCadence } from './ports';

/** The slice of the Engine the sweep reads and writes. */
export interface EngineSweepContext {
  readonly deps: EngineDeps;
  readonly sweepCadence: SweepCadence;
  /** The owed inter-action deadline, re-read after a pass that may accept requests. */
  actionDelayDeadline: number | null;
  superseded(token: AbortController): boolean;
  noteProgress(phase: string): void;
  pacingSleep(): Promise<void>;
}

/** The first sweep of an open plan session runs in session mode; later ones, and any outside a session, check. */
export function sweepModeAt(deps: Pick<EngineDeps, 'pacing'>, lastSweepEndedAt: number | null, now: number): 'session' | 'check' {
  const view = deps.pacing?.view(now);
  const open = view?.open ?? null;
  if (view === undefined || open === null) return 'check';
  const startAt = view.plan.sessions.find((s) => s.idx === open.idx)?.startAt ?? null;
  return startAt !== null && (lastSweepEndedAt === null || lastSweepEndedAt < startAt) ? 'session' : 'check';
}

/** Run one sweep, then advance the timers it made due. */
export async function runFollowbackSweep(ctx: EngineSweepContext, token: AbortController): Promise<StepResult> {
  const { clock, followback, churn, reentry } = ctx.deps;
  const mode = sweepModeAt(ctx.deps, ctx.sweepCadence.lastSweepEndedAt?.() ?? null, clock.now());
  await followback.run(mode, token.signal);
  if (ctx.superseded(token)) return 'aborted';
  ctx.actionDelayDeadline = ctx.deps.store.getActionDelayDeadline();
  const at = clock.now();
  ctx.sweepCadence.markRun(at);
  churn.advanceTimers(at);
  // The re-entry supervisor still reads a finished sweep as its reconcile pass, until probation is the plan's.
  reentry?.noteReconciled({ outcome: 'complete' }, at);
  ctx.noteProgress('relationships-reconciled');
  await ctx.pacingSleep();
  return 'swept-followback';
}
