/**
 * Prune controls: the persisted candidates read, the manual scan and run with
 * stop/pause/resume, and the tab hand-off with growth (one driver at a time).
 */

import type { PruneCandidate, PruneStatus } from '@/engine/prune-engine';
import type { BuiltGraph } from '@/main/services/graph-types';
import type { RuntimeCoordinator } from '@/main/services/runtime-coordinator';
import type { TabLease } from '@/main/services/tab-lease';
import type { TabActivity } from '@/main/tab-activity';
import { PRUNE } from '@/timing/config';
import type { PruneControlResult, PruneScanResult } from '@/types';
import * as logger from '@/utils/logger';

export interface PruneControlDeps {
  runtime: RuntimeCoordinator;
  lease: TabLease;
  activity: TabActivity;
  /** The live graph, or `null` while the session is closed. */
  graph(): BuiltGraph | null;
  /** Ensure the graph is built and hand it back (`null` when not logged in). */
  builtGraph(): Promise<BuiltGraph | null>;
  /** The last connectivity the monitor reported. */
  online(): boolean;
  /** True while a manual op drives the tab. */
  manualDriving(): boolean;
  /** Abort the in-flight mutation preparation, if any. */
  abortPreparation(): void;
  /** Standalone writers reconcile under the borrowed lease before mutating. */
  prepareMutation(graph: BuiltGraph): Promise<boolean>;
  /** Restart growth when the user still wants it running. */
  resumeDesiredRun(): void;
  /** The settings-seeded idle prune status before the graph exists. */
  notBuiltPruneStatus(): PruneStatus;
  /** True while an Explore Boost window is open; always false until wired. */
  boostActive?: () => boolean;
}

export class PruneControl {
  private readonly lease: TabLease;
  private readonly runtime: RuntimeCoordinator;
  private readonly activity: TabActivity;
  private readonly deps: Required<PruneControlDeps>;
  /**
   * Bumped by every {@link stopPrune}. A prune scan/run request that was
   * waiting on the lazy graph build compares this to the value it captured at
   * entry — a mismatch means the user pressed Stop while the build was in
   * flight, and the pending scan/run cancels instead of starting anyway.
   */
  private pruneStopEpoch = 0;

  constructor(deps: PruneControlDeps) {
    this.deps = { ...deps, boostActive: deps.boostActive ?? (() => false) };
    this.lease = deps.lease;
    this.runtime = deps.runtime;
    this.activity = deps.activity;
  }

  /** The live graph, or `null` while the session is closed. */
  private get graph(): BuiltGraph | null {
    return this.deps.graph();
  }

  /** Cancel any scan/run still waiting on the build (a stop that is not the user's). */
  cancelPending(): void {
    this.pruneStopEpoch += 1;
  }

  /**
   * The PERSISTED scan's not-yet-visited candidates (raw census — the renderer
   * filters against the live whitelist), so the candidates list auto-populates
   * from saved data on app launch instead of sitting empty until a fresh scan.
   * Empty when not logged in or no snapshot exists. Never throws across IPC.
   */
  async pruneCandidates(): Promise<PruneCandidate[]> {
    const graph = await this.deps.builtGraph();
    if (graph === null) return [];
    try {
      return graph.store.getPruneScan()?.remaining ?? [];
    } catch (e) {
      logger.error('foundation.pruneCandidates: failed', { error: String(e) });
      return [];
    }
  }

  async scanPrune(): Promise<PruneScanResult> {
    // Veil: held from IPC entry — the lazy build's navigations and the dialog
    // work all drive the tab, not just the post-first-status stretch.
    return this.activity.with('prune-scan', () => this.scanPruneHeld());
  }

  private async scanPruneHeld(): Promise<PruneScanResult> {
    const empty = { following: 0, followers: 0, candidates: [] };
    const epoch = this.pruneStopEpoch;
    const graph = await this.deps.builtGraph();
    if (graph === null) {
      return { ok: false, reason: 'not-logged-in', ...empty };
    }
    // A stop that landed while the graph was still building must cancel this
    // pending scan — pre-build there is no engine to stop, so the stop is
    // recorded as an epoch bump and honored here instead of being lost.
    if (this.pruneStopEpoch !== epoch) {
      logger.info('foundation.scanPrune: cancelled by stop during build');
      return { ok: false, reason: 'stopped', ...empty };
    }
    const refusal = this.pruneRefusalReason();
    if (refusal !== null) {
      logger.warn('foundation.scanPrune: refused', { reason: refusal });
      return { ok: false, reason: refusal, ...empty };
    }
    // Claim the driver token first (blocks a concurrent growth start/resume or a
    // second prune), then borrow the tab: pause the growth engine if it is
    // running and wait for it to park before scanning.
    const leaseToken = this.lease.claim('prune');
    try {
      if (!(await this.acquireTabForPrune())) {
        return { ok: false, reason: 'growth-busy', ...empty };
      }
      if (!this.runtime.ready() || this.pruneStopEpoch !== epoch) return { ok: false, reason: 'stopped', ...empty };
      const scan = graph.pruneEngine.scan();
      graph.prunePromise = scan.then(() => {}, () => {});
      const result = await scan;
      return result.aborted ? { ok: false, reason: 'scan-incomplete', ...result } : { ok: true, ...result };
    } catch (e) {
      logger.error('foundation.scanPrune: failed', { error: String(e) });
      return { ok: false, reason: String(e), ...empty };
    } finally {
      if (this.lease.owns('prune', leaseToken)) {
        this.lease.release('prune', leaseToken);
        this.releaseTabAfterPrune();
      }
    }
  }

  /** Prepare current knowledge under the borrowed lease, then start pruning. */
  async startPrune(): Promise<PruneControlResult> {
    // Veil: held from IPC entry; on a successful launch the hold transfers to
    // the fire-and-forget run (released when the run settles), and every
    // refusal path releases it on the way out.
    this.activity.hold('prune-run');
    let transferredToRun = false;
    try {
      const epoch = this.pruneStopEpoch;
      const graph = await this.deps.builtGraph();
      if (graph === null) {
        return { ok: false, reason: 'not-logged-in', status: this.deps.notBuiltPruneStatus() };
      }
      // Mirror scanPrune: a stop during the build cancels this pending run.
      if (this.pruneStopEpoch !== epoch) {
        logger.info('foundation.startPrune: cancelled by stop during build');
        return { ok: false, reason: 'stopped', status: graph.pruneEngine.status() };
      }
      const refusal = this.pruneRefusalReason();
      if (refusal !== null) {
        logger.warn('foundation.startPrune: refused', { reason: refusal });
        return { ok: false, reason: refusal, status: graph.pruneEngine.status() };
      }
      const leaseToken = this.lease.claim('prune');
      // Borrow the tab BEFORE the run starts: pause a running growth engine and
      // await its park. Await here (not inside the fire-and-forget run) so the
      // caller's result reflects a clean hand-off; the UI's run spinner covers it.
      if (!(await this.acquireTabForPrune())) {
        this.lease.release('prune');
        return { ok: false, reason: 'growth-busy', status: graph.pruneEngine.status() };
      }
      if (!this.runtime.ready() || this.pruneStopEpoch !== epoch) {
        this.lease.release('prune');
        this.releaseTabAfterPrune();
        return { ok: false, reason: 'stopped', status: graph.pruneEngine.status() };
      }
      if (!await this.deps.prepareMutation(graph) || this.pruneStopEpoch !== epoch) {
        this.lease.release('prune', leaseToken);
        this.releaseTabAfterPrune();
        return { ok: false, reason: 'reconciliation-incomplete', status: graph.pruneEngine.status() };
      }
      const run = graph.pruneEngine
        .run()
        .catch((e: unknown) => {
          logger.error('foundation: prune run errored', { error: String(e) });
        })
        .finally(() => {
          if (this.lease.owns('prune', leaseToken)) {
            this.lease.release('prune', leaseToken);
            this.releaseTabAfterPrune();
          }
          this.activity.release('prune-run');
        });
      graph.prunePromise = run;
      transferredToRun = true;
      return { ok: true, status: graph.pruneEngine.status() };
    } finally {
      if (!transferredToRun) this.activity.release('prune-run');
    }
  }

  /**
   * Stop an active prune scan/run: aborts in-flight sleeps between actions AND
   * breaks a mid-scan scroll loop between rounds, so `scanPrune`/`startPrune`
   * resolve promptly and the tab is left clean.
   */
  async stopPrune(): Promise<PruneStatus> {
    // Recorded even when no engine exists yet: a scan/run request awaiting the
    // graph build checks this epoch and cancels itself instead of starting.
    this.pruneStopEpoch += 1;
    if (this.lease.owner() === 'prune') this.deps.abortPreparation();
    if (this.graph === null) return this.deps.notBuiltPruneStatus();
    this.graph.pruneEngine.stop();
    return this.graph.pruneEngine.status();
  }

  /**
   * Pause an active prune run between unfollows. The run keeps every claim it
   * holds — the tab driver token and a growth pause it performed — so growth
   * stays excluded until the run is resumed and completes, or is stopped.
   */
  async pausePrune(): Promise<PruneStatus> {
    if (this.graph === null) return this.deps.notBuiltPruneStatus();
    this.graph.pruneEngine.pause();
    return this.graph.pruneEngine.status();
  }

  /** Resume a paused prune run (the owed inter-action delay is served first). */
  async resumePrune(): Promise<PruneStatus> {
    if (this.graph === null) return this.deps.notBuiltPruneStatus();
    this.graph.pruneEngine.resume();
    return this.graph.pruneEngine.status();
  }

  /** The prune status projection; a settings-seeded idle status before build. */
  async pruneStatus(): Promise<PruneStatus> {
    if (this.graph === null) return this.deps.notBuiltPruneStatus();
    return this.graph.pruneEngine.status();
  }

  /**
   * Why a prune scan/run may not start now. Since Phase 5's tab hand-off, a
   * running growth engine no longer blocks prune — prune PAUSES it and resumes
   * it after (see {@link acquireTabForPrune}) — so the only hard refusal is that
   * a prune scan/run already holds the driver token (`prune-running`). Null when
   * clear. (A stuck-mid-step growth engine that won't park in time yields a
   * separate `growth-busy` refusal at acquire time, not here.)
   */
  pruneRefusalReason(): string | null {
    if (!this.runtime.ready()) return 'runtime-not-ready';
    if (!this.deps.online()) return 'offline';
    if (this.deps.manualDriving()) return 'manual-running';
    if (this.lease.owner() === 'prune') return 'prune-running';
    return null;
  }

  /**
   * Borrow the shared tab for a prune (see {@link TabLease.borrowFromGrowth}).
   * Caller must already hold the `'prune'` driver token.
   */
  private async acquireTabForPrune(): Promise<boolean> {
    if (this.graph === null) return false;
    return this.lease.borrowFromGrowth('prune', this.graph.engine, PRUNE.PARK_TIMEOUT_MS);
  }

  /** Hand the tab back after a prune. Idempotent — both exit paths call it. */
  private releaseTabAfterPrune(): void {
    if (!this.runtime.ready() || this.runtime.snapshot().desired !== 'running') {
      this.lease.forgetHandoffs();
      return;
    }
    this.lease.returnToGrowth('prune', this.graph?.engine ?? null);
    this.deps.resumeDesiredRun();
  }
}
