/**
 * The prune run's pacing under the plan (spec §5.13 S2 item 7, §9.7): the plan's admission asked
 * before each candidate's visit, and the shared deadline the dispatch armed, served between unfollows.
 * There is no pace, no daily plan and no active-hours gate of the run's own; the plan holds them.
 */

import type { WaitResult } from '../timing/delay-manager';
import { type PruneDeferral, pruneDeferral } from './prune-candidate';
import type { PruneEngineDeps, PruneState } from './prune-types';

/** What the pacing reads from the PruneEngine. */
export interface PrunePacingDeps {
  deps: PruneEngineDeps;
  stateNow(): PruneState;
  /** Owe a delay a pause interrupted; the run serves it on resume. */
  owe(deadline: number): void;
  pruneWait(key: 'prune:action-delay', ms: number): Promise<WaitResult>;
}

export class PrunePacing {
  private readonly deps: PruneEngineDeps;

  constructor(private readonly p: PrunePacingDeps) {
    this.deps = p.deps;
  }

  /**
   * The plan's answer for the next candidate, before its visit: null to proceed, else serve its instant,
   * pass the candidate over (its journal), or end the run with the typed reason (spec §9.7).
   */
  admit(pk: string): PruneDeferral | null {
    const a = this.deps.plan?.preflight(this.deps.clock.now(), pk) ?? { ok: true };
    return a.ok ? null : pruneDeferral({ kind: 'deferred', reason: a.reason, until: a.until });
  }

  /** After an unfollow: wait on the deadline its dispatch armed (a practice write owes the same gap). */
  async paceNext(simulated: boolean): Promise<void> {
    const now = this.deps.clock.now();
    if (simulated) this.deps.plan?.practiced(now);
    const owed = (this.deps.store.getActionDelayDeadline() ?? 0) - now;
    if (owed <= 0) return;
    // A pause that landed DURING the action defers it: the deadline is owed and served on resume.
    if (this.p.stateNow() === 'paused') {
      this.p.owe(now + owed);
      return;
    }
    await this.p.pruneWait('prune:action-delay', owed);
  }

  /** The day's cleanup as the plan holds it: unfollows done today and the plan's unfollow budget. */
  today(): { readonly done: number; readonly limit: number } {
    return this.deps.plan?.cleanupToday(this.deps.clock.now()) ?? { done: 0, limit: this.deps.cfg.dailyLimit };
  }
}
