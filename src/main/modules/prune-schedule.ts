/**
 * The scheduled prune: a durable due-check on the shared ScheduleManager that
 * launches a prune scan or run when the user's cadence is due and it is safe.
 */

import { isRateLimitHaltKey } from '@/engine/halt-reason';
import { pruneDue } from '@/engine/prune-engine';
import type { PruneControl } from '@/main/modules/prune-control';
import type { BuiltGraph } from '@/main/services/graph-types';
import type { RuntimeCoordinator } from '@/main/services/runtime-coordinator';
import type { TabLease } from '@/main/services/tab-lease';
import type { Settings } from '@/settings/settings';
import { NOISE, RECOVERY, SCHEDULER } from '@/timing/config';
import { sample, sleep, uniform } from '@/timing/primitives';
import type { ScheduleManager } from '@/timing/schedule-manager';
import * as logger from '@/utils/logger';

export interface PruneScheduleDeps {
  /** The manual prune controls the schedule launches through. */
  control: PruneControl;
  runtime: RuntimeCoordinator;
  lease: TabLease;
  /** The Foundation's one ScheduleManager. */
  scheduler: ScheduleManager;
  /** Aborted once the Foundation disposes; interrupts the launch hold. */
  disposeSignal: AbortSignal;
  /** The live graph, or `null` while the session is closed. */
  graph(): BuiltGraph | null;
  /** Ensure the graph is built and hand it back (`null` when not logged in). */
  builtGraph(): Promise<BuiltGraph | null>;
  /** True once the Foundation began disposing. */
  disposing(): boolean;
  resolveSettings(): Settings;
  updateSettings(partial: Partial<Settings>): Promise<Settings>;
}

export class PruneSchedule {
  constructor(private readonly deps: PruneScheduleDeps) {}

  /** Durable maintenance gets a bounded handoff from continuous growth. */
  startScheduledPruneWatcher(intervalMs = SCHEDULER.AUTO_PRUNE_CHECK_MS): void {
    // Idempotency + the never-hold-the-process-open unref both come from the
    // ScheduleManager (`every` is a per-key no-op while the loop lives).
    // `immediate` (docs/PRINCIPLES.md §3 — schedules are durable): work that
    // came due WHILE THE APP WAS CLOSED runs at launch, not one interval later
    // (the due-check reads the persisted `pruneLastRunAt`, and the safety
    // gates — logged in, tab free, active hours — still all apply).
    this.deps.scheduler.every(
      'prune:auto-watcher',
      intervalMs,
      () => this.maybeRunScheduledPrune(),
      { unref: true, immediate: true },
    );
  }

  /**
   * Why the scheduled prune must stay off the tab right now, or null when it
   * is clear. A rate wall frees the tab but launching a census walk into the
   * same wall deepens the block, so the prune waits out:
   *
   *  - a recent rate-limit-classified HALT ({@link isRateLimitHalt} — the
   *    growth engine's own vocabulary, so the set cannot drift from what it
   *    emits), and
   *  - a LIVE recovery ladder that has classified at least one rate-limited
   *    failure: the halt only lands after every rung is spent, and the whole
   *    hold before it is exactly when a census walk must not run.
   */
  private pruneRateCooldown(graph: BuiltGraph): Record<string, unknown> | null {
    const halt = graph.engine.lastHaltInfo();
    if (
      halt !== null &&
      isRateLimitHaltKey(halt.reason) &&
      graph.clock.now() - halt.at < RECOVERY.PRUNE_COOLDOWN_AFTER_RATE_HALT_MS
    ) {
      return {
        haltReason: halt.reason,
        haltAt: halt.at,
        cooldownMs: RECOVERY.PRUNE_COOLDOWN_AFTER_RATE_HALT_MS,
      };
    }
    const ladder = graph.engine.recoverySnapshot();
    const rateLimitedEntries = ladder.kindTally['rate-limited'] ?? 0;
    if ((ladder.phase === 'holding' || ladder.phase === 'probing') && rateLimitedEntries > 0) {
      return { recoveryPhase: ladder.phase, attempt: ladder.attempt, rateLimitedEntries };
    }
    return null;
  }

  /**
   * One scheduled-prune check: start a run iff it is due and safe. A RUNNING
   * growth engine is no longer a blocker — {@link PruneControl.startPrune} pauses it for the
   * hand-off and resumes it when the prune finishes — so the only gates left are
   * "not already driving the tab" (no active prune) and "inside active hours".
   */
  async maybeRunScheduledPrune(): Promise<void> {
    const control = this.deps.control;
    if (this.deps.disposing() || this.deps.lease.tourHeld() || control.pruneRefusalReason() !== null) return;
    const token = this.deps.runtime.token();
    const graph = await this.deps.builtGraph();
    if (graph === null) return;
    const cooldown = this.pruneRateCooldown(graph);
    if (cooldown !== null) {
      logger.info('foundation: scheduled prune skipped — rate-limit cool-down', cooldown);
      return;
    }
    const settings = this.deps.resolveSettings();
    if (!pruneDue(settings.pruneScheduleDays, settings.pruneLastRunAt, graph.clock.now())) {
      return;
    }
    // Re-check the driver token after the await: never contend with a prune that
    // started in the meantime. (Growth running is fine — startPrune hands it off.)
    if (control.pruneRefusalReason() !== null) return;
    if (!graph.rate.withinActiveHours()) return;

    // Launch jitter (timing-noise layer): the 30-min due-poll is LOCAL (no IG
    // traffic on the tick), but launching the moment the tick lands put every
    // scheduled prune on a half-hour-aligned grid. Hold a uniform slice —
    // interruptible by dispose — then RE-RUN the safety gates: the world may
    // have changed during a hold this long.
    const launchHoldMs = sample(uniform(0, NOISE.PRUNE_LAUNCH_JITTER_MAX_MS));
    logger.info('foundation: scheduled prune due, holding jittered launch slot', {
      launchHoldMs,
    });
    await sleep(launchHoldMs, this.deps.disposeSignal);
    if (this.deps.disposing() || this.deps.lease.tourHeld() || control.pruneRefusalReason() !== null || !this.deps.runtime.current(token) || this.deps.graph() !== graph) return;
    if (!graph.rate.withinActiveHours()) return;
    // A manual prune may have started AND completed during the hold — its
    // fresh lastRunAt makes the schedule no longer due.
    {
      const s = this.deps.resolveSettings();
      if (!pruneDue(s.pruneScheduleDays, s.pruneLastRunAt, graph.clock.now())) return;
    }
    const cooldownAfterHold = this.pruneRateCooldown(graph);
    if (cooldownAfterHold !== null) {
      logger.info(
        'foundation: scheduled prune skipped after hold — rate-limit cool-down',
        cooldownAfterHold,
      );
      return;
    }

    logger.info('foundation: scheduled prune due, auto-starting', {
      scheduleDays: settings.pruneScheduleDays,
      lastRunAt: settings.pruneLastRunAt,
      growthState: graph.engine.status().state,
      weave: settings.weaveEnabled && settings.pacingModel === 'organic',
    });
    // Organic + weave: SCAN and enqueue — the growth loop drains the census woven into
    // its own sessions (no separate bulk driver). Otherwise: the legacy bulk run.
    if (settings.weaveEnabled && settings.pacingModel === 'organic') {
      const res = await control.scanPrune();
      if (res.ok) void this.deps.updateSettings({ pruneLastRunAt: graph.clock.now() });
      return;
    }
    void control.startPrune();
  }
}
