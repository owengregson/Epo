/**
 * The plan's triggers (ADR 0607, spec §5.6): `ensure` at graph build, at the plan's next edge (a
 * one-shot re-armed after every change), after a system resume and on a settings change; a completed
 * census re-plans the demand. Every write the plan makes pushes the status and wakes the loop's plan
 * parks; overdue edges evaluate first because each trigger reads the wall clock (PRINCIPLES §3).
 */

import type { PlanService } from '@/governors/plan-service';
import type { ScheduleManager } from '@/timing/schedule-manager';
import * as logger from '@/utils/logger';

export interface PlanControlDeps {
  plan: Pick<PlanService, 'ensure' | 'onSettings' | 'onDemand' | 'nextEdgeAt'>;
  scheduler: Pick<ScheduleManager, 'after' | 'stop'>;
  settings: { onChange(fn: () => void): () => void };
  clock: { now(): number };
  /** Push the composed status (the plan rides it). */
  pushStatus(): void;
  /** Wake the loop's plan parks so it re-reads the plan. */
  wake(): void;
}

/** The one edge timer per account plan. */
const EDGE_KEY = 'plan:edge';

export class PlanControl {
  private live = false;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly deps: PlanControlDeps) {}

  /** Graph build: the plan for now, the edge armed, the settings watched. */
  start(): void {
    this.run('build', () => this.deps.plan.ensure(this.deps.clock.now()));
    this.live = true;
    this.unsubscribe = this.deps.settings.onChange(() => this.run('settings', () => this.deps.plan.onSettings(this.deps.clock.now())));
    this.arm();
  }

  /** The plan service's `onChanged`: a write happened (any cause, Boost included). */
  changed(): void {
    if (!this.live) return;
    this.deps.pushStatus();
    this.deps.wake();
    this.arm();
  }

  /** The machine woke: timers slept with it, so the plan and the edge are re-read from the wall clock. */
  resumed(): void {
    this.run('resume', () => this.deps.plan.ensure(this.deps.clock.now()));
    this.arm();
  }

  /** A census completed: the remainder's kinds re-derive from the new demand. */
  demandChanged(): void {
    this.run('census', () => this.deps.plan.onDemand(this.deps.clock.now()));
  }

  dispose(): void {
    this.live = false;
    this.deps.scheduler.stop(EDGE_KEY);
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private arm(): void {
    if (!this.live) return;
    const now = this.deps.clock.now();
    let edge: number;
    try {
      edge = this.deps.plan.nextEdgeAt(now);
    } catch (e) {
      logger.error('plan: the next edge could not be read', { error: String(e) });
      return;
    }
    this.deps.scheduler.after(EDGE_KEY, edge - now, () => {
      this.run('edge', () => this.deps.plan.ensure(this.deps.clock.now()));
      this.arm();
    }, { unref: true });
  }

  private run(trigger: string, ensure: () => unknown): void {
    try {
      ensure();
    } catch (e) {
      logger.error('plan: ensure failed', { trigger, error: String(e) });
    }
  }
}
