/**
 * The Boost commands (ADR 0904, spec §8.2, §8.5): typed refusals, never a silent no-op. "Start Epo
 * and Boost" is one ordered command — advance run intent, then write the window and re-plan (so the
 * act-now insertion sees desired = running), then start the engine behind the startup gate.
 */

import { type BoostFacts, projectBoost } from '@/governors/plan-boost';
import { clampBoostHours } from '@/governors/plan-preview';
import type { PlanService } from '@/governors/plan-service';
import { MS_PER_HOUR } from '@/kernel/units';
import type { StatusContributor } from '@/main/services/graph-types';
import type { BoostCommandResult, BoostPreview, BoostView } from '@/shared/boost';
import * as logger from '@/utils/logger';

/** The slice of the plan service the commands use (the service itself in production). */
export type BoostPlan = Pick<PlanService, 'view' | 'snapshot' | 'startBoost' | 'endBoost' | 'previewBoost'>;

export interface BoostControlDeps {
  /** The live plan service, or null while signed out (no graph). */
  plan(): BoostPlan | null;
  runIntent(): 'running' | 'stopped' | 'paused';
  /** Advance run intent to running through the runtime coordinator (a new epoch). */
  advanceRunIntent(): void;
  /** Start the engine, queued behind the startup lease like any Start. */
  startEngine(): void;
  /** True while an operational block needs the user first. */
  runtimeBlocked(): boolean;
  hasSeed(): boolean;
  /** Follows since `t` from the ledger tally. */
  followsSince(t: number): number | null;
  now(): number;
}

const OFF: BoostView = { state: 'off', startedAt: null, endsAt: null, effectiveFrom: null, followsDuring: null, lastEnded: null };

export class BoostControl {
  constructor(private readonly deps: BoostControlDeps) {}

  /** The Boost as the status push shows it. */
  view(now = this.deps.now()): BoostView {
    const plan = this.deps.plan();
    if (plan === null) return OFF;
    const record = plan.snapshot(now).state.boost;
    const facts: BoostFacts = { record, followsDuring: record === null ? null : this.deps.followsSince(record.startedAt) };
    return projectBoost(plan.view(now), now, this.deps.runIntent(), facts);
  }

  private refused(reason: Extract<BoostCommandResult, { kind: 'refused' }>['reason'], now: number): BoostCommandResult {
    return { kind: 'refused', reason, boost: this.view(now) };
  }

  /** Start a Boost of `hours` (clamped to the Boost bounds); `alsoStart` also starts Epo, in order. */
  startBoost(hours: number, opts: { readonly alsoStart: boolean }): BoostCommandResult {
    const now = this.deps.now();
    if (!Number.isFinite(hours)) return this.refused('bad-duration', now);
    const plan = this.deps.plan();
    if (plan === null) return this.refused('signed-out', now);
    if (!this.deps.hasSeed()) return this.refused('no-seed', now);
    if (this.deps.runtimeBlocked()) return this.refused('runtime-blocked', now);
    try {
      if (plan.view(now).boost !== null) return this.refused('already-on', now);
      const preview = plan.previewBoost(clampBoostHours(hours), now);
      if (preview.why === 'backlog') return this.refused('backlog', now);
      const starting = opts.alsoStart && this.deps.runIntent() !== 'running';
      if (preview.why === 'nothing-to-shift' && !starting) return this.refused('nothing-to-shift', now);
      if (starting) this.deps.advanceRunIntent();
      plan.startBoost(clampBoostHours(hours) * MS_PER_HOUR, now);
      if (starting) this.deps.startEngine();
      return { kind: 'started', boost: this.view(now) };
    } catch (e) {
      logger.error('boost: start failed', { error: String(e) });
      return this.refused('internal', now);
    }
  }

  /** End the Boost now: the safe direction, no confirm. */
  endBoost(): BoostCommandResult {
    const now = this.deps.now();
    const plan = this.deps.plan();
    if (plan === null) return this.refused('signed-out', now);
    try {
      if (plan.view(now).boost === null) return this.refused('not-on', now);
      plan.endBoost('user', now);
      return { kind: 'ended', boost: this.view(now) };
    } catch (e) {
      logger.error('boost: end failed', { error: String(e) });
      return this.refused('internal', now);
    }
  }

  /** What a Boost of `hours` would change now, or null while signed out. */
  previewBoost(hours: number): BoostPreview | null {
    const plan = this.deps.plan();
    if (plan === null) return null;
    return plan.previewBoost(clampBoostHours(hours), this.deps.now());
  }
}

/** The `boost` status contributor plan-wiring includes in the graph's contributors. */
export function boostContributor(control: BoostControl): StatusContributor {
  return { name: 'boost', contribute: (_graph, now) => ({ boost: control.view(now) }) };
}
