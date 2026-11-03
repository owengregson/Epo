/**
 * Foundation — the Epo v3 composition root (Wave 4).
 *
 * This is where the whole dependency graph is assembled and the Engine runs. The
 * graph is built LAZILY: nothing is constructed until the user is logged in and
 * `ownPk` (the `ds_user_id` cookie) is resolvable, at which point the graph is
 * built once and cached. The IPC handlers (`src/main/ipc.ts`) delegate straight to
 * the async methods here:
 *
 *   - Engine controls: start / pause / resume / stop / status.
 *   - Manual live-gate ops: login, readFollowers, followOne, unfollowOne — these
 *     reuse the SAME rim (`FollowerAcquisition` / `ChurnActions`) the Engine uses,
 *     so there is exactly one scraping/acting implementation (§6).
 *
 * The pure engine components stay behind their ports; every live/timing concern is
 * confined to the rim and the Engine. No handler-facing method throws across the
 * IPC boundary: fallible work returns a typed result and logs on failure (never a
 * silent `catch {}`).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type ActivityReporter,
  NOOP_ACTIVITY_REPORTER,
} from '@/adapter/activity-reporter';
import { IG_HOME_URL, type InstagramTab } from '@/adapter/tab';
import type { EngineStatus } from '@/engine/engine';
import { journaledMutation } from '@/engine/journaled-mutation';
import type { PruneCandidate, PruneStatus } from '@/engine/prune-engine';
import { SystemClock } from '@/governors/clock';
import type { CursorObserver } from '@/interaction/input-driver';
import { referenceTempoSource } from '@/kernel/tempo';
import {
  shapeChainList,
  shapeGraphSnapshot,
  shapeQueueList,
  shapeTargetDetail,
} from '@/main/foundation-reads';
import { notBuiltPruneStatus, notBuiltStatus } from '@/main/modules/not-built';
import { Projections, type PushFn, UNWIRED_SOURCES } from '@/main/modules/projections';
import { PruneControl } from '@/main/modules/prune-control';
import { PruneSchedule } from '@/main/modules/prune-schedule';
import { SeedCheckService } from '@/main/modules/seed-check';
import { GraphSession } from '@/main/modules/session';
import { SettingsService } from '@/main/modules/settings-service';
import { landingStep, resumeStep, runStep, type StartupStep } from '@/main/modules/startup-steps';
import { composeStatus } from '@/main/modules/status-compose';
import { DriverSignal } from '@/main/services/driver-signal';
import {
  type BuiltGraph,
  buildGraph,
  type GraphBuildDeps,
} from '@/main/services/graph-builder';
import type { IgSessionPort } from '@/main/services/ig-session';
import { RuntimeCoordinator, type RuntimeSnapshot } from '@/main/services/runtime-coordinator';
import { TabLease } from '@/main/services/tab-lease';
import { TabActivity } from '@/main/tab-activity';
import type { Settings } from '@/settings/settings';
import { RECOVERY, SCHEDULER, TAB } from '@/timing/config';
import { sample, sleep, TIMED_OUT, withTimeout } from '@/timing/primitives';
import { ScheduleManager } from '@/timing/schedule-manager';
import { MS_PER_DAY } from '@/timing/units';
import type {
  ActionResult,
  ChainTargetDetail,
  ChainTargetView,
  EpoStatus,
  FollowState,
  GraphSnapshot,
  GrowthSeriesRead,
  PruneControlResult,
  PruneScanResult,
  QueueListResult,
  ReadFollowersResult,
  SeedCheck,
} from '@/types';
import * as logger from '@/utils/logger';

const IG_DB_FILE = 'epo.db';

// Timing constants (username-resolve retry, prune park timeout, watcher cadence)
// live in the shared registry: see `SCHEDULER.*` and `PRUNE.PARK_TIMEOUT_MS` in
// `@/timing/config`.

export interface FoundationDeps {
  tab: InstagramTab;
  /**
   * Where the knowledge DB and the settings file live. Injected (not read from
   * `app.getPath`) so the composition root owns no electron import.
   */
  userDataDir: string;
  /** The persistent IG session: the identity cookie and the logout wipe. */
  igSession: IgSessionPort;
  /**
   * The ONE renderer push seam (main wires it to `shell.send` through the
   * contract's `PUSH` table). It replaced three separate callbacks — status,
   * prune status and chain list — that all rode the same store-mutation
   * throttle; which projections ride it is now the `PROJECTIONS` table in
   * `src/main/modules/projections.ts`. See ADR 1008.
   */
  push?: PushFn;
  /**
   * Optional tap on the Interactor's synthetic cursor (position + button state).
   * Main wires this to the overlay veil's digital-cursor display; it observes
   * driver output only and never influences the input pipeline.
   */
  cursorObserver?: CursorObserver;
  /**
   * The tab-activity state machine's output (see {@link TabActivity}):
   * fired on every hold-set change with whether ANY routine currently drives
   * the Instagram page + the live hold names. Main wires `active` straight to
   * the overlay veil, so the veil is up for the WHOLE of any tab-driving routine
   * (graph build / identity navigation included) and every manual one-off op —
   * not just while a status projection reads `running`.
   */
  onActivity?: (active: boolean, holds: string[]) => void;
  /**
   * Live "what is it doing right now" tap. Every tab-driving layer reports its
   * current phase through this (direct JSON-API reads vs real page driving), and
   * main forwards it to the overlay veil's readout. Purely observational.
   */
  activityReporter?: ActivityReporter;
  /**
   * Ask the main-process ConnectivityMonitor for an IMMEDIATE re-probe (the
   * post-wake sequence calls this — the periodic cadence is too slow to catch
   * a network stack still re-establishing after sleep). Injected because the
   * monitor lives in main (electron-bound) and the Foundation must stay
   * electron-mockable for jest.
   */
  requestConnectivityCheck?: () => void;
}

/** Inputs to the step-watchdog fire decision — see {@link stepWatchdogShouldFire}. */
export interface StepWatchdogInput {
  /** The growth engine's visible state right now. */
  engineState: EngineStatus['state'];
  now: number;
  /** Epoch ms of the last engine status emission (or start baseline). */
  lastActivityAt: number;
  /** How long the engine may be silent before it counts as wedged. */
  staleAfterMs: number;
  /** Keys of every wait currently pending in the shared DelayManager. */
  pendingDelayKeys: readonly string[];
  online?: boolean;
}

/**
 * Whether the main-process step watchdog must fire: the growth engine claims
 * to be RUNNING, nothing has been heard from it beyond the stale window, AND
 * no `engine:`-prefixed wait is pending in the DelayManager. Every legitimate
 * long park (velocity park, enrich backoff, session gap) registers an
 * `engine:` wait, so a parked loop can never false-positive here — only a
 * loop wedged on a never-settling tab/CDP await is both silent AND waitless.
 */
export function stepWatchdogShouldFire(input: StepWatchdogInput): boolean {
  if (input.online === false) return false;
  if (input.engineState !== 'running') return false;
  if (input.now - input.lastActivityAt <= input.staleAfterMs) return false;
  return !input.pendingDelayKeys.some((k) => k.startsWith('engine:'));
}

export class Foundation {
  private readonly tab: InstagramTab;
  private readonly userDataDir: string;
  private readonly igSession: IgSessionPort;
  private readonly cursorObserver?: CursorObserver;
  /** Live phase readout tap (veil); a no-op when main wires none. */
  private readonly reporter: ActivityReporter;
  /**
   * The §2 push machinery: ONE store subscription, one trailing throttle, one
   * table of projections. Bound to each built graph by the session's open
   * transition and unbound by its close — the kernel binding rule, so its
   * lifetime cannot drift from the graph it mirrors.
   */
  private readonly projections: Projections;
  /**
   * The lazy build, the identity cache and the ordered teardown: the six
   * fields this class used to carry (`graph`, `buildPromise`, `ownPkCache`,
   * `usernameRetryAt`, `disposing`, `tearingDown`) behind one object. See
   * `src/main/modules/session.ts` and ADR 1007.
   */
  private readonly session: GraphSession;

  /** The live graph, or `null` while the session is closed. */
  private get graph(): BuiltGraph | null {
    return this.session.current();
  }

  /** True once {@link dispose} began — nothing rebuilds from there on. */
  private get disposing(): boolean {
    return this.session.disposing;
  }

  /** True while a graph teardown or a data wipe is in progress. */
  private get tearingDown(): boolean {
    return this.session.tearingDown;
  }
  /**
   * The tab-ownership state machine (driver token, growth hand-offs, tour hold,
   * spin-up bridge) — see {@link TabLease}.
   */
  private readonly lease = new TabLease();
  private readonly runtime: RuntimeCoordinator;
  private manualDriving = false;
  private preparation: AbortController | null = null;
  private readonly signals = new DriverSignal();

  /** Settings load, cache, persist and live reload. */
  readonly settings: SettingsService;
  /** The manual prune controls and the scheduled prune over them. */
  private readonly prune: PruneControl;
  private readonly pruneSchedule: PruneSchedule;
  private readonly seed: SeedCheckService;
  /** The startup steps, run as the Foundation always ran them. */
  private readonly landing: StartupStep;
  private readonly resume: StartupStep;
  /**
   * In-flight MANUAL operations (read-followers, follow/unfollow-one,
   * seed-check). Teardown awaits these before closing the store — an
   * un-tracked manual acquire used to keep writing edges into a closed
   * database handle when the app quit mid-read.
   */
  private readonly inFlightManualOps = new Set<Promise<unknown>>();
  /**
   * Last connectivity reported by the ConnectivityMonitor. Kept here (not only in
   * the Engine) so the not-built status can still reflect it.
   */
  private lastOnline = true;
  /** The one ScheduleManager for Foundation-level periodic work + cadences. */
  private readonly scheduler = new ScheduleManager({ clock: new SystemClock() });
  /** Aborted once {@link dispose} begins — interrupts identity-resolution waits. */
  private readonly disposeAbort = new AbortController();
  /**
   * The veil's stateful authority: named holds at every source of tab
   * work (build, growth loop, prune scan/run, manual ops). Active while
   * ANY hold exists — see {@link TabActivity}.
   */
  private readonly activity: TabActivity;
  /** Main's hook for an immediate ConnectivityMonitor re-probe (post-wake). */
  private readonly requestConnectivityCheck?: () => void;
  /**
   * Epoch ms of the last tab-health-event recovery ATTEMPT: repeated events
   * (a crashing renderer emits a burst) coalesce into one recovery per
   * `RECOVERY.TAB_EVENT_DEBOUNCE_MS` window.
   */
  private lastTabEventRecoveryAt = 0;
  /** Re-entrancy latch for the tab-health-event recovery flow. */
  private tabEventRecoveryInFlight = false;
  /** Re-entrancy latch for the ordered post-wake sequence (double 'resume'). */
  private resumeSequenceInFlight: Promise<void> | null = null;

  constructor(deps: FoundationDeps) {
    this.tab = deps.tab;
    this.userDataDir = deps.userDataDir;
    this.runtime = new RuntimeCoordinator(path.join(deps.userDataDir, 'epo-runtime.json'));
    this.igSession = deps.igSession;
    this.cursorObserver = deps.cursorObserver;
    this.reporter = deps.activityReporter ?? NOOP_ACTIVITY_REPORTER;
    this.requestConnectivityCheck = deps.requestConnectivityCheck;
    this.projections = new Projections({ push: deps.push });
    this.settings = new SettingsService({ userDataDir: deps.userDataDir, graph: () => this.graph });
    this.session = new GraphSession({
      igSession: deps.igSession,
      build: (ownPk, ownUsername) => this.build(ownPk, ownUsername),
      drainManualOps: () => this.drainManualOps(),
      onIdentityChanged: () => {
        this.blockRuntime('account-changed');
        this.lease.forgetHandoffs();
        void this.updateSettings({ sweepLastRunAt: null, pruneLastRunAt: null });
      },
    });
    // The kernel binding rule (ADR 1007): everything declared over the session
    // is wired on OPEN and unwired on CLOSE — no `if (graph === null)` anywhere
    // in the wiring, and no way for a subscription to outlive its store.
    this.session.session.onOpen((graph) => {
      this.scheduler.every('store:retention', MS_PER_DAY, () => {
        if (this.graph === graph && !this.disposing) graph.store.pruneRetainedLogs();
      }, { unref: true });
      graph.engine.setOnline(this.lastOnline);
      this.projections.bind(graph.store, {
        status: () => this.builtStatus(), pruneStatus: () => graph.pruneEngine.status(),
        chainList: () => this.shapedChainList(graph), ...UNWIRED_SOURCES,
      });
    });
    this.session.session.onClose(() => {
      this.scheduler.stop('store:retention');
      this.lease.release('growth');
      this.lease.release('prune');
      // Before ANYTHING else in the teardown: late writes from draining ops
      // must not schedule a push into a closing store.
      this.projections.unbind();
      // A prune or tour hand-off in flight has nothing to resume once the
      // graph is gone.
      this.lease.forgetHandoffs();
    });
    this.activity = new TabActivity((active, holds) => {
      logger.info('foundation: tab activity', { active, holds });
      deps.onActivity?.(active, holds);
    });
    this.prune = new PruneControl({ runtime: this.runtime, lease: this.lease, activity: this.activity,
      graph: () => this.graph, builtGraph: () => this.builtGraph(), online: () => this.lastOnline,
      manualDriving: () => this.manualDriving, abortPreparation: () => this.preparation?.abort(),
      prepareMutation: (graph) => this.prepareMutation(graph), resumeDesiredRun: () => this.resumeDesiredRun(),
      notBuiltPruneStatus: () => this.notBuiltPruneStatus() });
    this.pruneSchedule = new PruneSchedule({ control: this.prune, runtime: this.runtime, lease: this.lease,
      scheduler: this.scheduler, disposeSignal: this.disposeAbort.signal, graph: () => this.graph,
      builtGraph: () => this.builtGraph(), disposing: () => this.disposing,
      resolveSettings: () => this.resolveSettings(), updateSettings: (partial) => this.updateSettings(partial) });
    this.seed = new SeedCheckService({ activity: this.activity, trackManualOp: (run) => this.trackManualOp(run),
      builtGraph: () => this.builtGraph(), busyDriverReason: () => this.busyDriverReason(),
      setManualDriving: (on) => { this.manualDriving = on; }, resumeDesiredRun: () => this.resumeDesiredRun() });
    this.landing = landingStep({ tab: this.tab, runtime: this.runtime, lease: this.lease, activity: this.activity,
      disposing: () => this.disposing, ensureBuilt: () => this.ensureBuilt(), graph: () => this.graph });
    this.resume = resumeStep({ runtime: this.runtime, lease: this.lease, igSession: this.igSession,
      disposing: () => this.disposing, blockRuntime: (reason) => this.blockRuntime(reason),
      startEngine: (opts) => this.startEngine(opts) });
    // Tab health events (debugger detach, renderer gone/unresponsive, input
    // fallback): the tab reports, the Foundation owns the recovery policy.
    // Guarded — partially-shaped test tabs may not carry the callback seam.
    if (typeof this.tab.onUnhealthy === 'function') {
      this.tab.onUnhealthy((reason) => this.handleTabUnhealthy(reason));
    }
    logger.info('foundation created (graph deferred until login)');
  }

  // -------------------------------------------------------------------------
  // Login / identity / lazy build
  // -------------------------------------------------------------------------

  /** True once the persistent IG session carries a `ds_user_id` cookie. */
  async isLoggedIn(): Promise<boolean> {
    return this.session.isLoggedIn();
  }

  /**
   * Open the dependency graph store-first, once, after login (see
   * `src/main/modules/session.ts`, which owns the memoized open, the
   * confirm-account rebuild and the teardown guards). Never touches the tab.
   */
  async ensureBuilt(): Promise<boolean> {
    if (this.runtime.snapshot().phase !== 'ready') return this.graph !== null;
    return this.session.ensureBuilt();
  }

  /**
   * The not-built guard copied across every IPC entry point, centralized:
   * ensure the graph is built and hand it back, or `null` (each caller returns
   * its own safe empty). Callers hold the RETURNED graph — never re-read
   * `this.graph` after an await, where a concurrent teardown can null it.
   */
  private async builtGraph(): Promise<BuiltGraph | null> {
    if (this.runtime.snapshot().phase !== 'ready') return this.graph;
    return this.session.builtGraph();
  }

  /**
   * Mutual exclusion (Phase 5), centralized: the prune routine holds the tab
   * driver token — never put a second driver on the one shared tab. Returns the
   * typed refusal status to hand back, or `null` when growth may proceed.
   */
  private refuseIfPruneActive(op: string): EpoStatus | null {
    if (this.lease.owner() !== 'prune') return null;
    logger.warn(`foundation.${op}: prune active, refusing`);
    return { ...this.builtStatus(), refusal: 'prune-running' };
  }

  /**
   * Open Instagram in the embedded tab; the user completes login there. If the
   * persisted session is already logged in, the graph is built here too so the
   * first status reflects a live engine.
   */
  async login(): Promise<EpoStatus> {
    this.tab.show();
    try {
      await this.tab.goto(IG_HOME_URL);
    } catch (e) {
      logger.error('foundation.login: navigation failed', { error: String(e) });
    }
    const built = await this.ensureBuilt();
    // Default page: once logged in, rest on the user's OWN profile (fire-and-
    // forget — the login result must not wait out the click/nav settle).
    if (built) void this.landOnOwnProfile();
    return this.status();
  }

  /** Land the tab on the user's own profile, the default page (see {@link landingStep}). */
  landOnOwnProfile(): Promise<void> { return runStep(this.landing, this.disposeAbort.signal); }

  // -------------------------------------------------------------------------
  // Engine controls (build-if-needed)
  // -------------------------------------------------------------------------

  /** Start the engine loop — fire-and-forget (never awaits the loop). */
  async startEngine(opts: { automaticToken?: number } = {}): Promise<EpoStatus> {
    const automatic = opts.automaticToken !== undefined;
    const token = opts.automaticToken ?? this.runtime.command('running');
    if (!automatic) this.lease.forgetHandoffs();
    if (!this.runtime.wantsRun(token)) return { ...(await this.status()), refusal: 'runtime-not-ready' };
    const graph = await this.builtGraph();
    if (graph === null) return this.notBuiltStatus(await this.isLoggedIn());
    if (!this.runtime.wantsRun(token)) return { ...this.builtStatus(), refusal: 'runtime-intent-changed' };
    if (automatic && this.runtime.snapshot().accountPk !== graph.ownPk) {
      this.blockRuntime('account-changed');
      return { ...this.builtStatus(), refusal: 'account-changed' };
    }
    if (!automatic) this.runtime.authorizeAccount(graph.ownPk);
    const refusal = this.refuseIfPruneActive('startEngine');
    if (refusal !== null) return refusal;
    const state = graph.engine.status().state;
    if (state === 'running' || state === 'paused') {
      // Already the active driver — a second start is the Engine's own no-op.
      return this.builtStatus();
    }
    if (this.manualDriving) return { ...this.builtStatus(), refusal: 'manual-running' };
    this.runtime.acknowledge();
    this.lease.claim('growth');
    // Watchdog baseline: a fresh run starts with a full stale window, even
    // when the very first step wedges before any status emit lands.
    // Veil: bridge the spin-up gap — held until the engine's first status emit
    // (where the `growth-loop` signal takes over) or, as a backstop, loop exit.
    if (this.lease.beginGrowthStart()) this.activity.hold('growth-start');
    // Fire-and-forget: `start()` resolves only when the loop exits; do NOT await
    // here. f14: keep the loop promise so `dispose()` can await its exit before
    // closing the store (a mid-step store call must not hit a closed DB).
    const loop: Promise<void> = graph.engine
      .start()
      .catch((e: unknown) => {
        logger.error('foundation: engine loop errored', { error: String(e) });
      })
      .finally(() => {
        // Generation guard: after a watchdog restart the OLD wedged loop can
        // settle long after a NEW run has started (its dead webContents finally
        // reloads). Only the loop the graph still points at may clear the
        // driver token / veil signal — a stale settlement clearing them would
        // free the tab for prune while the live growth run is still driving it.
        if (graph.enginePromise !== loop) return;
        this.lease.release('growth');
        this.releaseGrowthStartBridge();
        this.activity.signal('growth-loop', false);
      });
    graph.enginePromise = loop;
    return this.builtStatus();
  }

  /** Pause the engine between actions. */
  async pauseEngine(): Promise<EpoStatus> {
    this.runtime.command('paused');
    this.lease.forgetHandoffs();
    const graph = await this.builtGraph();
    if (graph === null) return this.notBuiltStatus(await this.isLoggedIn());
    graph.engine.pause();
    return this.builtStatus();
  }

  /** Resume a paused engine. */
  async resumeEngine(): Promise<EpoStatus> {
    const token = this.runtime.command('running');
    this.lease.forgetHandoffs();
    if (!this.runtime.wantsRun(token)) return { ...(await this.status()), refusal: 'runtime-not-ready' };
    const graph = await this.builtGraph();
    if (graph === null) return this.notBuiltStatus(await this.isLoggedIn());
    if (!this.runtime.wantsRun(token)) return this.builtStatus();
    // A prune holds the tab — resuming growth now would put a second driver on
    // it. Refuse; the prune's completion resumes growth itself when it was the
    // one that paused it (leave-alone otherwise).
    const refusal = this.refuseIfPruneActive('resumeEngine');
    if (refusal !== null) return refusal;
    if (this.manualDriving) return { ...this.builtStatus(), refusal: 'manual-running' };
    this.runtime.authorizeAccount(graph.ownPk);
    this.lease.claim('growth');
    graph.engine.resume();
    return this.builtStatus();
  }

  /** Stop the engine loop (aborts in-flight sleeps). */
  async stopEngine(): Promise<EpoStatus> {
    this.runtime.command('stopped');
    this.preparation?.abort();
    this.lease.forgetHandoffs();
    const graph = this.graph;
    if (graph === null) return this.notBuiltStatus(await this.isLoggedIn());
    graph.engine.stop();
    return this.builtStatus();
  }

  /** Deliberately retire the old source portfolio and restart from this seed. */
  async restartFromSeed(seed: string): Promise<EpoStatus> {
    const token = this.runtime.token();
    const clean = seed.trim().replace(/^@/, '');
    if (clean === '') return { ...(await this.status()), refusal: 'seed-missing' };
    const graph = await this.builtGraph();
    if (graph === null) return this.notBuiltStatus(await this.isLoggedIn());
    if (!this.runtime.current(token) || !this.runtime.ready()) return { ...this.builtStatus(), refusal: 'runtime-intent-changed' };
    const refusal = this.refuseIfPruneActive('restartFromSeed');
    if (refusal !== null) return refusal;
    graph.engine.stop();
    if (graph.enginePromise !== null) {
      // Bounded (mirrors the manual-op drain below in teardown): a wedged loop
      // that never settles must not park the restart forever — the new run
      // repoints `graph.enginePromise`, and the stale loop's eventual
      // settlement is neutralized by the generation guard in `startEngine`.
      try {
        const exited = await withTimeout(graph.enginePromise, TAB.TEARDOWN_ENGINE_WAIT_MS);
        if (exited === TIMED_OUT) {
          logger.warn('foundation.restartFromSeed: engine loop did not exit in time, restarting anyway', {
            timeoutMs: TAB.TEARDOWN_ENGINE_WAIT_MS,
          });
        }
      } catch (e) {
        logger.error('foundation.restartFromSeed: loop rejected on stop', { error: String(e) });
      }
    }
    await this.updateSettings({ seed: clean });
    if (!this.runtime.current(token) || !this.runtime.ready()) return { ...this.builtStatus(), refusal: 'runtime-intent-changed' };
    // Scrap the current session: every active target is retired; queued
    // records against them stop refilling and the chain restarts fresh.
    for (const t of graph.store.listTargets()) {
      if (t.status === 'active') graph.store.setTargetStatus(t.accountPk, 'exhausted');
    }
    graph.store.setSourceFrontierState(null);
    // A seed the graph has already seen re-enters DELIBERATELY at the next
    // chain index; an unseen one bootstraps through the normal seed path.
    const pk = graph.store.pkByUsername(clean);
    if (pk !== null) {
      graph.store.addTarget({
        accountPk: pk,
        source: 'seed',
        status: 'active',
        chainIndex: graph.store.nextChainIndex(),
      });
    }
    logger.info('foundation: restarting chain from seed', { seed: clean, knownPk: pk });
    return this.startEngine();
  }

  // -------------------------------------------------------------------------
  // Auto-prune controls (Phase 5) — same tab/rim, mutually exclusive with growth
  // -------------------------------------------------------------------------

  /** The persisted scan's candidates (see {@link PruneControl.pruneCandidates}). */
  pruneCandidates(): Promise<PruneCandidate[]> { return this.prune.pruneCandidates(); }
  /** Scan the own lists for prune candidates (see {@link PruneControl.scanPrune}). */
  scanPrune(): Promise<PruneScanResult> { return this.prune.scanPrune(); }
  /** Prepare, then start a prune run (see {@link PruneControl.startPrune}). */
  startPrune(): Promise<PruneControlResult> { return this.prune.startPrune(); }
  /** Stop an active prune scan/run (see {@link PruneControl.stopPrune}). */
  stopPrune(): Promise<PruneStatus> { return this.prune.stopPrune(); }
  /** Pause an active prune run between unfollows. */
  pausePrune(): Promise<PruneStatus> { return this.prune.pausePrune(); }
  /** Resume a paused prune run. */
  resumePrune(): Promise<PruneStatus> { return this.prune.resumePrune(); }
  /** The prune status projection; a settings-seeded idle status before build. */
  pruneStatus(): Promise<PruneStatus> { return this.prune.pruneStatus(); }

  private resumeDesiredRun(): void {
    if (this.disposing || !this.runtime.wantsRun() || this.lease.owner() !== null || this.manualDriving || this.graph?.engine.status().state !== 'idle') return;
    void this.startEngine({ automaticToken: this.runtime.token() }).catch((error: unknown) => {
      this.blockRuntime('automatic-resume-failed', String(error));
    });
  }

  /** Standalone writers reconcile without launching growth; Stop owns this read phase too. */
  private async prepareMutation(graph: BuiltGraph): Promise<boolean> {
    const controller = new AbortController();
    this.preparation = controller;
    try {
      const pending = graph.prepareMutation();
      if (this.lease.owner() === 'prune') graph.prunePromise = pending.then(() => {}, () => {});
      return await pending && !controller.signal.aborted && this.graph === graph && this.runtime.ready();
    } catch (error) {
      this.runtime.record('mutation-preparation-failed', String(error));
      return false;
    } finally { if (this.preparation === controller) this.preparation = null; }
  }

  // -------------------------------------------------------------------------
  // Manual live-gate ops (build-if-needed; same rim the Engine uses — §6)
  // -------------------------------------------------------------------------

  /**
   * Track a manual op's promise for the teardown drain: `dispose()` awaits
   * every in-flight manual op before closing the store beneath it.
   */
  private trackManualOp<T>(run: () => Promise<T>): Promise<T> {
    const p = run();
    this.inFlightManualOps.add(p);
    void p.then(() => this.inFlightManualOps.delete(p), () => this.inFlightManualOps.delete(p));
    return p;
  }

  /** Read a target's followers into the knowledge graph via the shared rim. */
  async readFollowers(target: string): Promise<ReadFollowersResult> {
    // Veil: a manual read drives the tab exactly like the engine's own scrapes.
    return this.trackManualOp(() =>
      this.activity.with('manual-read', () => this.readFollowersHeld(target)),
    );
  }

  private async readFollowersHeld(target: string): Promise<ReadFollowersResult> {
    const graph = await this.builtGraph();
    if (graph === null) {
      logger.warn('foundation.readFollowers: not logged in, skipping', { target });
      return { target, observed: 0, ok: false, reason: 'not-logged-in' };
    }
    // R3: refuse manual reads while another driver runs — a second
    // concurrent `collect()` subscription on the shared tab's onResponse stream
    // would let one target ingest another's follower pages (corrupt edges).
    const busy = this.busyDriverReason();
    if (busy !== null) {
      logger.warn('foundation.readFollowers: driver active, refusing manual read', {
        target,
        reason: busy,
      });
      return { target, observed: 0, ok: false, reason: busy };
    }
    this.manualDriving = true;
    try {
      const { observed } = await graph.acquisition.acquire(target);
      return { target, observed, ok: true };
    } catch (e) {
      logger.error('foundation.readFollowers: failed', { target, error: String(e) });
      return { target, observed: 0, ok: false, reason: String(e) };
    } finally {
      this.manualDriving = false;
      this.resumeDesiredRun();
    }
  }

  /** Follow one account via the shared rim `ChurnActions`. */
  async followOne(username: string): Promise<ActionResult> {
    return this.act('follow', username);
  }

  /** Unfollow one account via the shared rim `ChurnActions`. */
  async unfollowOne(username: string): Promise<ActionResult> {
    return this.act('unfollow', username);
  }

  private async act(
    action: 'follow' | 'unfollow',
    username: string,
  ): Promise<ActionResult> {
    // Veil: a manual follow/unfollow is a paced navigation + click sequence.
    return this.trackManualOp(() =>
      this.activity.with('manual-action', () => this.actHeld(action, username)),
    );
  }

  private async actHeld(
    action: 'follow' | 'unfollow',
    username: string,
  ): Promise<ActionResult> {
    const graph = await this.builtGraph();
    if (graph === null) {
      logger.warn('foundation.act: not logged in, skipping', { action, username });
      return { ok: false, username, reason: 'not-logged-in' };
    }

    // R3: refuse manual actions while another driver runs — sharing the tab
    // would race that driver's own navigations/actions on one WebContents.
    const busy = this.busyDriverReason();
    if (busy !== null) {
      logger.warn('foundation.act: driver active, refusing manual action', {
        action,
        username,
        reason: busy,
      });
      return { ok: false, username, reason: busy };
    }

    // R3: manual actions obey the SAME durable hard ceiling the engine does — they
    // can never push the day past the uncrossable cap.
    if (graph.rate.atHardCeiling()) {
      logger.warn('foundation.act: at daily hard ceiling, refusing manual action', {
        action,
        username,
      });
      return { ok: false, username, reason: 'daily-hard-ceiling' };
    }

    this.manualDriving = true;
    try {
      const token = this.runtime.token();
      if (!await this.prepareMutation(graph)) return { ok: false, username, reason: 'reconciliation-incomplete' };
      let accountPk = graph.store.pkByUsername(username);
      if (accountPk === null) {
        accountPk = await graph.resolveIdentity(username);
        if (accountPk === null) return { ok: false, username, reason: 'target-identity-unavailable' };
      }
      if (!this.runtime.current(token) || !this.runtime.ready() || this.graph !== graph || !(await this.validateIdentity())) {
        return { ok: false, username, reason: 'runtime-not-ready' };
      }
      const outcome = await journaledMutation({
        store: graph.store, clock: graph.clock, ownPk: graph.ownPk, actions: graph.churnActions,
        action, username, accountPk, channel: 'manual',
      });
      if (outcome.status === 'ok' && !outcome.alreadyInState) graph.noteMutation();
      return outcome.status === 'ok' || outcome.status === 'simulated'
        ? { ok: true, username }
        : { ok: false, username, reason: outcome.status === 'blocked' ? 'blocked' : 'action-failed' };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      logger.error('foundation.act: failed', { action, username, error: reason });
      return { ok: false, username, reason };
    } finally {
      this.manualDriving = false;
      this.resumeDesiredRun();
    }
  }

  /**
   * True while the built engine may still be driving the tab (R3 serialization
   * gate) — running, OR paused with a step still mid-flight (`pause()` returns
   * before the in-flight step ends; only the pause gate proves quiescence).
   */
  private isEngineDriving(): boolean {
    return this.graph?.engine.isDrivingTab() === true;
  }

  /**
   * Why a MANUAL op may not touch the tab now (R3): the growth loop is (or may
   * still be) driving it, or the prune routine holds the driver token. Null
   * when the tab is free.
   */
  private busyDriverReason(): string | null {
    if (!this.runtime.ready()) return 'runtime-not-ready';
    if (!this.lastOnline) return 'offline';
    if (this.manualDriving) return 'manual-running';
    if (this.isEngineDriving()) return 'engine-running';
    if (this.lease.owner() === 'prune') return 'prune-running';
    return null;
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  /** Engine status when built; a minimal idle status otherwise. */
  async status(): Promise<EpoStatus> {
    if (this.graph) return this.builtStatus();
    return this.notBuiltStatus(await this.isLoggedIn());
  }

  /**
   * Connectivity update from the main-process ConnectivityMonitor. When the graph
   * is built this delegates to the Engine, whose `onStatus` wiring (see
   * {@link build}) pushes the fresh projection to the renderer — no manual push
   * here, or the renderer would see it twice. Before the graph exists there is no
   * Engine to emit, so push one not-built status manually.
   */
  setConnectivity(online: boolean): void {
    this.lastOnline = online;
    if (this.graph !== null) {
      this.graph.engine.setOnline(online);
      return;
    }
    void this.status()
      .then((s) => this.projections.send('status', s))
      .catch((e: unknown) => {
        logger.error('foundation.setConnectivity: status push failed', { error: String(e) });
      });
  }

  /** Hold self-starting work until the first-launch tour is complete. */
  tourPending(): boolean {
    return this.resolveSettings().tourCompletedAt === null;
  }

  /** Pause growth during the tour; return only a pause that the tour itself owns. */
  setTourHold(held: boolean): void {
    if (!this.lease.setTourHeld(held)) return;
    logger.info('foundation: tour hold', { held });
    if (held) {
      this.lease.pauseGrowthFor('tour', this.graph?.engine ?? null);
      return;
    }
    // Release: restore the pre-tour state first, then run what was deferred.
    this.lease.returnToGrowth('tour', this.graph?.engine ?? null);
    if (this.lease.takeDeferredProfileLanding()) {
      void this.landOnOwnProfile();
    }
    // A scheduled prune that came due during the hold runs now, not one
    // watcher interval later (docs/PRINCIPLES.md §3 — schedules are durable).
    void this.maybeRunScheduledPrune();
  }

  /** Stop and drain all drivers before closing their store. Idempotent. */
  async dispose(): Promise<void> {
    this.session.beginDispose();
    // Drop the mutation→push machinery on the FIRST line of shutdown, exactly
    // as the old `if (this.disposing) return` guard inside the throttle did:
    // a write from a draining op must not schedule a push into the teardown.
    this.projections.unbind();
    this.disposeAbort.abort();
    this.scheduler.dispose();
    await this.teardownGraph();
    this.projections.dispose();
    logger.info('foundation disposed');
  }

  runtimeSnapshot(): RuntimeSnapshot { return this.runtime.snapshot(); }

  stopForIncident(reason: string): void {
    this.blockRuntime(reason);
    this.lease.forgetHandoffs();
    this.preparation?.abort();
    this.prune.cancelPending();
    this.graph?.engine.stop();
    this.graph?.pruneEngine.stop();
  }

  private blockRuntime(reason: string, detail?: string): void {
    this.runtime.block(reason, detail);
    this.projections.send('status', this.graph === null ? this.notBuiltStatus(false) : this.builtStatus());
  }


  /** Called only for a deliberate Quit/close. A process crash never reaches
   * this seam, so its durable running intent can be reconciled at next launch. */
  shutdownRuntime(): void {
    this.runtime.command('stopped');
    this.lease.forgetHandoffs();
    this.runtime.record('intentional-shutdown');
  }

  /** Resume a running intent a crash left behind (see {@link resumeStep}). */
  restoreRuntimeIntent(): Promise<void> { return runStep(this.resume, this.disposeAbort.signal); }

  /** Passive identity admission avoids tearing down a graph from inside its
   * own engine await. The next explicit build performs the bounded teardown. */
  async validateIdentity(): Promise<boolean> {
    const graph = this.graph;
    if (graph === null || this.disposing || !this.runtime.ready()) return false;
    const pk = await this.igSession.readCookie('ds_user_id');
    if (this.graph !== graph || !this.runtime.ready()) return false;
    if (pk === graph.ownPk) return true;
    this.blockRuntime(pk === null ? 'login-required' : 'account-changed');
    this.lease.forgetHandoffs();
    graph.engine.stop();
    graph.pruneEngine.stop();
    return false;
  }

  /** One durable repair budget and one flight for engine, watchdog and wake. */
  async recoverTab(reason: string): Promise<void> {
    if (this.disposing || this.runtime.snapshot().phase === 'suspended') throw new Error('runtime-not-ready');
    try {
      await this.runtime.repair(reason, async () => {
        if (typeof this.tab.recoverTab === 'function') await this.tab.recoverTab();
      });
    } catch (error) {
      if (this.runtime.snapshot().blockedReason !== null) {
        this.graph?.engine.stop();
        this.graph?.pruneEngine.stop();
      }
      throw error;
    }
  }

  /** Durable maintenance gets a bounded handoff from continuous growth. */
  startScheduledPruneWatcher(intervalMs?: number): void { this.pruneSchedule.startScheduledPruneWatcher(intervalMs); }

  /** Observe useful progress; intentional waits and offline periods are exempt. */
  startEngineStepWatchdog(intervalMs = RECOVERY.STEP_WATCHDOG_CHECK_MS): void {
    this.scheduler.every(
      'engine:step-watchdog',
      intervalMs,
      () => this.checkEngineStepWatchdog(),
      { unref: true },
    );
  }

  /** The scheduler drops ticks while the serialized repair is in flight. */
  private checkEngineStepWatchdog(): void | Promise<void> {
    const graph = this.graph;
    if (graph === null || this.disposing || this.tearingDown || !this.runtime.ready()) return;
    const shouldFire = stepWatchdogShouldFire({
      engineState: graph.engine.status().state,
      now: graph.clock.now(),
      lastActivityAt: this.runtime.snapshot().lastProgressAt,
      staleAfterMs: RECOVERY.STEP_WATCHDOG_MS,
      pendingDelayKeys: graph.delays.pending().map((p) => p.key),
      online: this.lastOnline,
    });
    if (!shouldFire) return;
    return this.recoverWedgedEngine();
  }

  /** Revoke the old run, repair once, and resume only unchanged user intent. */
  private async recoverWedgedEngine(): Promise<void> {
    const graph = this.graph;
    if (graph === null || this.disposing) return;
    const token = this.runtime.token();
    const restart = graph.engine.status().state === 'running';
    logger.error('foundation: step watchdog fired — engine silent past the stale window with no pending wait; recovering', {
      staleAfterMs: RECOVERY.STEP_WATCHDOG_MS,
      lastActivityAt: this.runtime.snapshot().lastProgressAt,
      now: graph.clock.now(),
    });
    graph.engine.stop();
    // The wedged run still holds the driver token; release it so the restart
    // below is not refused. The stale loop's `.finally` cannot re-clear the
    // new run's token (generation guard).
    this.lease.release('growth');
    try {
      await this.recoverTab('step-watchdog');
    } catch (e) {
      this.blockRuntime('tab-recovery-failed', String(e));
      return;
    }
    if (this.disposing || this.graph !== graph || !restart || !this.runtime.wantsRun(token)) return;
    // The recovery ladder keeps the full history: a watchdog-driven tab
    // recovery is a 'tab-unhealthy' note in its tally (a note, never a hold).
    this.graph.engine.noteExternalTabRecovery();
    const status = await this.startEngine({ automaticToken: token });
    logger.warn('foundation.stepWatchdog: engine restarted after recovery', {
      state: status.state,
    });
  }

  /** All renderer events use the coordinator; bursts share one repair. */
  private handleTabUnhealthy(reason: string): void {
    logger.error('foundation: tab reported unhealthy', { reason });
    if (this.disposing || this.tearingDown || this.lease.tourHeld() || !this.runtime.ready() || !this.lastOnline) {
      logger.warn('foundation: tab health event not acted on (teardown/hold/sleep in progress)', {
        reason,
      });
      return;
    }
    if (this.tabEventRecoveryInFlight) {
      logger.warn('foundation: tab health event coalesced into in-flight recovery', { reason });
      return;
    }
    const now = Date.now();
    if (now - this.lastTabEventRecoveryAt < RECOVERY.TAB_EVENT_DEBOUNCE_MS) {
      logger.warn('foundation: tab health event debounced (recent recovery attempt)', {
        reason,
        sinceLastMs: now - this.lastTabEventRecoveryAt,
        debounceMs: RECOVERY.TAB_EVENT_DEBOUNCE_MS,
      });
      return;
    }
    this.lastTabEventRecoveryAt = now;
    this.tabEventRecoveryInFlight = true;
    void this.recoverAfterTabEvent(reason).catch((error: unknown) => {
      logger.error('foundation: health-event recovery failed', { error: String(error) });
    }).finally(() => {
      this.tabEventRecoveryInFlight = false;
    });
  }

  /** The bounded recover-then-note body of {@link handleTabUnhealthy}. */
  private async recoverAfterTabEvent(reason: string): Promise<void> {
    logger.warn('foundation: recovering tab after health event', { reason });
    const graph = this.graph;
    const token = this.runtime.token();
    const restart = graph?.engine.status().state === 'running';
    graph?.engine.stop();
    graph?.pruneEngine.stop();
    this.lease.forgetHandoffs();
    this.lease.release('growth');
    try { await this.recoverTab(reason); }
    catch (error) { this.blockRuntime('tab-recovery-failed', String(error)); return; }
    // Generation-safe (mirrors the watchdog path): the graph may have been
    // torn down or a dispose begun while the recovery ran — never touch a
    // stale engine. The ladder keeps the full history: this external recovery
    // is a 'tab-unhealthy' note in its tally (a note, never a hold).
    if (this.disposing || this.graph === null) return;
    this.graph.engine.noteExternalTabRecovery();
    if (restart && this.graph === graph && this.runtime.wantsRun(token)) {
      await this.startEngine({ automaticToken: token });
    }
  }

  // -------------------------------------------------------------------------
  // System sleep/resume (powerMonitor — wired by main, policy lives here)
  // -------------------------------------------------------------------------

  /** Freeze every driver synchronously; the coordinator preserves desired intent. */
  suspendForSleep(): void {
    if (this.disposing) return;
    this.runtime.suspend();
    this.lease.forgetHandoffs();
    const graph = this.graph;
    const state = graph?.engine.status().state ?? null;
    graph?.pruneEngine.stop();
    this.prune.cancelPending();
    logger.warn('foundation: system suspend — freezing', {
      engineState: state,
      activeDriver: this.lease.owner(),
      willResumeEngine: this.runtime.snapshot().desired === 'running',
    });
    if (graph !== null && (state === 'running' || (state === 'paused' && this.runtime.snapshot().desired === 'running'))) {
      graph.engine.stop();
      // The stopped run holds the driver token until its loop's in-flight step
      // settles (possibly seconds after wake) — release it now so the wake
      // sequence's restart is never refused. The stale loop's own settlement
      // is generation-guarded (mirrors {@link recoverWedgedEngine}).
      this.lease.release('growth');
    }
  }

  /** Reconcile the shared device before admitting work after wake. */
  async resumeFromSleep(opts: { settleMsOverride?: number } = {}): Promise<void> {
    if (this.disposing) return;
    if (this.resumeSequenceInFlight !== null) {
      await this.resumeSequenceInFlight;
      if (this.runtime.snapshot().phase === 'suspended') await this.resumeFromSleep(opts);
      return;
    }
    const sequence = this.reconcileWake(opts);
    this.resumeSequenceInFlight = sequence;
    try { await sequence; }
    finally { if (this.resumeSequenceInFlight === sequence) this.resumeSequenceInFlight = null; }
  }

  private async reconcileWake(opts: { settleMsOverride?: number }): Promise<void> {
    const token = this.runtime.beginWake();
    try {
      const restart = this.runtime.snapshot().desired === 'running';
      logger.warn('foundation: system resumed — running wake sequence', {
        restartEngine: restart,
      });
      const settleMs = opts.settleMsOverride ?? sample(referenceTempoSource().policy('pause.wake-settle'));
      await sleep(settleMs, this.disposeAbort.signal);
      if (this.disposing || this.runtime.snapshot().phase === 'suspended') return;
      this.requestConnectivityCheck?.();

      if (typeof this.tab.checkHealth === 'function') {
        const health = await this.tab.checkHealth();
        if (this.disposing || this.runtime.snapshot().phase === 'suspended') return;
        if (!health.healthy && typeof this.tab.recoverTab === 'function') {
          logger.warn('foundation: post-wake tab unhealthy, recovering', { health });
          try {
            await this.recoverTab('system-resume');
            // Same tally note as every other external tab recovery.
            if (!this.disposing && this.graph !== null) {
              this.graph.engine.noteExternalTabRecovery();
            }
          } catch (e) {
            logger.error('foundation: post-wake tab recovery failed', { error: String(e) });
            if (!this.disposing && this.runtime.snapshot().phase !== 'suspended') this.blockRuntime('wake-recovery-failed', String(e));
          }
        }
      }
      if (this.disposing || this.runtime.snapshot().phase === 'suspended') return;

      const graph = this.graph;
      if (graph !== null) {
        try {
          const sentinel = await graph.sentinel.check();
          if (sentinel !== 'ok') {
            logger.warn('foundation: post-wake sentinel not clear', { sentinel });
            this.blockRuntime(`sentinel:${sentinel}`);
          }
        } catch (e) {
          logger.warn('foundation: post-wake sentinel check failed', { error: String(e) });
          if (!this.disposing && this.runtime.snapshot().phase !== 'suspended') this.blockRuntime('wake-sentinel-failed', String(e));
        }
      }

      this.runtime.finishWake(token);
      if (
        restart &&
        this.runtime.wantsRun(token) &&
        !this.disposing &&
        !this.lease.tourHeld() &&
        this.lease.owner() === null &&
        this.graph !== null &&
        this.graph.engine.status().state === 'idle'
      ) {
        logger.info('foundation: restarting growth engine after system resume');
        await this.startEngine({ automaticToken: token });
      }
    } catch (error) {
      if (!this.disposing && this.runtime.snapshot().phase !== 'suspended') this.blockRuntime('wake-reconciliation-failed', String(error));
    } finally {
      this.runtime.finishWake(token);
    }
  }

  /**
   * The halt-time diagnostic bundle (recovery-terminal halts): input probe,
   * tab canary, and the recovery ladder's failure-kind tally — logged at error
   * level so the halt log states decisively which layer failed. Best-effort;
   * never throws.
   */
  private async runHaltDiagnostics(reason: string): Promise<void> {
    try {
      const recovery = this.graph?.engine.recoverySnapshot() ?? null;
      const inputOk =
        typeof this.tab.probeInput === 'function' ? await this.tab.probeInput() : null;
      const canary =
        typeof this.tab.checkHealth === 'function' ? await this.tab.checkHealth() : null;
      logger.error('foundation: halt diagnostics', {
        reason,
        inputProbe: inputOk,
        canary,
        recovery,
      });
      if (inputOk === false) {
        logger.error(
          'foundation: input probe FAILED — dispatched events are NOT reaching the page',
        );
      } else if (inputOk === true) {
        logger.warn(
          'foundation: input probe OK — events reach the page; the failure is at the page/service layer',
        );
      }
    } catch (e) {
      logger.warn('foundation: halt diagnostics errored', { error: String(e) });
    }
  }

  /** One scheduled-prune check (see {@link PruneSchedule.maybeRunScheduledPrune}). */
  private maybeRunScheduledPrune(): Promise<void> { return this.pruneSchedule.maybeRunScheduledPrune(); }

  /** Drain manual operations before closing their store; disposal aborts their waits. */
  private async drainManualOps(): Promise<void> {
    if (this.inFlightManualOps.size === 0) return;
    logger.info('foundation.teardownGraph: waiting for in-flight manual ops', {
      count: this.inFlightManualOps.size,
    });
    const drained = await withTimeout(
      Promise.allSettled([...this.inFlightManualOps]),
      SCHEDULER.MANUAL_OP_DRAIN_TIMEOUT_MS,
    );
    if (drained === TIMED_OUT) {
      logger.warn('foundation.teardownGraph: manual ops did not drain in time');
    }
  }

  /** Tear down the current graph, if any (see {@link GraphSession.teardown}). */
  private async teardownGraph(): Promise<void> {
    return this.session.teardown();
  }

  // -------------------------------------------------------------------------
  // Graph construction — delegated to `services/graph-builder.ts`.
  // -------------------------------------------------------------------------

  /** Assemble the dependency graph for one identity (see {@link buildGraph}). */
  private build(ownPk: string, ownUsername: string | undefined): BuiltGraph {
    return buildGraph(ownPk, ownUsername, { ...this.graphBuildDeps(), dbFile: this.runtime.bindAccount(ownPk) });
  }

  private graphBuildDeps(): GraphBuildDeps {
    return {
      tab: this.tab,
      userDataDir: this.userDataDir,
      dbFile: IG_DB_FILE,
      reporter: this.reporter,
      cursorObserver: this.cursorObserver,
      scheduler: this.scheduler,
      settings: this.resolveSettings(),
      resolveSettings: () => this.resolveSettings(),
      updateSettings: (partial) => {
        void this.updateSettings(partial);
      },
      driverSignal: () => this.driverSignal(),
      recoverTab: (reason) => this.recoverTab(reason),
      validateIdentity: () => this.validateIdentity(),
      onProgress: (phase) => this.runtime.progress(phase),
      onStatus: (s) => this.emit(s),
      onPruneStatus: (s) => this.projections.send('pruneStatus', s),
      onHalt: (reason) => {
        this.blockRuntime(reason);
        logger.warn('foundation: engine halted', { reason });
        // Recovery-terminal triage, run ONCE per halt: input probe + tab canary
        // + the ladder's classification tally, at error level — the halt log
        // states decisively which layer failed.
        if (
          reason === 'actions-failing' ||
          reason === 'recovery-exhausted' ||
          reason === 'adapter-drift'
        ) {
          void this.runHaltDiagnostics(reason);
        }
      },
    };
  }

  /** Every operation observes both its run token and device suspension. */
  private driverSignal(): AbortSignal | undefined {
    if (this.disposing) return this.disposeAbort.signal;
    if (this.preparation !== null) return this.signals.get(this.preparation.signal, this.runtime.signal());
    const signal = this.lease.owner() === 'prune' ? this.graph?.pruneEngine.runSignal()
      : this.lease.owner() === 'growth' ? this.graph?.engine.runSignal() : undefined;
    return this.signals.get(signal, this.runtime.signal());
  }

  // -------------------------------------------------------------------------
  // Read-only list projections + settings (§5) — pure store reads.
  // -------------------------------------------------------------------------

  /**
   * The chain lineage: every target with its username and computed yield. Builds
   * the graph if needed; returns `[]` when not logged in (nothing to read yet).
   * Never throws across IPC — a failed read logs and returns `[]`.
   */
  async chainList(): Promise<ChainTargetView[]> {
    const graph = await this.builtGraph();
    if (graph === null) return [];
    return this.shapedChainList(graph);
  }

  /**
   * The chain projection shaped for both delivery paths (the `chain:list` pull
   * and the mutation-driven push). Never throws — a failed read logs loudly
   * (no silent catch) and returns `[]` so neither path takes down its caller.
   */
  private shapedChainList(graph: BuiltGraph): ChainTargetView[] {
    try {
      return shapeChainList(graph.store, graph.ownPk);
    } catch (e) {
      logger.error('foundation.chainList: failed', { error: String(e) });
      return [];
    }
  }

  /**
   * The Targets console's detail projection for one chain target (funnel,
   * audience framing, runway, conversion). Builds the graph if needed; null
   * when not logged in or when `targetPk` is not a chain target. Never throws
   * across IPC. Liveness rides the chain-list push: the renderer re-invokes
   * this whenever a `chainList` push arrives — that push IS the throttled
   * store-mutation tick (§2), so the detail moves DURING acquisition walks
   * where no status counter changes.
   */
  async chainDetail(targetPk: string): Promise<ChainTargetDetail | null> {
    const graph = await this.builtGraph();
    if (graph === null) return null;
    try {
      return shapeTargetDetail(graph.store, graph.ownPk, targetPk, {
        now: graph.clock.now(),
        plannedToday: graph.rate.plannedToday(),
      });
    } catch (e) {
      logger.error('foundation.chainDetail: failed', { error: String(e) });
      return null;
    }
  }

  /**
   * Cumulative net own-follower growth per day for the last `days` days
   * (default 14 when omitted or invalid — the IPC boundary is untyped), plus
   * the followers-measurement baseline the renderer's window/momentum honesty
   * gates read. Builds the graph if needed; empty read when not logged in.
   * Never throws.
   */
  async growthSeries(days?: number): Promise<GrowthSeriesRead> {
    const graph = await this.builtGraph();
    if (graph === null) return { points: [], baselineAt: null };
    const d = typeof days === 'number' && Number.isFinite(days) && days >= 1 ? Math.floor(days) : 14;
    try {
      return {
        points: graph.store.netGrowthSeries(d, graph.ownPk),
        baselineAt: graph.store.followersBaselineAt(),
      };
    } catch (e) {
      logger.error('foundation.growthSeries: failed', { error: String(e) });
      return { points: [], baselineAt: null };
    }
  }

  /** The seed precheck: one sentinel-gated profile visit (see {@link SeedCheckService}). */
  checkSeed(username: string): Promise<SeedCheck> { return this.seed.checkSeed(username); }

  /**
   * A capped page of follow_records in one lifecycle state, joined to accounts.
   * Empty (and untruncated) when not logged in. Never throws across IPC.
   */
  async queueList(state: FollowState): Promise<QueueListResult> {
    const graph = await this.builtGraph();
    if (graph === null) {
      return { rows: [], truncated: false };
    }
    try {
      return shapeQueueList(graph.store, state);
    } catch (e) {
      logger.error('foundation.queueList: failed', { state, error: String(e) });
      return { rows: [], truncated: false };
    }
  }

  /**
   * The whole knowledge graph shaped for the Graph view (§2 — the view refetches
   * on the mutation-driven status pushes, so its canvas ticks live during scans
   * and sweeps). Null before login/build — there is nothing to draw. Never
   * throws across IPC.
   */
  async graphSnapshot(): Promise<GraphSnapshot | null> {
    const graph = await this.builtGraph();
    if (graph === null) return null;
    try {
      const settings = this.resolveSettings();
      return shapeGraphSnapshot(graph.store.graphSnapshotRows(), {
        now: graph.clock.now(),
        followbackWaitMs: settings.maxWaitForFollowbackDays * MS_PER_DAY,
      });
    } catch (e) {
      logger.error('foundation.graphSnapshot: failed', { error: String(e) });
      return null;
    }
  }

  /** The persisted settings (loaded lazily and cached; defaults on any failure). */
  getSettings(): Promise<Settings> { return this.settings.getSettings(); }

  /** Reset every setting to its default (see {@link SettingsService.resetSettings}). */
  resetSettings(): Promise<Settings> { return this.settings.resetSettings(); }

  /**
   * Wipe everything EXCEPT settings: tear down the graph, delete the knowledge DB
   * (including WAL/SHM sidecars), and clear the persisted IG session (a logout).
   * The tab is sent back to the Instagram home page so the user can log in again;
   * the next login lazily rebuilds a fresh graph over a brand-new DB.
   */
  async clearData(): Promise<EpoStatus> {
    this.runtime.command('stopped');
    this.blockRuntime('data-clear-in-progress');
    this.lease.forgetHandoffs();
    // Guard the ENTIRE wipe: an in-flight build must not resurrect a graph over
    // the just-deleted path (its `buildResolved` aborts under this flag), and a
    // polled read must not start a fresh build between the teardown and the rm.
    const restoreTearingDown = this.session.beginTearingDown();
    try {
      // A build already past the ensureBuilt gate keeps running on the OLD
      // identity — let it settle first so the teardown below tears down whatever
      // it produced instead of racing it.
      await this.session.settleBuild();
      await this.teardownGraph();

      const databaseFiles = fs.readdirSync(this.userDataDir).filter((name) => /^epo(?:-account-[^/]+)?\.db(?:-wal|-shm)?$/.test(name));
      for (const name of databaseFiles) {
        const file = path.join(this.userDataDir, name);
        try {
          fs.rmSync(file, { force: true });
        } catch (e) {
          logger.error('foundation.clearData: failed to remove db file', {
            file,
            error: String(e),
          });
        }
      }

      try {
        await this.igSession.clear();
      } catch (e) {
        logger.error('foundation.clearData: failed to clear IG session', { error: String(e) });
      }
    } finally {
      restoreTearingDown();
    }

    // Forget the cached identity + any in-flight build; `disposing` stays false so
    // the next login can rebuild.
    this.session.forgetIdentity();
    this.runtime.resetData();

    void this.tab.goto(IG_HOME_URL);

    const s = await this.status();
    this.projections.send('status', s);
    logger.info('foundation: data cleared (db + IG session)');
    return s;
  }

  /** Merge, persist and live-reload a settings partial (see {@link SettingsService.updateSettings}). */
  updateSettings(partial: Partial<Settings>): Promise<Settings> { return this.settings.updateSettings(partial); }

  /** The cached settings, loaded once from disk (see {@link SettingsService.resolveSettings}). */
  private resolveSettings(): Settings { return this.settings.resolveSettings(); }

  // -------------------------------------------------------------------------
  // Status projection helpers
  // -------------------------------------------------------------------------

  private emit(status: EngineStatus): void {
    // Status is observability, not evidence of useful progress. The watchdog
    // reads the coordinator's explicit observation/effect progress seam.
    // Veil state machine: the growth loop holds the veil exactly while RUNNING
    // (paused/idle/halted release it — a parked engine issues no requests). The
    // signal is level-triggered, then the start bridge retires on the first
    // emit — in that order, so the hand-off never dips the veil.
    this.activity.signal('growth-loop', status.state === 'running');
    this.releaseGrowthStartBridge();
    this.projections.send('status', composeStatus({ ...status, loggedIn: this.graph !== null, runtime: this.runtimeSnapshot() }, [], this.graph, Date.now()));
  }

  /** Retire the `growth-start` bridge hold (idempotent; see {@link startEngine}). */
  private releaseGrowthStartBridge(): void {
    if (this.lease.endGrowthStart()) this.activity.release('growth-start');
  }

  private builtStatus(): EpoStatus {
    // Only called when `this.graph` is set (post-build).
    const graph = this.graph;
    if (graph === null) return this.notBuiltStatus(true);
    return composeStatus({ ...graph.engine.status(), loggedIn: true, runtime: this.runtimeSnapshot() }, [], graph, graph.clock.now());
  }

  private notBuiltPruneStatus(): PruneStatus {
    return notBuiltPruneStatus(this.resolveSettings());
  }

  private notBuiltStatus(loggedIn: boolean): EpoStatus {
    return { ...notBuiltStatus(loggedIn, this.lastOnline), runtime: this.runtimeSnapshot() };
  }
}
