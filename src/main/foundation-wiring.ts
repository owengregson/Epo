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
import { TabUnresponsiveError } from '@/adapter/errors';
import {
  resolveOwnUsername as resolveUsernameFromTab,
  usernameFromProfileUrl,
} from '@/adapter/identity';
import { IG_HOME_URL, type InstagramTab } from '@/adapter/tab';
import { createTabInteractor } from '@/adapter/tab-interactor';
import type { ChurnActionOutcome } from '@/engine/churn-scheduler';
import type { EngineStatus } from '@/engine/engine';
import { isRateLimitHaltKey } from '@/engine/halt-reason';
import { type PruneCandidate, type PruneStatus, pruneDue } from '@/engine/prune-engine';
import { SystemClock } from '@/governors/clock';
import type { CursorObserver } from '@/interaction/input-driver';
import {
  shapeChainList,
  shapeGraphSnapshot,
  shapeQueueList,
  shapeTargetDetail,
} from '@/main/foundation-reads';
import { notBuiltPruneStatus, notBuiltStatus } from '@/main/modules/not-built';
import { Projections, type PushFn } from '@/main/modules/projections';
import { GraphSession } from '@/main/modules/session';
import {
  type BuiltGraph,
  buildGraph,
  type GraphBuildDeps,
} from '@/main/services/graph-builder';
import type { IgSessionPort } from '@/main/services/ig-session';
import { TabLease } from '@/main/services/tab-lease';
import { TabActivity } from '@/main/tab-activity';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  type Settings,
  sanitizeSettings,
  saveSettings,
  toChainConfig,
  toChurnConfig,
  toFollowbackConfig,
  toPacingConfig,
  toPruneConfig,
  toRateGovernorConfig,
  toScannerConfig,
  toScorerConfig,
} from '@/settings/settings';
import { ADAPTER, NOISE, PRUNE, RECOVERY, SCHEDULER, TAB } from '@/timing/config';
import { pauseBeforePageRetry } from '@/timing/page-pacing';
import { sample, sleep, TIMED_OUT, uniform, withTimeout } from '@/timing/primitives';
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
const IG_SETTINGS_FILE = 'epo-settings.json';

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

  /**
   * Bumped by every {@link stopPrune}. A prune scan/run request that was
   * waiting on the lazy graph build compares this to the value it captured at
   * entry — a mismatch means the user pressed Stop while the build was in
   * flight, and the pending scan/run cancels instead of starting anyway.
   */
  private pruneStopEpoch = 0;
  /** Settings cached once loaded, so `getSettings`/`updateSettings` share one copy. */
  private settingsCache: Settings | null = null;
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
  /**
   * Epoch ms of the most recent growth-engine status emission (plus a baseline
   * stamp at each start). The step watchdog reads this: a 'running' engine that
   * has emitted nothing for `RECOVERY.STEP_WATCHDOG_MS` while holding no
   * pending `engine:` wait is wedged on a dead tab await, not parked.
   */
  private lastEngineActivityAt = 0;
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
  /**
   * True from the OS 'suspend' event until the post-'resume' wake sequence
   * completes. While set, tab health events are NOT acted on — the sleep
   * transition itself tears renderers down, and the wake sequence re-validates
   * connectivity, tab health, and the sentinel in order anyway.
   */
  private suspendedForSleep = false;
  /**
   * The growth engine was RUNNING when the system suspended, so the wake
   * sequence must restart it (a user's own pause/stop/halt is never undone —
   * same contract as the prune/tour hand-offs).
   */
  private resumeEngineAfterSleep = false;
  /** Re-entrancy latch for the ordered post-wake sequence (double 'resume'). */
  private resumeSequenceInFlight = false;

  constructor(deps: FoundationDeps) {
    this.tab = deps.tab;
    this.userDataDir = deps.userDataDir;
    this.igSession = deps.igSession;
    this.cursorObserver = deps.cursorObserver;
    this.reporter = deps.activityReporter ?? NOOP_ACTIVITY_REPORTER;
    this.requestConnectivityCheck = deps.requestConnectivityCheck;
    this.projections = new Projections({ push: deps.push });
    this.session = new GraphSession({
      igSession: deps.igSession,
      build: (ownPk, ownUsername) => this.build(ownPk, ownUsername),
      resolveUsername: () => this.resolveOwnUsername(),
      withBuildHold: (run) => this.activity.with('build', run),
      tourHeld: () => this.lease.tourHeld(),
      drainManualOps: () => this.drainManualOps(),
    });
    // The kernel binding rule (ADR 1007): everything declared over the session
    // is wired on OPEN and unwired on CLOSE — no `if (graph === null)` anywhere
    // in the wiring, and no way for a subscription to outlive its store.
    this.session.session.onOpen((graph) => {
      this.projections.bind(graph.store, {
        status: () => this.builtStatus(),
        pruneStatus: () => graph.pruneEngine.status(),
        chainList: () => this.shapedChainList(graph),
      });
    });
    this.session.session.onClose(() => {
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
   * Build the dependency graph exactly once, after login (see
   * `src/main/modules/session.ts`, which owns the memoized in-flight build,
   * the degraded-username backoff and the teardown guards).
   */
  async ensureBuilt(): Promise<boolean> {
    return this.session.ensureBuilt();
  }

  /**
   * The not-built guard copied across every IPC entry point, centralized:
   * ensure the graph is built and hand it back, or `null` (each caller returns
   * its own safe empty). Callers hold the RETURNED graph — never re-read
   * `this.graph` after an await, where a concurrent teardown can null it.
   */
  private async builtGraph(): Promise<BuiltGraph | null> {
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

  /**
   * Land the tab on the user's OWN profile — the app's default page. Waits for
   * the lazy graph (i.e. a logged-in session) within a bounded poll, then runs
   * as a proper tracked activity: the Actor locates the nav profile-avatar
   * link and the Interactor moves the cursor to it and clicks with native
   * input events (an in-page `a.click()` is ignored by the SPA — verified
   * live), retrying once. Fire-and-forget from startup/login; every failure
   * mode resolves quietly (a cosmetic landing must never break startup).
   */
  async landOnOwnProfile(): Promise<void> {
    // Intro tour on screen: the landing (a build + a cursor-driven click) is
    // exactly the kind of self-starting work the hold parks. Remember it was
    // requested; setTourHold(false) runs it.
    if (this.lease.tourHeld()) {
      this.lease.deferProfileLanding();
      return;
    }
    // Bounded graph retry; builds may navigate, so space each attempt afresh.
    for (let i = 0; i < ADAPTER.PROFILE_LAND_ATTEMPTS; i++) {
      if (this.disposing) return;
      if (await this.ensureBuilt()) break;
      if (i === ADAPTER.PROFILE_LAND_ATTEMPTS - 1) {
        logger.info('foundation: not logged in, profile landing skipped');
        return;
      }
      await pauseBeforePageRetry(ADAPTER.PROFILE_LAND_RETRY_MS, this.disposeAbort.signal);
    }
    const graph = this.graph;
    if (graph === null || this.disposing) return;
    // Never contend with an active driver for the tab.
    if (this.lease.owner() !== null) return;

    const target = graph.ownUsername ?? null;
    const onProfile = (): boolean => {
      const u = usernameFromProfileUrl(this.tab.currentUrl());
      return u !== null && (target === null || u === target);
    };
    if (onProfile()) return;

    await this.activity.with('open-profile', async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (this.disposing || this.lease.owner() !== null) return;
        let clicked = false;
        try {
          clicked = await graph.actor.clickOwnProfileLink();
        } catch (e) {
          // The rail link navigates IN-PAGE: the route change can start before
          // the release is acknowledged, which the input queue reports as
          // post-click UNCERTAINTY (live 2026-10-08). The URL decides, as for
          // any click; every other failure ends the landing.
          if (!(e instanceof TabUnresponsiveError && e.phase === 'post-click')) {
            logger.warn('foundation: profile landing click failed', { error: String(e) });
            return;
          }
          clicked = true;
        }
        if (clicked) {
          for (let i = 0; i < ADAPTER.NAV_SETTLE_ROUNDS; i++) {
            await sleep(ADAPTER.NAV_SETTLE_MS, this.disposeAbort.signal);
            if (onProfile()) {
              logger.info('foundation: landed on own profile', { username: target });
              return;
            }
          }
          logger.warn('foundation: profile click did not navigate, retrying', { attempt });
        }
        // The URL poll stays exact; only another page attempt gets a fresh beat.
        if (attempt === 0) await pauseBeforePageRetry(ADAPTER.PROFILE_LAND_RETRY_MS, this.disposeAbort.signal);
      }
      logger.warn('foundation: could not land on own profile');
    });
  }

  // -------------------------------------------------------------------------
  // Engine controls (build-if-needed)
  // -------------------------------------------------------------------------

  /** Start the engine loop — fire-and-forget (never awaits the loop). */
  async startEngine(): Promise<EpoStatus> {
    const graph = await this.builtGraph();
    if (graph === null) return this.notBuiltStatus(await this.isLoggedIn());
    const refusal = this.refuseIfPruneActive('startEngine');
    if (refusal !== null) return refusal;
    const state = graph.engine.status().state;
    if (state === 'running' || state === 'paused') {
      // Already the active driver — a second start is the Engine's own no-op.
      return this.builtStatus();
    }
    this.lease.claim('growth');
    // Watchdog baseline: a fresh run starts with a full stale window, even
    // when the very first step wedges before any status emit lands.
    this.lastEngineActivityAt = graph.clock.now();
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
    const graph = await this.builtGraph();
    if (graph === null) return this.notBuiltStatus(await this.isLoggedIn());
    graph.engine.pause();
    return this.builtStatus();
  }

  /** Resume a paused engine. */
  async resumeEngine(): Promise<EpoStatus> {
    const graph = await this.builtGraph();
    if (graph === null) return this.notBuiltStatus(await this.isLoggedIn());
    // A prune holds the tab — resuming growth now would put a second driver on
    // it. Refuse; the prune's completion resumes growth itself when it was the
    // one that paused it (leave-alone otherwise).
    const refusal = this.refuseIfPruneActive('resumeEngine');
    if (refusal !== null) return refusal;
    graph.engine.resume();
    return this.builtStatus();
  }

  /** Stop the engine loop (aborts in-flight sleeps). */
  async stopEngine(): Promise<EpoStatus> {
    const graph = await this.builtGraph();
    if (graph === null) return this.notBuiltStatus(await this.isLoggedIn());
    graph.engine.stop();
    return this.builtStatus();
  }

  /**
   * Restart the chain from `seed`, explicitly: stop the loop and await its
   * exit, persist the seed (no renderer debounce race — the old flow started
   * the engine before the seed's autosave landed, so it ran the PREVIOUS
   * seed), retire every active target, re-activate the seed at the chain's
   * next index when it is already known, and start. This is the ONE sanctioned
   * way to re-run an exhausted seed — the engine's own bootstrap deliberately
   * refuses to resurrect one.
   */
  async restartFromSeed(seed: string): Promise<EpoStatus> {
    const clean = seed.trim().replace(/^@/, '');
    if (clean === '') return { ...(await this.status()), refusal: 'seed-missing' };
    const graph = await this.builtGraph();
    if (graph === null) return this.notBuiltStatus(await this.isLoggedIn());
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
    // Scrap the current session: every active target is retired; queued
    // records against them stop refilling and the chain restarts fresh.
    for (const t of graph.store.listTargets()) {
      if (t.status === 'active') graph.store.setTargetStatus(t.accountPk, 'exhausted');
    }
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

  /**
   * READ-ONLY prune scan: scrape our following + followers lists and return the
   * candidate set (no unfollows). Holds the tab driver token for its duration so
   * neither the growth engine nor a second scan can drive the tab concurrently.
   * Never throws across IPC — refusals and failures are typed results.
   */
  /**
   * The PERSISTED scan's not-yet-visited candidates (raw census — the renderer
   * filters against the live whitelist), so the candidates list auto-populates
   * from saved data on app launch instead of sitting empty until a fresh scan.
   * Empty when not logged in or no snapshot exists. Never throws across IPC.
   */
  async pruneCandidates(): Promise<PruneCandidate[]> {
    const graph = await this.builtGraph();
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
    const graph = await this.builtGraph();
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
    this.lease.claim('prune');
    try {
      if (!(await this.acquireTabForPrune())) {
        return { ok: false, reason: 'growth-busy', ...empty };
      }
      const result = await graph.pruneEngine.scan();
      return { ok: true, ...result };
    } catch (e) {
      logger.error('foundation.scanPrune: failed', { error: String(e) });
      return { ok: false, reason: String(e), ...empty };
    } finally {
      this.lease.release('prune');
      this.releaseTabAfterPrune();
    }
  }

  /**
   * Start one auto-prune run — fire-and-forget (mirrors {@link startEngine}).
   * Refused with a typed reason while the growth engine is running or paused
   * (mutual exclusion) or while a prune scan/run is already active.
   */
  async startPrune(): Promise<PruneControlResult> {
    // Veil: held from IPC entry; on a successful launch the hold transfers to
    // the fire-and-forget run (released when the run settles), and every
    // refusal path releases it on the way out.
    this.activity.hold('prune-run');
    let transferredToRun = false;
    try {
      const epoch = this.pruneStopEpoch;
      const graph = await this.builtGraph();
      if (graph === null) {
        return { ok: false, reason: 'not-logged-in', status: this.notBuiltPruneStatus() };
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
      this.lease.claim('prune');
      // Borrow the tab BEFORE the run starts: pause a running growth engine and
      // await its park. Await here (not inside the fire-and-forget run) so the
      // caller's result reflects a clean hand-off; the UI's run spinner covers it.
      if (!(await this.acquireTabForPrune())) {
        this.lease.release('prune');
        return { ok: false, reason: 'growth-busy', status: graph.pruneEngine.status() };
      }
      const run = graph.pruneEngine
        .run()
        .catch((e: unknown) => {
          logger.error('foundation: prune run errored', { error: String(e) });
        })
        .finally(() => {
          this.lease.release('prune');
          // Resume growth iff this prune paused it — after the run fully settles.
          this.releaseTabAfterPrune();
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
    if (this.graph === null) return this.notBuiltPruneStatus();
    this.graph.pruneEngine.stop();
    return this.graph.pruneEngine.status();
  }

  /**
   * Pause an active prune run between unfollows. The run keeps every claim it
   * holds — the tab driver token and a growth pause it performed — so growth
   * stays excluded until the run is resumed and completes, or is stopped.
   */
  async pausePrune(): Promise<PruneStatus> {
    if (this.graph === null) return this.notBuiltPruneStatus();
    this.graph.pruneEngine.pause();
    return this.graph.pruneEngine.status();
  }

  /** Resume a paused prune run (the owed inter-action delay is served first). */
  async resumePrune(): Promise<PruneStatus> {
    if (this.graph === null) return this.notBuiltPruneStatus();
    this.graph.pruneEngine.resume();
    return this.graph.pruneEngine.status();
  }

  /** The prune status projection; a settings-seeded idle status before build. */
  async pruneStatus(): Promise<PruneStatus> {
    if (this.graph === null) return this.notBuiltPruneStatus();
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
  private pruneRefusalReason(): string | null {
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
    this.lease.returnToGrowth('prune', this.graph?.engine ?? null);
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
    void p.finally(() => this.inFlightManualOps.delete(p));
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
    try {
      const { observed } = await graph.acquisition.acquire(target);
      return { target, observed, ok: true };
    } catch (e) {
      logger.error('foundation.readFollowers: failed', { target, error: String(e) });
      return { target, observed: 0, ok: false, reason: String(e) };
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

    try {
      // R4: the rim returns a discriminated outcome (it does its own sentinel
      // gate + dry-run). R3: unlike the engine path, NO scheduler writes the ledger
      // for a manual op, so we record it here — otherwise the action would be
      // invisible to the governor and could silently exceed the ceiling.
      const outcome =
        action === 'follow'
          ? await graph.churnActions.follow(username)
          : await graph.churnActions.unfollow(username);
      return this.recordManualOutcome(graph, action, username, outcome);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      logger.error('foundation.act: failed', { action, username, error: reason });
      return { ok: false, username, reason };
    }
  }

  /**
   * Persist a manual action's outcome the SAME way {@link ChurnScheduler} does, so
   * the governor's daily count includes manual ops (R3):
   *
   *  - `'ok'` + `alreadyInState` → nothing was clicked (an external actor already
   *                    owns the state): NO ledger, NO edge — reconcile instead when
   *                    the pk is known (Phase A leave-alone) — success.
   *  - `'ok'`        → ledger `ok` (+ the directed `ownPk→pk` edge when the pk is
   *                    known); the manual result is a success.
   *  - `'simulated'` → dry-run: NO ledger row, NO edge (mirrors f12) — success.
   *  - `'blocked'`   → sentinel closed before any click: NO ledger — failure.
   *  - `'failed'`    → ledger `fail` — failure.
   *
   * The ledger is keyed on the numeric pk when known, else the username (the ceiling
   * reads the row COUNT, so the username fallback still gates correctly).
   */
  private recordManualOutcome(
    graph: BuiltGraph,
    action: 'follow' | 'unfollow',
    username: string,
    outcome: ChurnActionOutcome,
  ): ActionResult {
    const now = graph.clock.now();
    const pk = this.manualActionPk(username);
    const ledgerKey = pk ?? username;

    switch (outcome.status) {
      case 'ok':
        if (outcome.alreadyInState === true) {
          // Phase A: no click happened — do NOT record a phantom action/edge;
          // reconcile the observed truth instead (pk-keyed only; see the seam below).
          if (pk !== undefined) {
            graph.store.reconcileOwnFollow(pk, action === 'follow', now);
          }
          logger.info('foundation.act: manual action found already-in-state (external)', {
            action,
            username,
          });
          return { ok: true, username };
        }
        graph.store.recordAction(ledgerKey, action, 'ok', now);
        if (pk !== undefined) {
          graph.store.observeEdge(graph.ownPk, pk, 'follows', action === 'follow', now);
        }
        logger.info('foundation.act: manual action recorded', { action, username });
        return { ok: true, username };
      case 'simulated':
        logger.info('foundation.act: dry-run manual action simulated (no ledger/edge)', {
          action,
          username,
        });
        return { ok: true, username };
      case 'blocked':
        logger.warn('foundation.act: manual action blocked (sentinel), no ledger', {
          action,
          username,
        });
        return { ok: false, username, reason: 'blocked' };
      case 'failed':
        graph.store.recordAction(ledgerKey, action, 'fail', now);
        logger.warn('foundation.act: manual action failed (click unconfirmed)', {
          action,
          username,
        });
        return { ok: false, username, reason: 'action-failed' };
    }
  }

  /**
   * Best-effort numeric pk for a manually-actioned username, via the store's
   * reverse username→pk index. When the account has never been observed the pk
   * is unknown (`undefined`): the ledger falls back to the username key (still
   * counted by the ceiling) and no edge is written — but any account the app
   * has seen (scraped, enriched, queued) resolves, so a manual follow/unfollow
   * records the real `ownPk→pk` edge and the engine can never re-queue an
   * account the user just manually followed.
   */
  private manualActionPk(username: string): string | undefined {
    return this.graph?.store.pkByUsername(username) ?? undefined;
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

  /**
   * True while the persisted intro tour has never been completed — main parks
   * self-starting work at launch (via {@link setTourHold}) until the
   * renderer's tour closes and releases the hold over `tour:hold`.
   */
  tourPending(): boolean {
    return this.resolveSettings().tourCompletedAt === null;
  }

  /**
   * Park/unpark the app for the intro tour (`tour:hold`). While held, nothing
   * self-starts — the lazy graph build, the startup profile landing, and the
   * scheduled-prune watcher all wait — and a RUNNING growth engine is paused,
   * then resumed on release IFF this hold paused it (a user's own pause is
   * never undone; same contract as the prune hand-off). An active prune run
   * is deliberately left alone: it has no pause verb, and aborting it would
   * discard a partial census — replaying the tour mid-prune just runs over it.
   */
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

  /**
   * Close the engine + store on window teardown. Idempotent.
   *
   * f14 — ordering matters: stop the engine, AWAIT the loop's exit (so no step is
   * mid-flight), drop the request-metering subscription, then close the store. A
   * store call from a still-running step must never hit a closed DB.
   */
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

  /**
   * Begin the opt-in scheduled-prune watcher (Phase 5): every `intervalMs` it checks
   * whether a scheduled prune is due (per {@link pruneDue}) and auto-starts one when
   * it is ALSO safe — logged in, no active driver, the growth loop idle (not
   * running/paused), and inside active hours. Disabled by default
   * (`pruneScheduleDays === 0`). Idempotent; the timer is cleared on {@link dispose}.
   * Damage is bounded by the whitelist, the prune daily cap, and the sentinel.
   */
  startScheduledPruneWatcher(intervalMs = SCHEDULER.AUTO_PRUNE_CHECK_MS): void {
    // Idempotency + the never-hold-the-process-open unref both come from the
    // ScheduleManager (`every` is a per-key no-op while the loop lives).
    // `immediate` (docs/PRINCIPLES.md §3 — schedules are durable): work that
    // came due WHILE THE APP WAS CLOSED runs at launch, not one interval later
    // (the due-check reads the persisted `pruneLastRunAt`, and the safety
    // gates — logged in, tab free, active hours — still all apply).
    this.scheduler.every(
      'prune:auto-watcher',
      intervalMs,
      () => this.maybeRunScheduledPrune(),
      { unref: true, immediate: true },
    );
  }

  /**
   * Begin the engine step watchdog: every `intervalMs` it evaluates
   * {@link stepWatchdogShouldFire} against the live engine state, the last
   * status-emission timestamp, and the DelayManager's pending waits. A hit
   * means the loop is wedged on a never-settling tab/CDP await — the recovery
   * path stops the engine, reloads + re-attaches the tab, and restarts through
   * the same foundation path a manual Start uses. Idempotent; cleared on
   * {@link dispose}.
   */
  startEngineStepWatchdog(intervalMs = RECOVERY.STEP_WATCHDOG_CHECK_MS): void {
    this.scheduler.every(
      'engine:step-watchdog',
      intervalMs,
      () => this.checkEngineStepWatchdog(),
      { unref: true },
    );
  }

  /**
   * One watchdog evaluation; fires the recovery when the predicate says so.
   * Returns the recovery promise so the ScheduleManager's overlap guard drops
   * ticks that land while a recovery is still in flight.
   */
  private checkEngineStepWatchdog(): void | Promise<void> {
    const graph = this.graph;
    if (graph === null || this.disposing || this.tearingDown) return;
    const shouldFire = stepWatchdogShouldFire({
      engineState: graph.engine.status().state,
      now: graph.clock.now(),
      lastActivityAt: this.lastEngineActivityAt,
      staleAfterMs: RECOVERY.STEP_WATCHDOG_MS,
      pendingDelayKeys: graph.delays.pending().map((p) => p.key),
    });
    if (!shouldFire) return;
    return this.recoverWedgedEngine();
  }

  /**
   * Step-watchdog recovery: stop the wedged loop (its hung await cannot be
   * settled from here — the generation guard in {@link startEngine} neutralizes
   * its eventual stale settlement), recover the tab (reload + debugger
   * re-attach, itself deadline-bounded), then restart the engine through
   * {@link startEngine} so the new run owns the driver token and
   * `graph.enginePromise` — dispose never awaits the permanently-pending
   * stale loop.
   */
  private async recoverWedgedEngine(): Promise<void> {
    const graph = this.graph;
    if (graph === null || this.disposing) return;
    logger.error('foundation: step watchdog fired — engine silent past the stale window with no pending wait; recovering', {
      staleAfterMs: RECOVERY.STEP_WATCHDOG_MS,
      lastActivityAt: this.lastEngineActivityAt,
      now: graph.clock.now(),
    });
    graph.engine.stop();
    // The wedged run still holds the driver token; release it so the restart
    // below is not refused. The stale loop's `.finally` cannot re-clear the
    // new run's token (generation guard).
    this.lease.release('growth');
    if (typeof this.tab.recoverTab === 'function') {
      try {
        await this.tab.recoverTab();
      } catch (e) {
        // Recovery is best-effort: a restart against an un-recovered tab still
        // fails loudly through the bounded tab seams instead of hanging.
        logger.error('foundation.stepWatchdog: tab recovery failed', { error: String(e) });
      }
    }
    if (this.disposing || this.graph === null) return;
    // The recovery ladder keeps the full history: a watchdog-driven tab
    // recovery is a 'tab-unhealthy' note in its tally (a note, never a hold).
    this.graph.engine.noteExternalTabRecovery();
    const status = await this.startEngine();
    logger.warn('foundation.stepWatchdog: engine restarted after recovery', {
      state: status.state,
    });
  }

  /**
   * A tab health event landed (debugger detach, renderer gone/unresponsive,
   * input fallback — see {@link InstagramTab.onUnhealthy}). Route it into the
   * same recover-then-note flow the step watchdog uses: a bounded
   * {@link InstagramTab.recoverTab} plus a recovery-ladder note. The engine is
   * deliberately NOT stopped/restarted here — if it is mid-run against a
   * genuinely dead tab, the step watchdog / recovery ladder escalate through
   * their own machinery. Guarded: never while disposing / tearing down / the
   * tour hold is up / a system sleep-wake is in progress (the wake sequence
   * re-validates the tab itself); never re-entrant; and repeated events
   * coalesce into ONE recovery per `RECOVERY.TAB_EVENT_DEBOUNCE_MS` window.
   */
  private handleTabUnhealthy(reason: string): void {
    logger.error('foundation: tab reported unhealthy', { reason });
    if (this.disposing || this.tearingDown || this.lease.tourHeld() || this.suspendedForSleep) {
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
    void this.recoverAfterTabEvent(reason).finally(() => {
      this.tabEventRecoveryInFlight = false;
    });
  }

  /** The bounded recover-then-note body of {@link handleTabUnhealthy}. */
  private async recoverAfterTabEvent(reason: string): Promise<void> {
    logger.warn('foundation: recovering tab after health event', { reason });
    if (typeof this.tab.recoverTab === 'function') {
      try {
        // recoverTab is internally deadline-bounded (reload + re-attach).
        await this.tab.recoverTab();
      } catch (e) {
        logger.error('foundation: tab recovery after health event failed', {
          reason,
          error: String(e),
        });
        return;
      }
    }
    // Generation-safe (mirrors the watchdog path): the graph may have been
    // torn down or a dispose begun while the recovery ran — never touch a
    // stale engine. The ladder keeps the full history: this external recovery
    // is a 'tab-unhealthy' note in its tally (a note, never a hold).
    if (this.disposing || this.graph === null) return;
    this.graph.engine.noteExternalTabRecovery();
  }

  // -------------------------------------------------------------------------
  // System sleep/resume (powerMonitor — wired by main, policy lives here)
  // -------------------------------------------------------------------------

  /**
   * The OS is suspending (lid close — NOT covered by the app-suspension power
   * save blocker). Freeze cleanly NOW, synchronously: a suspend handler cannot
   * hold off sleep, so nothing here may await. A RUNNING growth engine is
   * stopped via {@link Engine.stop} — stop (not pause) aborts the run signal,
   * so an in-flight adapter wait surfaces as `ActionAbortedError` → `'blocked'`
   * in the churn rim (record untouched) instead of stalling across the sleep
   * and burning a spurious failure on wake. Whether it was running is
   * remembered so {@link resumeFromSleep} restarts it; a paused/halted/idle
   * engine (a user's own state) is left exactly as it is.
   */
  suspendForSleep(): void {
    if (this.disposing) return;
    this.suspendedForSleep = true;
    const graph = this.graph;
    const state = graph?.engine.status().state ?? null;
    this.resumeEngineAfterSleep = state === 'running';
    logger.warn('foundation: system suspend — freezing', {
      engineState: state,
      activeDriver: this.lease.owner(),
      willResumeEngine: this.resumeEngineAfterSleep,
    });
    if (graph !== null && state === 'running') {
      graph.engine.stop();
      // The stopped run holds the driver token until its loop's in-flight step
      // settles (possibly seconds after wake) — release it now so the wake
      // sequence's restart is never refused. The stale loop's own settlement
      // is generation-guarded (mirrors {@link recoverWedgedEngine}).
      this.lease.release('growth');
    }
  }

  /**
   * The OS resumed. Run the ordered wake sequence:
   *
   *  1. a short JITTERED settle delay (`RECOVERY.RESUME_SETTLE_MIN/MAX_MS`) —
   *     the network stack and the tab's renderer re-establish for a few
   *     seconds after wake, and probing instantly reads a half-dead system;
   *  2. an immediate connectivity re-probe (the monitor's own cadence is too
   *     slow) — a still-offline network then flows through the engine's
   *     existing offline auto-hold;
   *  3. tab health canary → bounded {@link InstagramTab.recoverTab} when
   *     unhealthy (a sleep-teardown debugger detach lands here);
   *  4. sentinel re-check (diagnostic — the engine's own per-step sentinel
   *     gate stays authoritative);
   *  5. THEN restart the growth engine IFF it was running at suspend and
   *     nothing else has claimed the tab meanwhile.
   *
   * `settleMsOverride` is test-injectable; production draws the jitter from
   * the shared distributions primitives.
   */
  async resumeFromSleep(opts: { settleMsOverride?: number } = {}): Promise<void> {
    if (this.disposing) return;
    if (this.resumeSequenceInFlight) {
      logger.warn('foundation: resume ignored — wake sequence already in flight');
      return;
    }
    this.resumeSequenceInFlight = true;
    try {
      const restart = this.resumeEngineAfterSleep;
      this.resumeEngineAfterSleep = false;
      logger.warn('foundation: system resumed — running wake sequence', {
        restartEngine: restart,
      });
      const settleMs =
        opts.settleMsOverride ??
        uniform(RECOVERY.RESUME_SETTLE_MIN_MS, RECOVERY.RESUME_SETTLE_MAX_MS).sample(Math.random);
      await sleep(settleMs, this.disposeAbort.signal);
      if (this.disposing) return;

      this.requestConnectivityCheck?.();

      if (typeof this.tab.checkHealth === 'function') {
        const health = await this.tab.checkHealth();
        if (!health.healthy && typeof this.tab.recoverTab === 'function') {
          logger.warn('foundation: post-wake tab unhealthy, recovering', { health });
          try {
            await this.tab.recoverTab();
            // Same tally note as every other external tab recovery.
            if (!this.disposing && this.graph !== null) {
              this.graph.engine.noteExternalTabRecovery();
            }
          } catch (e) {
            logger.error('foundation: post-wake tab recovery failed', { error: String(e) });
          }
        }
      }
      if (this.disposing) return;

      const graph = this.graph;
      if (graph !== null) {
        try {
          const sentinel = await graph.sentinel.check();
          if (sentinel !== 'ok') {
            logger.warn('foundation: post-wake sentinel not clear', { sentinel });
          }
        } catch (e) {
          logger.warn('foundation: post-wake sentinel check failed', { error: String(e) });
        }
      }

      if (
        restart &&
        !this.disposing &&
        !this.lease.tourHeld() &&
        this.lease.owner() === null &&
        this.graph !== null &&
        this.graph.engine.status().state === 'idle'
      ) {
        logger.info('foundation: restarting growth engine after system resume');
        await this.startEngine();
      }
    } finally {
      this.resumeSequenceInFlight = false;
      this.suspendedForSleep = false;
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
   * growth engine is no longer a blocker — {@link startPrune} pauses it for the
   * hand-off and resumes it when the prune finishes — so the only gates left are
   * "not already driving the tab" (no active prune) and "inside active hours".
   */
  private async maybeRunScheduledPrune(): Promise<void> {
    if (this.disposing || this.lease.tourHeld() || this.lease.owner() !== null) return;
    const graph = await this.builtGraph();
    if (graph === null) return;
    const cooldown = this.pruneRateCooldown(graph);
    if (cooldown !== null) {
      logger.info('foundation: scheduled prune skipped — rate-limit cool-down', cooldown);
      return;
    }
    const settings = this.resolveSettings();
    if (!pruneDue(settings.pruneScheduleDays, settings.pruneLastRunAt, graph.clock.now())) {
      return;
    }
    // Re-check the driver token after the await: never contend with a prune that
    // started in the meantime. (Growth running is fine — startPrune hands it off.)
    if (this.lease.owner() !== null) return;
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
    await sleep(launchHoldMs, this.disposeAbort.signal);
    if (this.disposing || this.lease.tourHeld() || this.lease.owner() !== null) return;
    if (!graph.rate.withinActiveHours()) return;
    // A manual prune may have started AND completed during the hold — its
    // fresh lastRunAt makes the schedule no longer due.
    {
      const s = this.resolveSettings();
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
      const res = await this.scanPrune();
      if (res.ok) void this.updateSettings({ pruneLastRunAt: graph.clock.now() });
      return;
    }
    void this.startPrune();
  }

  /**
   * Await every MANUAL operation still in flight (a read-followers scrape, a
   * follow-one click, a seed check): each still holds live store/tab
   * references, and an untracked manual acquire used to keep writing edges
   * into a closed database handle when the app quit mid-read. Bounded —
   * the dispose abort already interrupts their sleeps.
   */
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
    return buildGraph(ownPk, ownUsername, this.graphBuildDeps());
  }

  /** The nine things the graph build reads off the composition root. */
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
      onStatus: (s) => this.emit(s),
      onPruneStatus: (s) => this.projections.send('pruneStatus', s),
      onHalt: (reason) => {
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

  /**
   * The ACTIVE driver's run token: adapter/rim waits link to this so a stop()
   * interrupts an in-flight DOM poll or pacing sleep instead of sitting out its
   * timeout. Pause is deliberately NOT included — a paused step finishes
   * cleanly. Shutdown interrupts EVERY adapter wait, manual ops included:
   * without it dispose() cannot break their in-flight polls and the store
   * closes underneath them.
   */
  private driverSignal(): AbortSignal | undefined {
    if (this.disposing) return this.disposeAbort.signal;
    if (this.lease.owner() === 'prune') return this.graph?.pruneEngine.runSignal();
    if (this.lease.owner() === 'growth') return this.graph?.engine.runSignal();
    return undefined;
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

  /**
   * One-shot read-only precheck of a seed username: whether it exists and whether
   * its followers list is visible (public, or private and followed). One profile
   * VISIT through the shared tab, sentinel-gated. Never throws across IPC.
   */
  async checkSeed(username: string): Promise<SeedCheck> {
    // Veil: the seed check is a real profile visit — reading counts.
    return this.trackManualOp(() =>
      this.activity.with('seed-check', () => this.checkSeedHeld(username)),
    );
  }

  private async checkSeedHeld(username: string): Promise<SeedCheck> {
    const graph = await this.builtGraph();
    if (graph === null) {
      return { ok: false, exists: false, followersVisible: false, isPrivate: false, reason: 'not-logged-in' };
    }
    // R3: refuse while a driver runs — a concurrent one-shot fetch competes with
    // that driver's own IG traffic and its sentinel gating.
    const busy = this.busyDriverReason();
    if (busy !== null) {
      return { ok: false, exists: false, followersVisible: false, isPrivate: false, reason: busy };
    }
    try {
      const clean = username.trim().replace(/^@/, '');
      if (!clean) return { ok: false, exists: false, followersVisible: false, isPrivate: false, reason: 'empty' };
      if ((await graph.sentinel.check()) !== 'ok') {
        return { ok: false, exists: false, followersVisible: false, isPrivate: false, reason: 'blocked' };
      }
      // One profile VISIT (`rim/profile-visit.ts`): the page's own client reads
      // the profile and the observer has stored it — FACTS STREAM (PRINCIPLES
      // §1) — by the time this resolves, adopted seed or not.
      const visit = await graph.profiles.visit(clean);
      if (!visit.ok) {
        // A wall is IG blocking; `gone` is the page saying the profile is not
        // available; a page that never answered is unknown, never "not found".
        const reason =
          visit.kind === 'walled' ? 'blocked' : visit.kind === 'gone' ? 'not-found' : 'error';
        logger.warn('foundation.checkSeed: profile visit failed', { kind: visit.kind, reason, ...visit.detail });
        return { ok: false, exists: false, followersVisible: false, isPrivate: false, reason };
      }
      const isPrivate = visit.obs.fields.isPrivate === true;
      // A private account's followers are viewable iff we follow it. The
      // profile body carries the viewer-side flags, so a private seed no longer
      // costs a `friendships/show` read (same rule as before: follow or request).
      const followersVisible = isPrivate
        ? visit.viewer.following === true || visit.viewer.requested === true
        : true;
      return {
        ok: true,
        exists: true,
        followersVisible,
        isPrivate,
        reason: followersVisible ? undefined : 'private',
      };
    } catch (e) {
      // Only a genuinely unexpected exception (evaluate/tab failure) lands here.
      logger.error('foundation.checkSeed: failed', { username, error: String(e) });
      return { ok: false, exists: false, followersVisible: false, isPrivate: false, reason: 'error' };
    }
  }

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
  async getSettings(): Promise<Settings> {
    return this.resolveSettings();
  }

  /**
   * Reset all settings to their defaults (knowledge data + IG session are kept),
   * persist, and — when built — reload the live engine configs.
   */
  async resetSettings(): Promise<Settings> {
    const s: Settings = { ...DEFAULT_SETTINGS };
    this.settingsCache = s;
    try {
      saveSettings(this.settingsFilePath(), s);
    } catch (e) {
      logger.error('foundation.resetSettings: persist failed', { error: String(e) });
    }
    if (this.graph !== null) this.reloadConfigs(s);
    logger.info('foundation: settings reset to defaults');
    return s;
  }

  /**
   * Wipe everything EXCEPT settings: tear down the graph, delete the knowledge DB
   * (including WAL/SHM sidecars), and clear the persisted IG session (a logout).
   * The tab is sent back to the Instagram home page so the user can log in again;
   * the next login lazily rebuilds a fresh graph over a brand-new DB.
   */
  async clearData(): Promise<EpoStatus> {
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

      const dbBase = path.join(this.userDataDir, IG_DB_FILE);
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          fs.rmSync(dbBase + suffix, { force: true });
        } catch (e) {
          logger.error('foundation.clearData: failed to remove db file', {
            file: dbBase + suffix,
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

    void this.tab.goto(IG_HOME_URL);

    const s = await this.status();
    this.projections.send('status', s);
    logger.info('foundation: data cleared (db + IG session)');
    return s;
  }

  /**
   * Merge a partial into settings, persist atomically, and — when the engine is
   * built — reload every derived component config live so the change takes effect
   * without a restart. When not built, the merge is only persisted (§5).
   */
  async updateSettings(partial: Partial<Settings>): Promise<Settings> {
    // Sanitize AFTER the merge: IPC payloads are unvalidated renderer input, and
    // a hand-edited settings file already passed through the same clamps at load.
    const next: Settings = sanitizeSettings({ ...this.resolveSettings(), ...partial });
    this.settingsCache = next;
    try {
      saveSettings(this.settingsFilePath(), next);
    } catch (e) {
      logger.error('foundation.updateSettings: persist failed', { error: String(e) });
    }
    if (this.graph !== null) this.reloadConfigs(next);
    return next;
  }

  /** Push the new Settings into every live component's config (no rebuild). */
  private reloadConfigs(s: Settings): void {
    const g = this.graph;
    if (g === null) return;
    g.rate.applyConfig(toRateGovernorConfig(s));
    g.churn.applyConfig(toChurnConfig(s));
    g.scanner.applyConfig(toScannerConfig(s), toScorerConfig(s));
    g.followback.applyConfig(toFollowbackConfig(s));
    g.chain.applyConfig(toChainConfig(s));
    g.pruneEngine.applyConfig(toPruneConfig(s));
    // Organic pacing knobs update live (gap/velocity/volume); a legacy↔organic model
    // switch takes effect on the next graph build (the planner is a construction-time dep).
    g.pacing?.applyConfig(toPacingConfig(s));
    g.churnActions.setDryRun(s.dryRun);
    g.engine.applySettings(s);
    logger.info('foundation: settings reloaded into live engine configs');
  }

  /** Load settings once from disk (merged over defaults) and cache the result. */
  private resolveSettings(): Settings {
    if (this.settingsCache === null) {
      this.settingsCache = loadSettings(this.settingsFilePath());
    }
    return this.settingsCache;
  }

  private settingsFilePath(): string {
    return path.join(this.userDataDir, IG_SETTINGS_FILE);
  }

  // -------------------------------------------------------------------------
  // Identity resolution
  // -------------------------------------------------------------------------

  /**
   * Resolve our username before graph construction. Page identity leads, then a
   * guarded native profile click and JSON fallback handle hydration races.
   * Failures remain uncached so a later login can resolve the account.
   */
  private async resolveOwnUsername(): Promise<string | undefined> {
    // Resolution uses guarded native input even before the graph is built.
    return resolveUsernameFromTab(this.tab, {
      attempts: SCHEDULER.USERNAME_RESOLVE_ATTEMPTS,
      retryMs: SCHEDULER.USERNAME_RESOLVE_RETRY_MS,
      signal: this.disposeAbort.signal,
      interactor: createTabInteractor(this.tab, { abortSignal: () => this.disposeAbort.signal }),
    });
  }

  // -------------------------------------------------------------------------
  // Status projection helpers
  // -------------------------------------------------------------------------

  private emit(status: EngineStatus): void {
    // Step-watchdog heartbeat: every engine status emission proves the loop is
    // still advancing through its steps.
    this.lastEngineActivityAt = this.graph?.clock.now() ?? Date.now();
    // Veil state machine: the growth loop holds the veil exactly while RUNNING
    // (paused/idle/halted release it — a parked engine issues no requests). The
    // signal is level-triggered, then the start bridge retires on the first
    // emit — in that order, so the hand-off never dips the veil.
    this.activity.signal('growth-loop', status.state === 'running');
    this.releaseGrowthStartBridge();
    this.projections.send('status', { ...status, loggedIn: this.graph !== null });
  }

  /** Retire the `growth-start` bridge hold (idempotent; see {@link startEngine}). */
  private releaseGrowthStartBridge(): void {
    if (this.lease.endGrowthStart()) this.activity.release('growth-start');
  }

  private builtStatus(): EpoStatus {
    // Only called when `this.graph` is set (post-build).
    const graph = this.graph;
    if (graph === null) return this.notBuiltStatus(true);
    return { ...graph.engine.status(), loggedIn: true };
  }

  private notBuiltPruneStatus(): PruneStatus {
    return notBuiltPruneStatus(this.resolveSettings());
  }

  private notBuiltStatus(loggedIn: boolean): EpoStatus {
    return notBuiltStatus(loggedIn, this.lastOnline);
  }
}
