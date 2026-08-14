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
import { Reader } from '@/adapter/reader';
import type { Sentinel } from '@/adapter/sentinel';
import { resolveOwnUsername as resolveUsernameFromTab } from '@/adapter/identity';
import { KnowledgeStore } from '@/store/knowledge-store';
import { SystemClock } from '@/governors/clock';
import { ScheduleManager } from '@/timing/schedule-manager';
import { DelayManager } from '@/timing/delay-manager';
import { PRUNE, SCHEDULER } from '@/timing/config';
import { RateGovernor } from '@/governors/rate-governor';
import { RequestBudget } from '@/governors/request-budget';
import { shapeChainList, shapeQueueList } from '@/main/foundation-reads';
import { installRequestMetering } from '@/rim/request-metering';
import {
  RelationshipReconciler,
  installRelationshipReconciler,
} from '@/rim/relationship-reconciler';
import { FollowersPageReader } from '@/rim/followers-page-reader';
import { AdapterBackedAcquisition } from '@/rim/follower-acquisition';
import { AdapterBackedChurnActions } from '@/rim/churn-actions';
import { AdapterBackedOwnFollowersSource } from '@/rim/own-followers-source';
import { AdapterBackedOwnFollowingSource } from '@/rim/own-following-source';
import { AdapterBackedOwnFollowersTargetSource } from '@/rim/own-followers-target-source';
import { AdapterBackedProfileEnricher } from '@/rim/profile-enricher';
import {
  SURFACE,
  asFetchEnvelope,
  envelopeLooksLikeHtml,
  isShapeMismatch,
} from '@/adapter/ig-surface';
import { ChurnScheduler, type ChurnActionOutcome } from '@/engine/churn-scheduler';
import { Scanner } from '@/engine/scanner';
import { FollowbackWatcher, type OwnFollowersSource } from '@/engine/followback-watcher';
import { ChainController, type TargetDiscovery } from '@/engine/chain-controller';
import { createEngine, type Engine, type EngineStatus } from '@/engine/engine';
import {
  createPruneEngine,
  pruneDue,
  type PruneEngine,
  type PruneOwnFollowers,
  type PruneOwnFollowing,
  type PruneStatus,
} from '@/engine/prune-engine';
import type { FollowerAcquisition } from '@/rim/types';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  toRateGovernorConfig,
  toRequestBudgetConfig,
  toChurnConfig,
  toScorerConfig,
  toScannerConfig,
  toFollowbackConfig,
  toChainConfig,
  toPruneConfig,
  type Settings,
} from '@/settings/settings';
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
}

/** The lazily-built dependency graph, cached once `ownPk` is resolvable. */
interface BuiltGraph {
  store: KnowledgeStore;
  engine: Engine;
  acquisition: FollowerAcquisition;
  churnActions: AdapterBackedChurnActions;
  requestMeteringUnsub: () => void;
  /** Disposer for the passive relationship reconciler (Phase A). */
  relationshipReconcilerUnsub: () => void;
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
  budget: RequestBudget;
  churn: ChurnScheduler;
  scanner: Scanner;
  followback: FollowbackWatcher;
  chain: ChainController;
}

export class Foundation {
  private readonly tab: InstagramTab;
  private readonly onStatusCb?: (status: EpoStatus) => void;
  private readonly onPruneStatusCb?: (status: PruneStatus) => void;
  private graph: BuiltGraph | null = null;
  /**
   * The TAB DRIVER TOKEN (Phase 5 mutual exclusion): which automated routine
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
   * Last connectivity reported by the ConnectivityMonitor. Kept here (not only in
   * the Engine) so the not-built status can still reflect it.
   */
  private lastOnline = true;
  /** The one ScheduleManager for Foundation-level periodic work + cadences. */
  private readonly scheduler = new ScheduleManager({ clock: new SystemClock() });
  /** Aborted once {@link dispose} begins — interrupts identity-resolution waits. */
  private readonly disposeAbort = new AbortController();

  constructor(deps: FoundationDeps) {
    this.tab = deps.tab;
    this.onStatusCb = deps.onStatus;
    this.onPruneStatusCb = deps.onPruneStatus;
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
    // Shutting down: never (re)build — let reads resolve to safe empties instead
    // of re-navigating the tab or re-opening the store mid-teardown.
    if (this.disposing) return false;
    // Fully built (with a real username): nothing more to do.
    if (this.graph !== null && this.graph.ownUsername !== undefined) return true;
    // Coalesce concurrent builds/retries onto a single in-flight promise (f6).
    if (this.buildPromise !== null) return this.buildPromise;
    this.buildPromise = this.buildOrRetry().finally(() => {
      this.buildPromise = null;
    });
    return this.buildPromise;
  }

  /**
   * The memoized body of {@link ensureBuilt}. Resolves `ownPk` (required) and
   * `ownUsername` (best-effort, retried — R5). Builds the graph on first success;
   * on a later call, rebuilds a previously-degraded graph only once the username
   * recovers AND the engine is not mid-run (so a live loop is never torn out).
   */
  private async buildOrRetry(): Promise<boolean> {
    const ownPk = await this.resolveOwnPk();
    if (ownPk === null) return false;
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
      this.teardownGraph();
    }

    this.graph = this.build(ownPk, ownUsername);
    logger.info('foundation: dependency graph built', {
      ownPk,
      ownUsername: ownUsername ?? '(unknown)',
    });
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
    await this.ensureBuilt();
    return this.status();
  }

  // -------------------------------------------------------------------------
  // Engine controls (build-if-needed)
  // -------------------------------------------------------------------------

  /** Start the automated loop — fire-and-forget (never awaits the loop). */
  async startEngine(): Promise<EpoStatus> {
    if (!(await this.ensureBuilt()) || this.graph === null) {
      return this.notBuiltStatus(await this.isLoggedIn());
    }
    // Mutual exclusion (Phase 5): the prune routine holds the tab driver token —
    // never put a second driver on the one shared tab. Typed refusal, no start.
    if (this.activeDriver === 'prune') {
      logger.warn('foundation.startEngine: prune active, refusing engine start');
      return this.builtStatus();
    }
    const state = this.graph.engine.status().state;
    if (state === 'running' || state === 'paused') {
      // Already the active driver — a second start is the Engine's own no-op.
      return this.builtStatus();
    }
    this.activeDriver = 'growth';
    // Fire-and-forget: `start()` resolves only when the loop exits; do NOT await
    // here. f14: keep the loop promise so `dispose()` can await its exit before
    // closing the store (a mid-step store call must not hit a closed DB).
    const loop = this.graph.engine
      .start()
      .catch((e: unknown) => {
        logger.error('foundation: engine loop errored', { error: String(e) });
      })
      .finally(() => {
        if (this.activeDriver === 'growth') this.activeDriver = null;
      });
    this.graph.enginePromise = loop;
    return this.builtStatus();
  }

  /** Pause the engine between actions. */
  async pauseEngine(): Promise<EpoStatus> {
    if (!(await this.ensureBuilt()) || this.graph === null) {
      return this.notBuiltStatus(await this.isLoggedIn());
    }
    this.graph.engine.pause();
    return this.builtStatus();
  }

  /** Resume a paused engine. */
  async resumeEngine(): Promise<EpoStatus> {
    if (!(await this.ensureBuilt()) || this.graph === null) {
      return this.notBuiltStatus(await this.isLoggedIn());
    }
    // Mutual exclusion (Phase 5): a prune holds the tab — resuming growth now
    // would put a second driver on it. Refuse; the prune's completion resumes
    // growth itself when it was the one that paused it (leave-alone otherwise).
    if (this.activeDriver === 'prune') {
      logger.warn('foundation.resumeEngine: prune active, refusing resume');
      return this.builtStatus();
    }
    this.graph.engine.resume();
    return this.builtStatus();
  }

  /** Stop the engine loop (aborts in-flight sleeps). */
  async stopEngine(): Promise<EpoStatus> {
    if (!(await this.ensureBuilt()) || this.graph === null) {
      return this.notBuiltStatus(await this.isLoggedIn());
    }
    this.graph.engine.stop();
    return this.builtStatus();
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
  async scanPrune(): Promise<PruneScanResult> {
    const empty = { following: 0, followers: 0, candidates: [] };
    if (!(await this.ensureBuilt()) || this.graph === null) {
      return { ok: false, reason: 'not-logged-in', ...empty };
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
      const result = await this.graph.pruneEngine.scan();
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
    if (!(await this.ensureBuilt()) || this.graph === null) {
      return { ok: false, reason: 'not-logged-in', status: this.notBuiltPruneStatus() };
    }
    const graph = this.graph;
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
      });
    graph.prunePromise = run;
    return { ok: true, status: graph.pruneEngine.status() };
  }

  /**
   * Stop an active prune scan/run: aborts in-flight sleeps between actions AND
   * breaks a mid-scan scroll loop between rounds, so `scanPrune`/`startPrune`
   * resolve promptly and the tab is left clean.
   */
  async stopPrune(): Promise<PruneStatus> {
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
    if (engine.status().state !== 'running') return true; // tab already free
    logger.info('foundation: pausing growth engine for prune hand-off');
    engine.pause();
    this.growthPausedForPrune = true;
    const parked = await engine.awaitParked(PRUNE.PARK_TIMEOUT_MS);
    if (!parked) {
      logger.warn('foundation: growth did not park in time, aborting prune hand-off');
      this.releaseTabAfterPrune(); // undo our pause — resume growth
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

  /** Read a target's followers into the knowledge graph via the shared rim. */
  async readFollowers(target: string): Promise<ReadFollowersResult> {
    if (!(await this.ensureBuilt()) || this.graph === null) {
      logger.warn('foundation.readFollowers: not logged in, skipping', { target });
      return { target, observed: 0, ok: false, reason: 'not-logged-in' };
    }
    // R3: refuse manual reads while an automated driver runs — a second
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
      const { observed } = await this.graph.acquisition.acquire(target);
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
    if (!(await this.ensureBuilt()) || this.graph === null) {
      logger.warn('foundation.act: not logged in, skipping', { action, username });
      return { ok: false, username, reason: 'not-logged-in' };
    }
    const graph = this.graph;

    // R3: refuse manual actions while an automated driver runs — sharing the tab
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
      // R4: the rim returns a discriminated outcome (it does its own budget/sentinel
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
   *  - `'blocked'`   → budget/sentinel closed before any click: NO ledger — failure.
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
        logger.warn('foundation.act: manual action blocked (budget/sentinel), no ledger', {
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
   * Best-effort numeric pk for a manually-actioned username. Identity is the pk, but
   * the manual IPC path only carries a username and the store exposes no reverse
   * username→pk index, so this is `undefined` today. Kept as an explicit seam: the
   * ledger falls back to the username key (still counted by the ceiling) and the
   * directed edge is written only when a pk is available.
   */
  private manualActionPk(_username: string): string | undefined {
    return undefined;
  }

  /** True while the built engine's loop is actively running (R3 serialization gate). */
  private isEngineRunning(): boolean {
    return this.graph !== null && this.graph.engine.status().state === 'running';
  }

  /**
   * Why a MANUAL op may not touch the tab now (R3): the growth loop is running,
   * or the prune routine holds the driver token. Null when the tab is free.
   */
  private busyDriverReason(): string | null {
    if (this.isEngineRunning()) return 'engine-running';
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
    this.scheduler.every(
      'prune:auto-watcher',
      intervalMs,
      () => this.maybeRunScheduledPrune(),
      { unref: true },
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
    if (!(await this.ensureBuilt()) || this.graph === null) return;
    const settings = this.resolveSettings();
    if (!pruneDue(settings.pruneScheduleDays, settings.pruneLastRunAt, this.graph.clock.now())) {
      return;
    }
    // Re-check the driver token after the await: never contend with a prune that
    // started in the meantime. (Growth running is fine — startPrune hands it off.)
    if (this.activeDriver !== null) return;
    if (!this.graph.rate.withinActiveHours()) return;
    logger.info('foundation: scheduled prune due, auto-starting', {
      scheduleDays: settings.pruneScheduleDays,
      lastRunAt: settings.pruneLastRunAt,
      growthState: this.graph.engine.status().state,
    });
    void this.startPrune();
  }

  /**
   * Tear down the current graph (if any): stop the engine, await its loop, remove
   * the metering + reconciler subscriptions, and close the store — in that order
   * (f14). Shared by
   * {@link dispose} and the R5 rebuild path. A no-op when nothing is built.
   */
  private async teardownGraph(): Promise<void> {
    const graph = this.graph;
    if (graph === null) return;
    this.graph = null;
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
    graph.requestMeteringUnsub();
    graph.relationshipReconcilerUnsub();
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
    const budget = new RequestBudget(store, clock, toRequestBudgetConfig(settings));

    // The ACTIVE driver's run token: adapter/rim waits link to this so a stop()
    // interrupts an in-flight DOM poll or pacing sleep instead of sitting out
    // its timeout. Pause is deliberately NOT included — a paused step finishes
    // cleanly (the park/hand-off contract is unchanged).
    const driverSignal = (): AbortSignal | undefined => {
      if (this.activeDriver === 'prune') return this.graph?.pruneEngine.runSignal();
      if (this.activeDriver === 'growth') return this.graph?.engine.runSignal();
      return undefined;
    };

    // The adapter owns the single Actor + Sentinel instances the whole rim shares;
    // the Reader is pure and held directly (E2 — no dead adapter.reader slot).
    const adapter = new InstagramAdapter(this.tab, { abortSignal: driverSignal });
    // Log ONCE, at build, which Instagram surface capture this graph runs against.
    logger.info('foundation: instagram adapter surface', {
      adapterVersion: adapter.adapterVersion,
    });
    const actor = adapter.actor;
    const sentinel = adapter.sentinel;
    const reader = new Reader();

    // R2: one budget spend per real IG response, from the tab's onResponse pipeline.
    const requestMeteringUnsub = installRequestMetering(this.tab, budget, reader);

    // Phase A: heal external follow/unfollow drift from the SAME response
    // pipeline — every relationship-bearing body reconciles our own follow-status
    // through the store's leave-alone policy sink.
    const relationshipReconciler = new RelationshipReconciler({ store, ownPk, reader, clock });
    const relationshipReconcilerUnsub = installRelationshipReconciler(
      this.tab,
      relationshipReconciler,
    );

    const pageReader = new FollowersPageReader({
      tab: this.tab,
      reader,
      actor,
      abortSignal: driverSignal,
    });

    const acquisition = new AdapterBackedAcquisition({
      pageReader,
      store,
      budget,
      sentinel,
      ownPk,
    });
    const churnActions = new AdapterBackedChurnActions({
      adapter,
      budget,
      store,
      ownPk,
      dryRun: settings.dryRun,
    });

    // Own-followers source needs our username; degrade gracefully to an empty
    // source when it could not be resolved (follow-back sweeps then no-op).
    // f11: pass `store` so the sweep's parsed follower profiles are persisted as
    // real `accounts` rows the own-followers fallback target-source can rank.
    // The live instance also serves the prune scan's whole-list followers port
    // (`fetchAllPks`) — one scraper, two ports (see the prune wiring below).
    const liveOwnFollowers = ownUsername
      ? new AdapterBackedOwnFollowersSource({ pageReader, ownUsername, budget, sentinel, store })
      : null;
    const ownFollowersSource: OwnFollowersSource = liveOwnFollowers ?? {
      nextPage: async () => ({ pks: [], cursor: null, hasMore: false }),
    };
    const ownFollowersTarget = new AdapterBackedOwnFollowersTargetSource({ store, ownPk });

    const churn = new ChurnScheduler({
      store,
      clock,
      rate,
      actions: churnActions,
      ownPk,
      cfg: toChurnConfig(settings),
    });
    const scanner = new Scanner({
      store,
      scorerCfg: toScorerConfig(settings),
      cfg: toScannerConfig(settings),
    });
    const followback = new FollowbackWatcher({
      store,
      clock,
      ownPk,
      followers: ownFollowersSource,
      cfg: toFollowbackConfig(settings),
    });

    // Real discovery is deferred (arch §7); the own-followers fallback carries the chain.
    const discovery: TargetDiscovery = { discover: async () => [] };
    const chain = new ChainController({
      store,
      ownPk,
      discovery,
      ownFollowers: ownFollowersTarget,
      cfg: toChainConfig(settings),
    });

    // R1: the profile enricher — the engine's pool-refill step calls this to fetch
    // follower/following counts for candidates the followers-list left count-less,
    // so scoring can actually decide (without it every candidate scores `no-counts`
    // and the pool never shrinks). Budget/sentinel-gated and paced internally.
    const enricher = new AdapterBackedProfileEnricher({
      tab: this.tab,
      reader,
      store,
      budget,
      sentinel,
      clock,
      abortSignal: driverSignal,
    });

    // The follow-back sweep cadence, persisted through Settings so the 4h rhythm
    // survives restarts (Settings.sweepLastRunAt; same pattern as pruneLastRunAt).
    const sweepCadence = this.scheduler.cadence('engine:followback-sweep', {
      getLastRunAt: () => this.resolveSettings().sweepLastRunAt,
      setLastRunAt: (at) => {
        void this.updateSettings({ sweepLastRunAt: at });
      },
    });

    const engine = createEngine({
      store,
      clock,
      rate,
      requestBudget: budget,
      sentinel,
      churn,
      scanner,
      chain,
      followback,
      acquisition,
      enricher,
      settings,
      delays,
      sweepCadence,
      onStatus: (s) => this.emit(s),
      onHalt: (reason) => {
        logger.warn('foundation: engine halted', { reason });
      },
    });

    // Phase 5 — the auto-prune routine, sharing the SAME tab-backed rim
    // (pageReader / churnActions / budget / sentinel) the growth engine uses.
    // Both scan sources degrade to a warned empty scrape when our username
    // could not be resolved (prune scans then find nothing, loudly). The scan
    // pacing (`scanMinMs`/`scanMaxMs`) + the engine's cooperative stop reach the
    // scrapes through the sources' `fetchAllPks(opts)` — see PruneScanOpts.
    const ownFollowingSource: PruneOwnFollowing = ownUsername
      ? new AdapterBackedOwnFollowingSource({ pageReader, ownUsername, budget, sentinel, store })
      : {
          fetchAllPks: async (): Promise<string[]> => {
            logger.warn('foundation: own username unresolved, prune scan yields nothing');
            return [];
          },
        };
    const pruneOwnFollowers: PruneOwnFollowers = liveOwnFollowers ?? {
      fetchAllPks: async (): Promise<string[]> => {
        logger.warn('foundation: own username unresolved, prune followers scan yields nothing');
        return [];
      },
    };
    const pruneEngine = createPruneEngine({
      store,
      clock,
      ownPk,
      ownFollowing: ownFollowingSource,
      ownFollowers: pruneOwnFollowers,
      churnActions,
      requestBudget: budget,
      sentinel,
      cfg: toPruneConfig(settings),
      delays,
      lastRunAt: settings.pruneLastRunAt,
      onStatus: (s) => this.onPruneStatusCb?.(s),
      // Persist the completed run's timestamp through the one settings save
      // path (also reloads live configs — harmless, and keeps one write path).
      onRunComplete: (at) => {
        void this.updateSettings({ pruneLastRunAt: at });
      },
    });

    return {
      store,
      engine,
      acquisition,
      churnActions,
      requestMeteringUnsub,
      relationshipReconcilerUnsub,
      ownPk,
      ownUsername,
      clock,
      delays,
      sentinel,
      enginePromise: null,
      pruneEngine,
      prunePromise: null,
      rate,
      budget,
      churn,
      scanner,
      followback,
      chain,
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
    if (!(await this.ensureBuilt()) || this.graph === null) return [];
    try {
      return shapeChainList(this.graph.store, this.graph.ownPk);
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
    if (!(await this.ensureBuilt()) || this.graph === null) return [];
    try {
      return this.graph.store.netGrowthSeries(days, this.graph.ownPk);
    } catch (e) {
      logger.error('foundation.growthSeries: failed', { error: String(e) });
      return [];
    }
  }

  /**
   * One-shot read-only precheck of a seed username: whether it exists and whether
   * its followers list is visible (public). Uses the surface's envelope-returning
   * profile-info fetch through the shared tab, budget- and sentinel-gated. Never
   * throws across IPC.
   */
  async checkSeed(username: string): Promise<SeedCheck> {
    if (!(await this.ensureBuilt()) || this.graph === null) {
      return { ok: false, exists: false, followersVisible: false, isPrivate: false, reason: 'not-logged-in' };
    }
    // R3: refuse while a driver runs — a concurrent one-shot fetch competes with
    // that driver's own IG traffic and its budget/sentinel gating.
    const busy = this.busyDriverReason();
    if (busy !== null) {
      return { ok: false, exists: false, followersVisible: false, isPrivate: false, reason: busy };
    }
    try {
      const clean = username.trim().replace(/^@/, '');
      if (!clean) return { ok: false, exists: false, followersVisible: false, isPrivate: false, reason: 'empty' };
      if (!this.graph.budget.canSpend()) {
        return { ok: false, exists: false, followersVisible: false, isPrivate: false, reason: 'budget' };
      }
      if ((await this.graph.sentinel.check()) !== 'ok') {
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

      const obs = SURFACE.extractProfileInfo(env.json, this.graph.clock.now());
      if (isShapeMismatch(obs)) {
        // Valid JSON but not the shape we know — surface drift, not an error state.
        logger.warn('foundation.checkSeed: unexpected profile body shape', { username: clean });
        return { ok: false, exists: false, followersVisible: false, isPrivate: false, reason: 'error' };
      }
      if (obs === null) {
        return { ok: false, exists: false, followersVisible: false, isPrivate: false, reason: 'not-found' };
      }
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
    if (!(await this.ensureBuilt()) || this.graph === null) {
      return { rows: [], truncated: false };
    }
    try {
      return shapeQueueList(this.graph.store, state);
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
    const next: Settings = { ...this.resolveSettings(), ...partial };
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
    g.budget.applyConfig(toRequestBudgetConfig(s));
    g.churn.applyConfig(toChurnConfig(s));
    g.scanner.applyConfig(toScannerConfig(s), toScorerConfig(s));
    g.followback.applyConfig(toFollowbackConfig(s));
    g.chain.applyConfig(toChainConfig(s));
    g.pruneEngine.applyConfig(toPruneConfig(s));
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
   * `ds_user_id` cookie (that value IS the account pk). Cached once resolved.
   */
  private async resolveOwnPk(): Promise<string | null> {
    if (this.ownPkCache) return this.ownPkCache;
    try {
      const cookies = await session
        .fromPartition(IG_PARTITION)
        .cookies.get({ name: 'ds_user_id' });
      const cookie = cookies.find((c) => c.value.length > 0);
      if (cookie) {
        this.ownPkCache = cookie.value;
        return cookie.value;
      }
      return null;
    } catch (e) {
      logger.warn('foundation.resolveOwnPk: cookie read failed', { error: String(e) });
      return null;
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
    this.onStatusCb?.({ ...status, loggedIn: this.graph !== null });
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
      atHardCeiling: false,
      requestBudgetRemaining: 0,
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
      loggedIn,
    };
  }
}
