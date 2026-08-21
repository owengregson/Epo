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

import { app, session } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { type InstagramTab, IG_HOME_URL, IG_PARTITION } from '@/adapter/tab';
import { InstagramAdapter } from '@/adapter/instagram-adapter';
import { Interactor } from '@/interaction/interactor';
import {
  ElectronInputDriver,
  ObservedInputDriver,
  type CursorObserver,
} from '@/interaction/input-driver';
import { Reader } from '@/adapter/reader';
import type { Actor } from '@/adapter/actor';
import type { Sentinel } from '@/adapter/sentinel';
import {
  resolveOwnUsername as resolveUsernameFromTab,
  usernameFromProfileUrl,
} from '@/adapter/identity';
import { KnowledgeStore } from '@/store/knowledge-store';
import { SystemClock } from '@/governors/clock';
import { ScheduleManager } from '@/timing/schedule-manager';
import { DelayManager } from '@/timing/delay-manager';
import { TIMED_OUT, sleep, withTimeout } from '@/timing/primitives';
import { ADAPTER, POLL, PRUNE, SCHEDULER } from '@/timing/config';
import { RateGovernor } from '@/governors/rate-governor';
import { shapeChainList, shapeQueueList } from '@/main/foundation-reads';
import {
  RelationshipReconciler,
  installRelationshipReconciler,
} from '@/rim/relationship-reconciler';
import { FollowersPageReader } from '@/rim/followers-page-reader';
import { AdapterBackedAcquisition } from '@/rim/follower-acquisition';
import { AdapterBackedChurnActions } from '@/rim/churn-actions';
import { AdapterBackedOwnFollowersSource } from '@/rim/own-followers-source';
import { AdapterBackedOwnFollowingSource } from '@/rim/own-following-source';
import { ListPageWalker } from '@/rim/list-page-walker';
import { TabActivity } from '@/main/tab-activity';
import {
  type ActivityReporter,
  NOOP_ACTIVITY_REPORTER,
} from '@/adapter/activity-reporter';
import { AdapterBackedOwnFollowersTargetSource } from '@/rim/own-followers-target-source';
import { StoreBackedTargetDiscovery } from '@/rim/target-discovery';
import { AdapterBackedProfileEnricher } from '@/rim/profile-enricher';
import {
  SURFACE,
  asFetchEnvelope,
  envelopeLooksLikeHtml,
  isShapeMismatch,
} from '@/adapter/ig-surface';
import { ChurnScheduler, type ChurnActionOutcome } from '@/engine/churn-scheduler';
import { Scanner } from '@/engine/scanner';
import { FollowbackWatcher } from '@/engine/followback-watcher';
import { AdapterBackedFollowNotifications } from '@/rim/follow-notifications';
import { ChainController, type TargetDiscovery } from '@/engine/chain-controller';
import {
  createEngine,
  type Engine,
  type EngineStatus,
  type EngineUnfollowFeed,
} from '@/engine/engine';
import {
  createPruneEngine,
  pruneDue,
  type PruneCandidate,
  type PruneEngine,
  type PruneOwnFollowers,
  type PruneOwnFollowing,
  type PruneScanFetch,
  type PruneStatus,
} from '@/engine/prune-engine';
import type { FollowerAcquisition } from '@/rim/types';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  sanitizeSettings,
  saveSettings,
  toRateGovernorConfig,
  toChurnConfig,
  toScorerConfig,
  toScannerConfig,
  toFollowbackConfig,
  toChainConfig,
  toPruneConfig,
  toPacingConfig,
  type Settings,
} from '@/settings/settings';
import { SessionPlanner, type PlannerSnapshot } from '@/timing/session-planner';
import { samplePhaseOffset } from '@/timing/circadian';
import { patternCircadianProfile } from '@/settings/pattern-map';
import { CIRCADIAN } from '@/timing/config';
import * as logger from '@/utils/logger';
import type {
  ActionResult,
  ChainTargetView,
  FollowState,
  NetGrowthPoint,
  EpoStatus,
  PruneControlResult,
  PruneScanResult,
  QueueListResult,
  ReadFollowersResult,
  SeedCheck,
} from '@/types';

const IG_DB_FILE = 'epo.db';
const IG_SETTINGS_FILE = 'epo-settings.json';

// Timing constants (username-resolve retry, prune park timeout, watcher cadence)
// live in the shared registry: see `SCHEDULER.*` and `PRUNE.PARK_TIMEOUT_MS` in
// `@/timing/config`.

export interface FoundationDeps {
  tab: InstagramTab;
  /** Push each fresh status projection to the renderer (main wires this to IPC). */
  onStatus?: (status: EpoStatus) => void;
  /** Push each fresh prune status projection to the renderer. */
  onPruneStatus?: (status: PruneStatus) => void;
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
}

/** The lazily-built dependency graph, cached once `ownPk` is resolvable. */
interface BuiltGraph {
  store: KnowledgeStore;
  engine: Engine;
  acquisition: FollowerAcquisition;
  churnActions: AdapterBackedChurnActions;
  /** The adapter's actor — kept for the paced own-profile landing click. */
  actor: Actor;
  /** Disposer for the passive relationship reconciler (Phase A). */
  relationshipReconcilerUnsub: () => void;
  /** Disposer for the always-on profile-info observer (header counts → store). */
  profileInfoUnsub: () => void;
  ownPk: string;
  /** Our own username at build time, or `undefined` when it could not be resolved. */
  ownUsername: string | undefined;
  /** The single clock the graph shares — used to timestamp manual-op ledger rows. */
  clock: SystemClock;
  /** The ONE wait owner both engines share (see the `build()` wiring). */
  delays: DelayManager;
  /** The shared block-detection sentinel — gates manual one-shot fetches (seed check). */
  sentinel: Sentinel;
  /**
   * The loop promise returned by the most recent `engine.start()`, kept so
   * `dispose()` can await the loop's exit before closing the store (f14). Null
   * until the engine is first started.
   */
  enginePromise: Promise<void> | null;
  /** The auto-prune routine (Phase 5) — mutually exclusive with the engine. */
  pruneEngine: PruneEngine;
  /**
   * The run promise of the most recent `pruneEngine.run()`, kept so `dispose()`
   * can await its exit before closing the store (f14). Null until first started.
   */
  prunePromise: Promise<void> | null;
  /** Live component handles kept so runtime Settings changes can reload configs. */
  rate: RateGovernor;
  churn: ChurnScheduler;
  scanner: Scanner;
  followback: FollowbackWatcher;
  chain: ChainController;
  /** The organic pacing planner, present only when `Settings.pacingModel === 'organic'`. */
  pacing: SessionPlanner | undefined;
}

export class Foundation {
  private readonly tab: InstagramTab;
  private readonly onStatusCb?: (status: EpoStatus) => void;
  private readonly onPruneStatusCb?: (status: PruneStatus) => void;
  private readonly cursorObserver?: CursorObserver;
  /** Live phase readout tap (veil); a no-op when main wires none. */
  private readonly reporter: ActivityReporter;
  private graph: BuiltGraph | null = null;
  /**
   * The TAB DRIVER TOKEN (Phase 5 mutual exclusion): which long-running routine
   * currently owns the shared Instagram tab. Growth `startEngine` is refused
   * while `'prune'` holds the token; `startPrune`/`scanPrune` are refused while
   * the growth loop is running or paused. Set around each run, cleared when the
   * run's promise settles — so two drivers can never share the one tab.
   */
  private activeDriver: 'growth' | 'prune' | null = null;
  /**
   * Phase 5 tab hand-off: true when a prune scan/run PAUSED a running growth
   * engine to borrow the tab, so it must be RESUMED when the prune finishes.
   * Stays false when growth was already idle/halted or was paused by the USER
   * (whose pause we must not silently undo). Set in {@link acquireTabForPrune},
   * cleared in {@link releaseTabAfterPrune}.
   */
  private growthPausedForPrune = false;
  /**
   * Bumped by every {@link stopPrune}. A prune scan/run request that was
   * waiting on the lazy graph build compares this to the value it captured at
   * entry — a mismatch means the user pressed Stop while the build was in
   * flight, and the pending scan/run cancels instead of starting anyway.
   */
  private pruneStopEpoch = 0;
  /**
   * f6 — the in-flight build promise. Memoized so two concurrent IPC calls landing
   * in `ensureBuilt` at once share ONE build instead of each calling `build()`
   * (which would leak a second store, double the request-metering subscription, and
   * orphan an engine). Cleared once the build settles.
   */
  private buildPromise: Promise<boolean> | null = null;
  private ownPkCache: string | null = null;
  /** Settings cached once loaded, so `getSettings`/`updateSettings` share one copy. */
  private settingsCache: Settings | null = null;
  /**
   * True once {@link dispose} begins. Read handlers may still fire during shutdown
   * (the renderer's in-flight polling invokes drain after the window closes); this
   * flag makes {@link ensureBuilt} refuse to (re)build — so a late `chain:list` /
   * `growth:series` can never re-navigate the tab or re-open the store mid-teardown.
   */
  private disposing = false;
  /**
   * True while a teardown (graph teardown, data wipe) is in progress. Unlike
   * `disposing` it is temporary: `ensureBuilt` refuses to (re)build and an
   * in-flight `buildResolved` aborts instead of resurrecting a store over a
   * path that is about to be (or was just) deleted. Nesting-safe: writers save
   * and restore the previous value.
   */
  private tearingDown = false;
  /**
   * In-flight MANUAL operations (read-followers, follow/unfollow-one,
   * seed-check). Teardown awaits these before closing the store — an
   * un-tracked manual acquire used to keep writing edges into a closed
   * better-sqlite3 handle when the app quit mid-read.
   */
  private readonly inFlightManualOps = new Set<Promise<unknown>>();
  /** Epoch ms of the last failed own-username resolution attempt (backoff). */
  private usernameRetryAt = 0;
  /**
   * Graph-mutation push machinery (docs/PRINCIPLES.md §2 — the UI mirrors the
   * graph): the store fires on every write, this trailing throttle coalesces
   * a burst into one fresh dual-status push, so counts tick WHILE a scan/
   * sweep/enrichment is running instead of when it resolves.
   */
  private graphPushTimer: ReturnType<typeof setTimeout> | null = null;
  private mutationUnsub: (() => void) | null = null;
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
  /**
   * True between a growth start and the engine's first status emit: the
   * `growth-start` bridge hold spans the gap so the veil never dips while the
   * loop spins up (the status-stream `growth-loop` signal takes over on the
   * first emit).
   */
  private pendingGrowthStart = false;

  constructor(deps: FoundationDeps) {
    this.tab = deps.tab;
    this.onStatusCb = deps.onStatus;
    this.onPruneStatusCb = deps.onPruneStatus;
    this.cursorObserver = deps.cursorObserver;
    this.reporter = deps.activityReporter ?? NOOP_ACTIVITY_REPORTER;
    this.activity = new TabActivity((active, holds) => {
      logger.info('foundation: tab activity', { active, holds });
      deps.onActivity?.(active, holds);
    });
    logger.info('foundation created (graph deferred until login)');
  }

  // -------------------------------------------------------------------------
  // Login / identity / lazy build
  // -------------------------------------------------------------------------

  /** True once the persistent IG session carries a `ds_user_id` cookie. */
  async isLoggedIn(): Promise<boolean> {
    return (await this.resolveOwnPk()) !== null;
  }

  /**
   * Build the dependency graph exactly once, after login. Returns whether a graph
   * exists afterwards: `false` when not logged in (nothing to build yet), `true`
   * once built.
   *
   * f6 — the in-flight build is memoized: concurrent callers share ONE build so a
   * race can't leak a second store / double the metering subscription / orphan an
   * engine. R5 — a graph that was built DEGRADED (own username unresolved) is not
   * frozen forever: a later call re-attempts resolution and, if it now succeeds and
   * the engine is idle, rebuilds so follow-back/own-followers chaining recover.
   */
  async ensureBuilt(): Promise<boolean> {
    // Shutting down / tearing down: never (re)build — let reads resolve to safe
    // empties instead of re-navigating the tab or re-opening the store
    // mid-teardown (the polled reads race teardownGraph's async drain window).
    if (this.disposing || this.tearingDown) return false;
    // Fully built (with a real username): nothing more to do.
    if (this.graph !== null && this.graph.ownUsername !== undefined) return true;
    // A DEGRADED graph (username unresolved) is still a built graph. Username
    // recovery is retried on a BACKOFF, never on every call: the resolution
    // attempt navigates the tab and fetches `current_user` up to 4 times
    // (~23 s), and 16 routine IPC reads used to re-trigger it each — a
    // sustained navigation/fetch loop the rate governor never saw.
    if (this.graph !== null) {
      const sinceLastAttempt = Date.now() - this.usernameRetryAt;
      if (sinceLastAttempt < SCHEDULER.USERNAME_REBUILD_BACKOFF_MS) return true;
      this.usernameRetryAt = Date.now();
    }
    // Coalesce concurrent builds/retries onto a single in-flight promise (f6).
    if (this.buildPromise !== null) return this.buildPromise;
    this.buildPromise = this.buildOrRetry().finally(() => {
      this.buildPromise = null;
    });
    return this.buildPromise;
  }

  /**
   * The not-built guard copied across every IPC entry point, centralized:
   * ensure the graph is built and hand it back, or `null` (each caller returns
   * its own safe empty). Callers hold the RETURNED graph — never re-read
   * `this.graph` after an await, where a concurrent teardown can null it.
   */
  private async builtGraph(): Promise<BuiltGraph | null> {
    if (!(await this.ensureBuilt())) return null;
    return this.graph;
  }

  /**
   * Mutual exclusion (Phase 5), centralized: the prune routine holds the tab
   * driver token — never put a second driver on the one shared tab. Returns the
   * typed refusal status to hand back, or `null` when growth may proceed.
   */
  private refuseIfPruneActive(op: string): EpoStatus | null {
    if (this.activeDriver !== 'prune') return null;
    logger.warn(`foundation.${op}: prune active, refusing`);
    return { ...this.builtStatus(), refusal: 'prune-running' };
  }

  /**
   * The memoized body of {@link ensureBuilt}. Resolves `ownPk` (required) and
   * `ownUsername` (best-effort, retried — R5). Builds the graph on first success;
   * on a later call, rebuilds a previously-degraded graph only once the username
   * recovers AND the engine is not mid-run (so a live loop is never torn out).
   */
  private async buildOrRetry(): Promise<boolean> {
    // The pk resolve is passive (a cookie read) — no hold, so pre-login status
    // polls never flash the veil over the login screen. Everything PAST it can
    // navigate the tab (identity resolution), so it runs under a `build` hold.
    const ownPk = await this.resolveOwnPk();
    if (ownPk === null) return false;
    return this.activity.with('build', () => this.buildResolved(ownPk));
  }

  /** The tab-driving tail of {@link buildOrRetry} (runs under the `build` hold). */
  private async buildResolved(ownPk: string): Promise<boolean> {
    const ownUsername = await this.resolveOwnUsername();

    if (this.graph !== null) {
      // A degraded graph already exists (username was undefined at build time).
      if (ownUsername === undefined) return true; // still no username — keep it.
      const state = this.graph.engine.status().state;
      if (state === 'running' || state === 'paused') {
        logger.warn('foundation: username recovered but engine active, deferring rebuild', {
          ownUsername,
          state,
        });
        return true;
      }
      logger.info('foundation: own username recovered, rebuilding graph', { ownUsername });
      await this.teardownGraph();
    }

    // A teardown/wipe raced this build past the ensureBuilt gate: abort instead
    // of resurrecting a store over a path that is being torn down or deleted.
    if (this.disposing || this.tearingDown) {
      logger.warn('foundation: build aborted, teardown in progress');
      return false;
    }
    this.graph = this.build(ownPk, ownUsername);
    logger.info('foundation: dependency graph built', {
      ownPk,
      ownUsername: ownUsername ?? '(unknown)',
    });
    // §2 live mirror: every store write (facts stream in per row) schedules a
    // throttled push of BOTH status projections, so the renderer's counts move
    // during scans/sweeps rather than at their end.
    this.mutationUnsub = this.graph.store.onMutation(() => this.scheduleGraphPush());
    // Push fresh projections the moment the graph exists. The renderer's first
    // status pull races this lazy build and gets the all-zero not-built shape;
    // the idle engine emits nothing on its own, so without this push the queues
    // / prune counts stay wrong until a keep-alive pull happens to land after
    // the build (the "numbers don't match the queues after reload" bug).
    this.onStatusCb?.(this.builtStatus());
    this.onPruneStatusCb?.(this.graph.pruneEngine.status());
    return true;
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
    // Wait (bounded) for a logged-in graph: session-restore resolves the pk
    // cookie almost immediately; a logged-out tab just runs out the poll.
    for (let i = 0; i < ADAPTER.PROFILE_LAND_ATTEMPTS; i++) {
      if (this.disposing) return;
      if (await this.ensureBuilt()) break;
      if (i === ADAPTER.PROFILE_LAND_ATTEMPTS - 1) {
        logger.info('foundation: not logged in, profile landing skipped');
        return;
      }
      await sleep(ADAPTER.PROFILE_LAND_RETRY_MS, this.disposeAbort.signal);
    }
    const graph = this.graph;
    if (graph === null || this.disposing) return;
    // Never contend with an active driver for the tab.
    if (this.activeDriver !== null) return;

    const target = graph.ownUsername ?? null;
    const onProfile = (): boolean => {
      const u = usernameFromProfileUrl(this.tab.currentUrl());
      return u !== null && (target === null || u === target);
    };
    if (onProfile()) return;

    await this.activity.with('open-profile', async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (this.disposing || this.activeDriver !== null) return;
        let clicked = false;
        try {
          clicked = await graph.actor.clickOwnProfileLink();
        } catch (e) {
          logger.warn('foundation: profile landing click failed', { error: String(e) });
          return;
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
        } else {
          // Link not hydrated yet — give the page a beat and retry once.
          await sleep(ADAPTER.PROFILE_LAND_RETRY_MS, this.disposeAbort.signal);
        }
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
    this.activeDriver = 'growth';
    // Veil: bridge the spin-up gap — held until the engine's first status emit
    // (where the `growth-loop` signal takes over) or, as a backstop, loop exit.
    this.pendingGrowthStart = true;
    this.activity.hold('growth-start');
    // Fire-and-forget: `start()` resolves only when the loop exits; do NOT await
    // here. f14: keep the loop promise so `dispose()` can await its exit before
    // closing the store (a mid-step store call must not hit a closed DB).
    const loop = graph.engine
      .start()
      .catch((e: unknown) => {
        logger.error('foundation: engine loop errored', { error: String(e) });
      })
      .finally(() => {
        if (this.activeDriver === 'growth') this.activeDriver = null;
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
      try {
        await graph.enginePromise;
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
    this.activeDriver = 'prune';
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
      if (this.activeDriver === 'prune') this.activeDriver = null;
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
      this.activeDriver = 'prune';
      // Borrow the tab BEFORE the run starts: pause a running growth engine and
      // await its park. Await here (not inside the fire-and-forget run) so the
      // caller's result reflects a clean hand-off; the UI's run spinner covers it.
      if (!(await this.acquireTabForPrune())) {
        this.activeDriver = null;
        return { ok: false, reason: 'growth-busy', status: graph.pruneEngine.status() };
      }
      const run = graph.pruneEngine
        .run()
        .catch((e: unknown) => {
          logger.error('foundation: prune run errored', { error: String(e) });
        })
        .finally(() => {
          if (this.activeDriver === 'prune') this.activeDriver = null;
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
    if (this.activeDriver === 'prune') return 'prune-running';
    return null;
  }

  /**
   * Borrow the shared tab for a prune. If the growth engine is actively RUNNING,
   * pause it and wait for its loop to quiesce at the pause gate (so no growth
   * step is mid-flight), recording that WE paused it so it is resumed afterward.
   * Growth that is already idle/halted, or paused by the USER, leaves the tab
   * free — we neither pause nor later resume it. Returns false (aborting the
   * hand-off, resuming growth) only when a running engine fails to park in time —
   * a prune must never share the tab with a live growth step. Caller must already
   * hold `activeDriver === 'prune'`.
   */
  private async acquireTabForPrune(): Promise<boolean> {
    if (this.graph === null) return false;
    const engine = this.graph.engine;
    const state = engine.status().state;
    if (state === 'idle' || state === 'halted') return true; // tab already free
    if (state === 'running') {
      logger.info('foundation: pausing growth engine for prune hand-off');
      engine.pause();
      this.growthPausedForPrune = true;
    }
    // ALWAYS wait for quiescence — including when the USER paused: `pause()`
    // returns while the in-flight growth step (a follow click, an acquisition
    // scroll) is still running, and handing the tab to prune at that moment
    // put two drivers on one WebContents. `awaitParked` resolves immediately
    // when the loop already sits at the pause gate.
    const parked = await engine.awaitParked(PRUNE.PARK_TIMEOUT_MS);
    if (!parked) {
      logger.warn('foundation: growth did not park in time, aborting prune hand-off');
      this.releaseTabAfterPrune(); // undo our pause (if it was ours) — resume growth
      return false;
    }
    return true;
  }

  /**
   * Release the tab after a prune: resume the growth engine IFF this prune paused
   * it (never undo a user's own pause, and never resume a torn-down graph).
   * Idempotent — safe to call from both the abort path and the run's finally.
   */
  private releaseTabAfterPrune(): void {
    if (!this.growthPausedForPrune) return;
    this.growthPausedForPrune = false;
    if (this.graph === null) return;
    const engine = this.graph.engine;
    if (engine.status().state === 'paused') {
      logger.info('foundation: resuming growth engine after prune');
      engine.resume();
    }
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
    if (this.activeDriver === 'prune') return 'prune-running';
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
      .then((s) => this.onStatusCb?.(s))
      .catch((e: unknown) => {
        logger.error('foundation.setConnectivity: status push failed', { error: String(e) });
      });
  }

  /**
   * Close the engine + store on window teardown. Idempotent.
   *
   * f14 — ordering matters: stop the engine, AWAIT the loop's exit (so no step is
   * mid-flight), drop the request-metering subscription, then close the store. A
   * store call from a still-running step must never hit a closed DB.
   */
  async dispose(): Promise<void> {
    this.disposing = true;
    this.disposeAbort.abort();
    this.scheduler.dispose();
    await this.teardownGraph();
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
   * One scheduled-prune check: start a run iff it is due and safe. A RUNNING
   * growth engine is no longer a blocker — {@link startPrune} pauses it for the
   * hand-off and resumes it when the prune finishes — so the only gates left are
   * "not already driving the tab" (no active prune) and "inside active hours".
   */
  private async maybeRunScheduledPrune(): Promise<void> {
    if (this.disposing || this.activeDriver !== null) return;
    const graph = await this.builtGraph();
    if (graph === null) return;
    const settings = this.resolveSettings();
    if (!pruneDue(settings.pruneScheduleDays, settings.pruneLastRunAt, graph.clock.now())) {
      return;
    }
    // Re-check the driver token after the await: never contend with a prune that
    // started in the meantime. (Growth running is fine — startPrune hands it off.)
    if (this.activeDriver !== null) return;
    if (!graph.rate.withinActiveHours()) return;
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
   * Tear down the current graph (if any): stop the engine, await its loop, remove
   * the metering + reconciler subscriptions, and close the store — in that order
   * (f14). Shared by
   * {@link dispose} and the R5 rebuild path. A no-op when nothing is built.
   */
  /** Trailing-throttled dual-status push driven by store mutations (§2). */
  private scheduleGraphPush(): void {
    if (this.graphPushTimer !== null || this.disposing) return;
    this.graphPushTimer = setTimeout(() => {
      this.graphPushTimer = null;
      const graph = this.graph;
      if (graph === null || this.disposing) return;
      this.onStatusCb?.(this.builtStatus());
      this.onPruneStatusCb?.(graph.pruneEngine.status());
    }, POLL.GRAPH_PUSH_THROTTLE_MS);
  }

  private async teardownGraph(): Promise<void> {
    const graph = this.graph;
    if (graph === null) return;
    // The whole drain window is guarded: between `this.graph = null` and
    // `store.close()` below, a polled read's ensureBuilt would otherwise see
    // "not built, not disposing" and open a SECOND store over the same file.
    const wasTearing = this.tearingDown;
    this.tearingDown = true;
    try {
      await this.teardownGraphHeld(graph);
    } finally {
      this.tearingDown = wasTearing;
    }
  }

  /** The body of {@link teardownGraph}, run under the `tearingDown` guard. */
  private async teardownGraphHeld(graph: BuiltGraph): Promise<void> {
    this.graph = null;
    // Stop the mutation→push machinery before anything else: late writes from
    // draining ops must not schedule pushes into a closing store.
    this.mutationUnsub?.();
    this.mutationUnsub = null;
    if (this.graphPushTimer !== null) {
      clearTimeout(this.graphPushTimer);
      this.graphPushTimer = null;
    }
    // A prune hand-off in flight has nothing to resume once the graph is gone.
    this.growthPausedForPrune = false;
    graph.engine.stop();
    graph.pruneEngine.stop();
    if (graph.enginePromise !== null) {
      try {
        await graph.enginePromise;
      } catch (e) {
        logger.error('foundation.teardownGraph: engine loop rejected on stop', {
          error: String(e),
        });
      }
    }
    if (graph.prunePromise !== null) {
      try {
        await graph.prunePromise;
      } catch (e) {
        logger.error('foundation.teardownGraph: prune run rejected on stop', {
          error: String(e),
        });
      }
    }
    // Manual ops in flight (a read-followers scrape, a follow-one click, a
    // seed check) still hold live store/tab references — wait them out
    // (bounded; the dispose abort already interrupts their sleeps) before the
    // store closes underneath them.
    if (this.inFlightManualOps.size > 0) {
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
    graph.relationshipReconcilerUnsub();
    graph.profileInfoUnsub();
    graph.delays.dispose();
    graph.store.close();
  }

  // -------------------------------------------------------------------------
  // Graph construction (Wave 4 §2/§3) — the exact composition, built once.
  // -------------------------------------------------------------------------

  private build(ownPk: string, ownUsername: string | undefined): BuiltGraph {
    const userData = app.getPath('userData');
    const store = new KnowledgeStore(path.join(userData, IG_DB_FILE));
    // Phase A: the store's reconciliation sink + already-following candidate
    // exclusion both anchor on our own pk.
    store.setOwnPk(ownPk);
    const clock = new SystemClock();
    // The shared wait owner: growth and prune wait through ONE DelayManager
    // (keys namespaced `engine:` / `prune:`), so pending deadlines are readable
    // from a single registry.
    const delays = new DelayManager({ clock });
    const settings = this.resolveSettings();

    const rate = new RateGovernor(store, clock, toRateGovernorConfig(settings));

    // Interactor: every Actor click/scroll becomes native input events
    // (sendInputEvent) shaped by the motion profile; the tab is the one
    // Electron seam it drives. Element locating stays in-page via the surface's
    // locate scripts (with the JS-click fallback wherever those are absent).
    // When a cursor observer is wired (the veil's digital-cursor display), the
    // driver is decorated so every synthetic move/press also reports the
    // virtual cursor's state — pure observation, the event stream is unchanged.
    const electronDriver = new ElectronInputDriver(this.tab);
    const interactor = new Interactor({
      driver: this.cursorObserver
        ? new ObservedInputDriver(electronDriver, this.cursorObserver)
        : electronDriver,
    });

    // The ACTIVE driver's run token: adapter/rim waits link to this so a stop()
    // interrupts an in-flight DOM poll or pacing sleep instead of sitting out
    // its timeout. Pause is deliberately NOT included — a paused step finishes
    // cleanly (the park/hand-off contract is unchanged).
    const driverSignal = (): AbortSignal | undefined => {
      // Shutdown interrupts EVERY adapter wait — manual ops included: they
      // used to have no signal at all, so dispose() could not break their
      // in-flight DOM polls/sleeps and the store closed underneath them.
      if (this.disposing) return this.disposeAbort.signal;
      if (this.activeDriver === 'prune') return this.graph?.pruneEngine.runSignal();
      if (this.activeDriver === 'growth') return this.graph?.engine.runSignal();
      return undefined;
    };

    // The adapter owns the single Actor + Sentinel instances the whole rim shares;
    // the Reader is pure and held directly (E2 — no dead adapter.reader slot).
    const adapter = new InstagramAdapter(this.tab, {
      interactor,
      abortSignal: driverSignal,
      reporter: this.reporter,
    });
    // Log ONCE, at build, which Instagram surface capture this graph runs against.
    logger.info('foundation: instagram adapter surface', {
      adapterVersion: adapter.adapterVersion,
    });
    const actor = adapter.actor;
    const sentinel = adapter.sentinel;
    const reader = new Reader();

    // Phase A: heal external follow/unfollow drift from the SAME response
    // pipeline — every relationship-bearing body reconciles our own follow-status
    // through the store's leave-alone policy sink.
    const relationshipReconciler = new RelationshipReconciler({ store, ownPk, reader, clock });
    const relationshipReconcilerUnsub = installRelationshipReconciler(
      this.tab,
      relationshipReconciler,
    );

    // Always-on profile-info observer: ANY profile the tab loads (the startup
    // landing on our own page, dialog navigations, seed checks) answers a
    // web-profile-info request carrying follower/following counts. Store them
    // all — our OWN header counts size the scan progress bars and back the
    // census coverage guard, and other profiles enrich candidate scoring for
    // free. Passive parse of already-captured traffic; never issues requests.
    const profileInfoUnsub = this.tab.onResponse((resp) => {
      if (reader.matchEndpoint(resp.url) !== 'web-profile-info') return;
      if (resp.status >= 400 || !resp.mimeType.toLowerCase().includes('json')) return;
      resp
        .getBody()
        .then((body) => {
          const obs = reader.parseProfileInfo(body, clock.now());
          if (obs) store.observe(obs);
        })
        .catch((e: unknown) => {
          logger.warn('foundation: profile-info observe failed', { error: String(e) });
        });
    });

    const pageReader = new FollowersPageReader({
      tab: this.tab,
      reader,
      actor,
      abortSignal: driverSignal,
      reporter: this.reporter,
    });
    // The prune scan's FAST census path: direct friendships-API pagination at
    // full page size (~4× the dialog's scroll batches). The sources fall back
    // to the dialog-scroll pageReader when the direct walk cannot fetch.
    const listWalker = new ListPageWalker({
      tab: this.tab,
      reader,
      abortSignal: driverSignal,
      reporter: this.reporter,
    });

    // Growth acquisition now pages the friendships API directly (cursor-resumed,
    // demand-bounded via the walker); the dialog-scroll pageReader is its
    // fallback, and tab+reader serve the one-off seed pk-resolution fetch.
    const acquisition = new AdapterBackedAcquisition({
      pageReader,
      store,
      sentinel,
      walker: listWalker,
      tab: this.tab,
      reader,
      ownPk,
    });
    const churnActions = new AdapterBackedChurnActions({
      adapter,
      store,
      ownPk,
      dryRun: settings.dryRun,
    });

    // The prune scan's whole-followers-list scraper. Needs our username for the
    // dialog fallback path; when it could not be resolved the prune port below
    // degrades to a loud incomplete result. (The follow-back watcher no longer
    // pages this list — it reads the notifications feed instead.)
    const liveOwnFollowers = ownUsername
      ? new AdapterBackedOwnFollowersSource({
          pageReader,
          ownUsername,
          sentinel,
          store,
          walker: listWalker,
          ownPk,
        })
      : null;

    // R1: the profile enricher — the engine's pool-refill step calls this to fetch
    // follower/following counts for candidates the followers-list left count-less,
    // so scoring can actually decide (without it every candidate scores `no-counts`
    // and the pool never shrinks). Sentinel-gated and paced internally. Constructed
    // here (before the chain pieces) because the fallback target source also
    // enriches a bounded sample before ranking.
    const enricher = new AdapterBackedProfileEnricher({
      tab: this.tab,
      reader,
      store,
      sentinel,
      clock,
      abortSignal: driverSignal,
      reporter: this.reporter,
    });

    // The chain's fallback next-target chooser. The enricher is essential:
    // own followers arrive from list pages with NO counts, and ranking
    // "highest follower count" over all-unknowns used to promote an arbitrary
    // (lexicographically-smallest-pk) account as the next target.
    const ownFollowersTarget = new AdapterBackedOwnFollowersTargetSource({
      store,
      ownPk,
      enricher,
    });

    const churn = new ChurnScheduler({
      store,
      clock,
      rate,
      actions: churnActions,
      ownPk,
      cfg: toChurnConfig(settings),
    });
    // Reload catch-up: apply the timer-driven transitions (follow-back window /
    // hold expiries) that elapsed while the app was closed, BEFORE the first
    // status is projected. Store-only and idempotent — without this, records
    // whose windows lapsed offline sit in their old stages (and the queues UI
    // under-reports "due") until the engine's first step runs.
    churn.advanceTimers(clock.now());
    const scanner = new Scanner({
      store,
      scorerCfg: toScorerConfig(settings),
      cfg: toScannerConfig(settings),
    });
    // Follow-back detection reads the NOTIFICATIONS feed (one click on the
    // bell, one observed news-inbox response) — cheap enough for the hourly
    // default cadence. Sentinel-gated; a stop() interrupts the response wait.
    const followNotifications = new AdapterBackedFollowNotifications({
      tab: this.tab,
      actor: adapter.actor,
      reader,
      sentinel,
      store,
      abortSignal: driverSignal,
      reporter: this.reporter,
    });
    const followback = new FollowbackWatcher({
      store,
      clock,
      ownPk,
      notifications: followNotifications,
      cfg: toFollowbackConfig(settings),
    });

    // Live discovery over the already-harvested graph: propose the biggest
    // enriched PUBLIC hubs inside the exhausted target's audience, projected at
    // that target's realized follow-back rate — zero extra requests. The
    // ChainController's minimum-yield gate (minFollowBackRate/minPoolSize) now
    // actually decides promote-vs-fallback instead of filtering an empty stub.
    const discovery: TargetDiscovery = new StoreBackedTargetDiscovery({ store, ownPk });
    const chain = new ChainController({
      store,
      ownPk,
      discovery,
      ownFollowers: ownFollowersTarget,
      cfg: toChainConfig(settings),
    });

    // The follow-back sweep cadence, persisted through Settings so the 4h rhythm
    // survives restarts (Settings.sweepLastRunAt; same pattern as pruneLastRunAt).
    const sweepCadence = this.scheduler.cadence('engine:followback-sweep', {
      getLastRunAt: () => this.resolveSettings().sweepLastRunAt,
      setLastRunAt: (at) => {
        void this.updateSettings({ sweepLastRunAt: at });
      },
    });

    // Organic pacing model (§macro-timing-realism): a durable SessionPlanner hydrated
    // from store meta, injected ONLY when the user selected it (Settings.pacingModel).
    // Absent → the engine runs its legacy active-hours + operating-rate metronome. The
    // per-install circadian phase offset lives in the snapshot, so it is stable across
    // restarts and freshly drawn on first run.
    let pacingSnap: PlannerSnapshot | null = null;
    const pacingSnapRaw = store.getPacingState();
    if (pacingSnapRaw !== null) {
      try {
        pacingSnap = JSON.parse(pacingSnapRaw) as PlannerSnapshot;
      } catch (e) {
        logger.warn('foundation: bad pacing snapshot, starting fresh', { error: String(e) });
      }
    }
    const phaseOffset =
      pacingSnap?.phaseOffsetHours ?? samplePhaseOffset(CIRCADIAN.PHASE_JITTER_MAX_HOURS, Math.random);
    const pacing =
      settings.pacingModel === 'organic'
        ? new SessionPlanner({
            // The circadian shape follows the user's qualitative day/week choice (§5.6).
            profile: patternCircadianProfile(settings.pattern, phaseOffset),
            cfg: toPacingConfig(settings),
            snapshot: pacingSnap,
          })
        : undefined;

    // Woven prune feed (§5.2): the growth loop drains unfollows from the PruneEngine's
    // scanned census, interleaved with its follows. The PruneEngine is built after the
    // engine, so the feed delegates through a ref set once it exists (only ever CALLED
    // at run time, long after both are constructed).
    let pruneEngineRef: PruneEngine | undefined;
    const unfollowFeed: EngineUnfollowFeed = {
      nextCandidate: (now) => pruneEngineRef?.nextCandidate(now) ?? null,
      executeUnfollow: (cand, now) =>
        (pruneEngineRef as PruneEngine).executeUnfollow(cand, now),
      atDailyCap: (now) => pruneEngineRef?.atDailyCap(now) ?? true,
    };

    const engine = createEngine({
      store,
      clock,
      rate,
      sentinel,
      churn,
      scanner,
      chain,
      followback,
      acquisition,
      enricher,
      settings,
      delays,
      pacing,
      unfollowFeed,
      sweepCadence,
      onStatus: (s) => this.emit(s),
      onHalt: (reason) => {
        logger.warn('foundation: engine halted', { reason });
        // Systemic-failure triage: state decisively whether input events are
        // reaching the page (adapter/selector problem) or not (pipeline dead).
        if (reason === 'actions-failing' && typeof this.tab.probeInput === 'function') {
          void this.tab
            .probeInput()
            .then((received) => {
              if (received) {
                logger.warn(
                  'foundation: input probe OK — events reach the page; actions-failing is a page/selector issue',
                );
              } else {
                logger.error(
                  'foundation: input probe FAILED — dispatched events are NOT reaching the page',
                );
              }
            })
            .catch((e: unknown) =>
              logger.warn('foundation: input probe errored', { error: String(e) }),
            );
        }
      },
    });

    // Phase 5 — the auto-prune routine, sharing the SAME tab-backed rim
    // (pageReader / churnActions / sentinel) the growth engine uses.
    // Both scan sources degrade to a warned empty scrape when our username
    // could not be resolved (prune scans then find nothing, loudly). The scan
    // pacing (`scanMinMs`/`scanMaxMs`) + the engine's cooperative stop reach the
    // scrapes through the sources' `fetchAllPks(opts)` — see PruneScanOpts.
    // ONE stub for both sources: incomplete, never "an empty list" — a scan
    // against it must FAIL its completeness gate, not compute a zero-candidate
    // census (the two `complete:false` reasons must stay identical).
    const unresolvedUsernameSource = (what: string): { fetchAllPks(): Promise<PruneScanFetch> } => ({
      fetchAllPks: async (): Promise<PruneScanFetch> => {
        logger.warn(`foundation: own username unresolved, ${what} cannot run`);
        return { pks: [], complete: false, reason: 'own-username-unresolved' };
      },
    });
    const ownFollowingSource: PruneOwnFollowing = ownUsername
      ? new AdapterBackedOwnFollowingSource({
          pageReader,
          ownUsername,
          sentinel,
          store,
          walker: listWalker,
          ownPk,
        })
      : unresolvedUsernameSource('prune scan');
    const pruneOwnFollowers: PruneOwnFollowers =
      liveOwnFollowers ?? unresolvedUsernameSource('prune followers scan');
    const pruneEngine = createPruneEngine({
      store,
      clock,
      ownPk,
      ownFollowing: ownFollowingSource,
      ownFollowers: pruneOwnFollowers,
      churnActions,
      sentinel,
      cfg: toPruneConfig(settings),
      delays,
      lastRunAt: settings.pruneLastRunAt,
      // A run stops at the active-hours edge instead of rolling past local
      // midnight (where the daily count re-zeroes and one run could spend 2×
      // the cap). Same governor window the growth engine parks on.
      withinActiveHours: (): boolean => rate.withinActiveHours(),
      // The prune cap shares the growth budget's boundary: the active-hours
      // cycle start, not calendar midnight.
      cycleStartMs: (now: number): number => rate.cycleStartMs(now),
      onStatus: (s) => this.onPruneStatusCb?.(s),
      // Persist the completed run's timestamp through the one settings save
      // path (also reloads live configs — harmless, and keeps one write path).
      onRunComplete: (at) => {
        void this.updateSettings({ pruneLastRunAt: at });
      },
      // A scan's first act: ONE active profile-info fetch for our own account,
      // so the header counts sizing the progress bar (and backing the census
      // coverage guard) are fresh in the store — the passive observer alone
      // can miss them entirely (SPA profile loads don't always issue
      // web_profile_info).
      refreshOwnStats: ownUsername
        ? async (): Promise<void> => {
            await enricher.enrich([ownUsername]);
          }
        : undefined,
    });
    // Back the woven-feed adapter now that the PruneEngine exists.
    pruneEngineRef = pruneEngine;

    return {
      store,
      engine,
      acquisition,
      churnActions,
      actor,
      relationshipReconcilerUnsub,
      profileInfoUnsub,
      ownPk,
      ownUsername,
      clock,
      delays,
      sentinel,
      enginePromise: null,
      pruneEngine,
      prunePromise: null,
      rate,
      churn,
      scanner,
      followback,
      chain,
      pacing,
    };
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
    try {
      return shapeChainList(graph.store, graph.ownPk);
    } catch (e) {
      logger.error('foundation.chainList: failed', { error: String(e) });
      return [];
    }
  }

  /**
   * Cumulative net own-follower growth per day for the last `days` days.
   * Builds the graph if needed; returns `[]` when not logged in. Never throws.
   */
  async growthSeries(days: number): Promise<NetGrowthPoint[]> {
    const graph = await this.builtGraph();
    if (graph === null) return [];
    try {
      return graph.store.netGrowthSeries(days, graph.ownPk);
    } catch (e) {
      logger.error('foundation.growthSeries: failed', { error: String(e) });
      return [];
    }
  }

  /**
   * One-shot read-only precheck of a seed username: whether it exists and whether
   * its followers list is visible (public). Uses the surface's envelope-returning
   * profile-info fetch through the shared tab, sentinel-gated. Never
   * throws across IPC.
   */
  async checkSeed(username: string): Promise<SeedCheck> {
    // Veil: the seed check is a real in-page API fetch — requesting counts.
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
      // The surface's in-page fetch resolves to a FetchEnvelope: it never lets
      // `r.json()` reject on an HTML/error body, so a wall/rate-limit/logged-out
      // page is a TYPED outcome here — never a raw `<!DOCTYPE ...` throw.
      const raw = await this.tab.evaluate<unknown>(SURFACE.profileInfoScript(clean));
      const env = asFetchEnvelope(raw);
      if (env === null) {
        logger.warn('foundation.checkSeed: unexpected evaluate result (no envelope)', {
          username: clean,
        });
        return { ok: false, exists: false, followersVisible: false, isPrivate: false, reason: 'error' };
      }
      if (!env.ok) {
        // Classify the refusal: a login/challenge redirect means our session,
        // not the seed; an HTML page on an API URL is an IG wall; a 404 is a
        // genuinely missing user. All are WARN-level typed outcomes.
        const wall = env.finalUrl
          ? SURFACE.blockSignatures.find((sig) => sig.pattern.test(env.finalUrl as string))
          : undefined;
        const reason =
          wall?.status === 'logged-out'
            ? 'logged-out'
            : wall !== undefined || envelopeLooksLikeHtml(env)
              ? 'blocked'
              : env.status === 404
                ? 'not-found'
                : 'error';
        logger.warn('foundation.checkSeed: non-ok profile response', {
          username: clean,
          status: env.status,
          contentType: env.contentType,
          reason,
        });
        return { ok: false, exists: false, followersVisible: false, isPrivate: false, reason };
      }

      const obs = SURFACE.extractProfileInfo(env.json, graph.clock.now());
      if (isShapeMismatch(obs)) {
        // Valid JSON but not the shape we know — surface drift, not an error state.
        logger.warn('foundation.checkSeed: unexpected profile body shape', { username: clean });
        return { ok: false, exists: false, followersVisible: false, isPrivate: false, reason: 'error' };
      }
      if (obs === null) {
        return { ok: false, exists: false, followersVisible: false, isPrivate: false, reason: 'not-found' };
      }
      // FACTS STREAM (docs/PRINCIPLES.md §1): this check paid for a real
      // profile read — keep it. The counts/flags become an accounts row the
      // scorer and target sources can use, whether or not the seed is adopted.
      graph.store.observe(obs);
      const isPrivate = obs.fields.isPrivate === true;
      // A private account's followers are viewable iff we already follow it.
      const followedByViewer = SURFACE.extractProfileFollowedByViewer(env.json) === true;
      const followersVisible = !isPrivate || followedByViewer;
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
    const wasTearing = this.tearingDown;
    this.tearingDown = true;
    try {
      // A build already past the ensureBuilt gate keeps running on the OLD
      // identity — let it settle first so the teardown below tears down whatever
      // it produced instead of racing it.
      if (this.buildPromise !== null) {
        try {
          await this.buildPromise;
        } catch (e) {
          logger.warn('foundation.clearData: in-flight build rejected during wipe', {
            error: String(e),
          });
        }
      }
      await this.teardownGraph();

      const dbBase = path.join(app.getPath('userData'), IG_DB_FILE);
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
        const igSession = session.fromPartition(IG_PARTITION);
        await igSession.clearStorageData();
        await igSession.clearCache();
      } catch (e) {
        logger.error('foundation.clearData: failed to clear IG session', { error: String(e) });
      }
    } finally {
      this.tearingDown = wasTearing;
    }

    // Forget the cached identity + any in-flight build; `disposing` stays false so
    // the next login can rebuild.
    this.ownPkCache = null;
    this.buildPromise = null;

    void this.tab.goto(IG_HOME_URL);

    const s = await this.status();
    this.onStatusCb?.(s);
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
    return path.join(app.getPath('userData'), IG_SETTINGS_FILE);
  }

  // -------------------------------------------------------------------------
  // Identity resolution
  // -------------------------------------------------------------------------

  /**
   * The logged-in account's numeric pk, read from the persistent session's
   * `ds_user_id` cookie (that value IS the account pk). The cookie is re-read on
   * every call (a cheap partition lookup) so an IN-TAB ACCOUNT SWITCH is caught:
   * a graph anchored to the old pk would write every edge/ledger row against the
   * wrong account. On a detected switch the stale graph is torn down; the next
   * `ensureBuilt` rebuilds for the new identity. A transiently ABSENT or
   * unreadable cookie keeps the cached identity — a navigation blip must not
   * flap a live graph (a real logout parks via the sentinel).
   */
  private async resolveOwnPk(): Promise<string | null> {
    try {
      const cookies = await session
        .fromPartition(IG_PARTITION)
        .cookies.get({ name: 'ds_user_id' });
      const cookie = cookies.find((c) => c.value.length > 0);
      if (cookie === undefined) return this.ownPkCache;
      if (this.ownPkCache !== null && this.ownPkCache !== cookie.value) {
        logger.warn('foundation: ds_user_id changed (account switch), tearing down stale graph', {
          from: this.ownPkCache,
          to: cookie.value,
        });
        await this.teardownGraph();
      }
      this.ownPkCache = cookie.value;
      return cookie.value;
    } catch (e) {
      logger.warn('foundation.resolveOwnPk: cookie read failed', { error: String(e) });
      return this.ownPkCache;
    }
  }

  /**
   * Best-effort own username via the private `current_user` endpoint (the pinned
   * desktop UA lets this JSON API answer). Returns `undefined` on persistent
   * failure so own-followers features degrade gracefully rather than breaking the
   * build.
   *
   * R5 — robust against the startup race: the private JSON API only answers once a
   * real instagram.com page is loaded and the session is warm. So we first ensure
   * the tab is on instagram.com (navigating home if not), then retry the fetch a
   * few times with short waits. Nothing is cached on failure — a later call (after
   * the user finishes logging in) can still resolve it.
   */
  private async resolveOwnUsername(): Promise<string | undefined> {
    // Robust resolution: nav profile-link href / profile navigation first, the
    // unreliable `current_user` endpoint only as a last resort (see identity.ts).
    return resolveUsernameFromTab(this.tab, {
      attempts: SCHEDULER.USERNAME_RESOLVE_ATTEMPTS,
      retryMs: SCHEDULER.USERNAME_RESOLVE_RETRY_MS,
      signal: this.disposeAbort.signal,
    });
  }

  // -------------------------------------------------------------------------
  // Status projection helpers
  // -------------------------------------------------------------------------

  private emit(status: EngineStatus): void {
    // Veil state machine: the growth loop holds the veil exactly while RUNNING
    // (paused/idle/halted release it — a parked engine issues no requests). The
    // signal is level-triggered, then the start bridge retires on the first
    // emit — in that order, so the hand-off never dips the veil.
    this.activity.signal('growth-loop', status.state === 'running');
    this.releaseGrowthStartBridge();
    this.onStatusCb?.({ ...status, loggedIn: this.graph !== null });
  }

  /** Retire the `growth-start` bridge hold (idempotent; see {@link startEngine}). */
  private releaseGrowthStartBridge(): void {
    if (!this.pendingGrowthStart) return;
    this.pendingGrowthStart = false;
    this.activity.release('growth-start');
  }

  private builtStatus(): EpoStatus {
    // Only called when `this.graph` is set (post-build).
    const graph = this.graph;
    if (graph === null) return this.notBuiltStatus(true);
    return { ...graph.engine.status(), loggedIn: true };
  }

  private notBuiltPruneStatus(): PruneStatus {
    const s = this.resolveSettings();
    return {
      state: 'idle',
      following: 0,
      followers: 0,
      candidates: 0,
      unfollowed: 0,
      remaining: 0,
      dailyDone: 0,
      dailyLimit: s.pruneDailyLimit,
      lastRunAt: s.pruneLastRunAt,
      lastSentinel: null,
      nextActionAt: null,
      scanReady: false,
      scanPhase: null,
      scanAt: null,
      scanEstimates: null,
      graph: { following: 0, followers: 0, notFollowingBack: 0 },
    };
  }

  private notBuiltStatus(loggedIn: boolean): EpoStatus {
    return {
      state: 'idle',
      currentTargetPk: null,
      currentTargetUsername: null,
      chainIndex: null,
      actionsToday: 0,
      remainingToday: 0,
      plannedToday: 0,
      atHardCeiling: false,
      queued: 0,
      pendingFollowback: 0,
      followedBackHeld: 0,
      unfollowDue: 0,
      lastStep: null,
      lastSentinel: null,
      lastActionAt: null,
      sessionStartedAt: null,
      nextActionAt: null,
      netToday: 0,
      online: this.lastOnline,
      haltReason: null,
      pacing: null,
      loggedIn,
    };
  }
}
