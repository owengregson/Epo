/**
 * The follow-back sweep (spec §9.6): the frontier sweep in session or check mode — every step's failure
 * ends that step only, so a sweep always ends — then advances the churn timers it made due.
 */

import type { EngineDeps, StepResult, SweepCadence } from './ports';

/** The slice of the Engine the sweep reads and writes. */
export interface EngineSweepContext {
  readonly deps: EngineDeps;
  readonly sweepCadence: SweepCadence;
  superseded(token: AbortController): boolean;
  noteProgress(phase: string): void;
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
  const { clock, followback, churn } = ctx.deps;
  const mode = sweepModeAt(ctx.deps, ctx.sweepCadence.lastSweepEndedAt() ?? null, clock.now());
  await followback.run(mode, token.signal);
  if (ctx.superseded(token)) return 'aborted';
  const at = clock.now();
  ctx.sweepCadence.markRun(at);
  churn.advanceTimers(at);
  ctx.noteProgress('relationships-reconciled');
  return 'swept-followback';
}
