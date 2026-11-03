/**
 * The prune run's pacing: the active-hours and daily-cap gates, the per-cycle
 * plan, and the paced delay between unfollows.
 */

import { bandDay, u } from '../kernel/plan';
import { MS_PER_MINUTE } from '../kernel/units';
import { actionGap } from '../timing/action-gap';
import { PRUNE } from '../timing/config';
import type { WaitResult } from '../timing/delay-manager';
import { sample, scaled } from '../timing/primitives';
import { startOfLocalDay } from '../timing/units';
import * as log from '../utils/logger';
import type { PruneConfig, PruneEngineDeps, PruneState } from './prune-types';

/** Prune's cap boundary: the plan-day start when a governor is wired, else local midnight. */
export function pruneCycleStart(now: number, cycleStartMs?: (now: number) => number): number {
  return cycleStartMs?.(now) ?? startOfLocalDay(now);
}

/** Today's planned prune volume: the automatic-day band drawn under `dailyLimit` from the plan-day's start. */
export function pruneDailyPlan(dailyLimit: number, cycleStart: number): number {
  return bandDay(dailyLimit, u(Math.floor(cycleStart / MS_PER_MINUTE) >>> 0, 'prune-band', dailyLimit));
}

/**
 * Prune unfollows run at a THIRD of the growth engine's paced inter-action
 * pace: the same jittered min/max/jitter draw, scaled by this factor. Pruning is
 * a deliberate, user-invoked bulk cleanup, so it moves ~3× faster than growth's
 * follow cadence while still spacing every unfollow (never a burst). Only the
 * inter-action delay is scaled — the scan pacing and the blocked/budget park are
 * unaffected.
 */
export const PRUNE_DELAY_FACTOR = PRUNE.DELAY_FACTOR;

/** What the pacing reads from the PruneEngine; the config is read live. */
export interface PrunePacingDeps {
  deps: PruneEngineDeps;
  cfg(): PruneConfig;
  /** The seeded stream the paced delay draws from (never the noise stream). */
  rng: () => number;
  stateNow(): PruneState;
  /** Owe a delay a pause interrupted; the run serves it on resume. */
  owe(deadline: number): void;
  pruneWait(key: 'prune:action-delay', ms: number): Promise<WaitResult>;
}

export class PrunePacing {
  private readonly deps: PruneEngineDeps;
  private readonly rng: () => number;

  constructor(private readonly p: PrunePacingDeps) {
    this.deps = p.deps;
    this.rng = p.rng;
  }

  /** The live prune config (swapped by `PruneEngine.applyConfig`). */
  private get cfg(): PruneConfig {
    return this.p.cfg();
  }

  /** Why the run must stop before its next candidate (gates 0 and 1), or null. */
  stopReason(actedThisRun: number): 'active-hours' | 'cap' | null {
    // Gate 0 — active hours: stop at the window's edge (also prevents the
    // midnight rollover from re-opening the daily cap mid-run).
    if (this.deps.withinActiveHours && !this.deps.withinActiveHours()) {
      log.info('prune: outside active hours, stopping run');
      return 'active-hours';
    }

    // Gate 1 — the prune-own daily cap (durable) AND the per-run bound.
    // Both gate on the cycle PLAN (a fluctuating draw just under the
    // configured limit) so no two days stop at the exact same number.
    const plan = this.dailyPlan();
    if (this.dailyDone() >= plan || actedThisRun >= plan) {
      log.info('prune: daily cap reached, stopping run', { plan, limit: this.cfg.dailyLimit });
      return 'cap';
    }
    return null;
  }

  /** The paced delay after an unfollow, or the owed deadline when a pause landed mid-action. */
  async paceNext(): Promise<void> {
    // THE paced delay between actions (min/max from config, jittered). A
    // pause that landed DURING the action defers it instead: the deadline
    // is owed and served on resume by the gate — never paced while parked.
    const delayMs = this.nextDelayMs();
    if (this.p.stateNow() === 'paused') {
      this.p.owe(this.deps.clock.now() + delayMs);
      return;
    }
    await this.p.pruneWait('prune:action-delay', delayMs);
  }

  /** The current active-hours cycle start (growth's boundary, or local midnight). */
  cycleStart(): number {
    return pruneCycleStart(this.deps.clock.now(), this.deps.cycleStartMs);
  }

  /** Prune-ledger rows since the active-hours cycle start — the durable daily-cap count. */
  dailyDone(): number {
    return this.deps.store.pruneCountSince(this.cycleStart());
  }

  /** Today's planned prune volume (a per-cycle draw just under `dailyLimit`). */
  dailyPlan(): number {
    return pruneDailyPlan(this.cfg.dailyLimit, this.cycleStart());
  }

  /**
   * The inter-action delay between unfollows: the paced uniform [min,max]
   * draw ± jitterPercent (the growth engine's pace), then scaled to a THIRD
   * ({@link PRUNE_DELAY_FACTOR}) so pruning runs ~3× faster while still spacing
   * every action.
   */
  nextDelayMs(): number {
    const { minDelayMs, maxDelayMs, jitterPercent } = this.cfg;
    return sample(
      scaled(actionGap(minDelayMs, maxDelayMs, jitterPercent), PRUNE_DELAY_FACTOR),
      this.rng,
    );
  }
}
