/**
 * Foundation — the Peanut v3 composition root (Wave 4).
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
import * as path from 'path';

import { InstagramTab, IG_HOME_URL, IG_PARTITION } from '@/adapter/tab';
import { InstagramAdapter } from '@/adapter/instagram-adapter';
import { Reader } from '@/adapter/reader';
import { resolveOwnUsername as resolveUsernameFromTab } from '@/adapter/identity';
import { KnowledgeStore } from '@/store/knowledge-store';
import { SystemClock } from '@/governors/clock';
import { RateGovernor } from '@/governors/rate-governor';
import { RequestBudget } from '@/governors/request-budget';
import { shapeChainList, shapeQueueList } from '@/main/foundation-reads';
import { installRequestMetering } from '@/rim/request-metering';
import { FollowersPageReader } from '@/rim/followers-page-reader';
import { AdapterBackedAcquisition } from '@/rim/follower-acquisition';
import { AdapterBackedChurnActions } from '@/rim/churn-actions';
import { AdapterBackedOwnFollowersSource } from '@/rim/own-followers-source';
import { AdapterBackedOwnFollowersTargetSource } from '@/rim/own-followers-target-source';
import { AdapterBackedProfileEnricher } from '@/rim/profile-enricher';
import { ChurnScheduler } from '@/engine/churn-scheduler';
import { Scanner } from '@/engine/scanner';
import { FollowbackWatcher, type OwnFollowersSource } from '@/engine/followback-watcher';
import { ChainController, type TargetDiscovery } from '@/engine/chain-controller';
import { createEngine, type Engine, type EngineStatus } from '@/engine/engine';
import type { FollowerAcquisition } from '@/rim/types';
import {
  loadSettings,
  saveSettings,
  toRateGovernorConfig,
  toRequestBudgetConfig,
  toChurnConfig,
  toScorerConfig,
  toScannerConfig,
  toFollowbackConfig,
  toChainConfig,
  type Settings,
} from '@/settings/settings';
import * as logger from '@/utils/logger';
import type {
  ActionResult,
  ChainTargetView,
  FollowState,
  PeanutStatus,
  QueueListResult,
  ReadFollowersResult,
} from '@/types';

const IG_DB_FILE = 'peanut.db';
const IG_SETTINGS_FILE = 'peanut-settings.json';
/** Instagram's public web app id — required for the private JSON API to answer. */
const IG_APP_ID = '936619743392459';

/** R5 — how many times to poll `current_user` before degrading, and the wait between. */
const USERNAME_RESOLVE_ATTEMPTS = 4;
const USERNAME_RESOLVE_RETRY_MS = 1_500;

/** A plain promise sleep (composition-root only; the Engine owns interruptible waits). */
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface FoundationDeps {
  tab: InstagramTab;
  /** Push each fresh status projection to the renderer (main wires this to IPC). */
  onStatus?: (status: PeanutStatus) => void;
}

/** The lazily-built dependency graph, cached once `ownPk` is resolvable. */
interface BuiltGraph {
  store: KnowledgeStore;
  engine: Engine;
  acquisition: FollowerAcquisition;
  churnActions: AdapterBackedChurnActions;
  requestMeteringUnsub: () => void;
  ownPk: string;
  /** Our own username at build time, or `undefined` when it could not be resolved. */
  ownUsername: string | undefined;
  /** The single clock the graph shares — used to timestamp manual-op ledger rows. */
  clock: SystemClock;
  /**
   * The loop promise returned by the most recent `engine.start()`, kept so
   * `dispose()` can await the loop's exit before closing the store (f14). Null
   * until the engine is first started.
   */
  enginePromise: Promise<void> | null;
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
  private readonly onStatusCb?: (status: PeanutStatus) => void;
  private graph: BuiltGraph | null = null;
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

  constructor(deps: FoundationDeps) {
    this.tab = deps.tab;
    this.onStatusCb = deps.onStatus;
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
  async login(): Promise<PeanutStatus> {
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
  async startEngine(): Promise<PeanutStatus> {
    if (!(await this.ensureBuilt()) || this.graph === null) {
      return this.notBuiltStatus(await this.isLoggedIn());
    }
    // Fire-and-forget: `start()` resolves only when the loop exits; do NOT await
    // here. f14: keep the loop promise so `dispose()` can await its exit before
    // closing the store (a mid-step store call must not hit a closed DB).
    const loop = this.graph.engine.start().catch((e: unknown) => {
      logger.error('foundation: engine loop errored', { error: String(e) });
    });
    this.graph.enginePromise = loop;
    return this.builtStatus();
  }

  /** Pause the engine between actions. */
  async pauseEngine(): Promise<PeanutStatus> {
    if (!(await this.ensureBuilt()) || this.graph === null) {
      return this.notBuiltStatus(await this.isLoggedIn());
    }
    this.graph.engine.pause();
    return this.builtStatus();
  }

  /** Resume a paused engine. */
  async resumeEngine(): Promise<PeanutStatus> {
    if (!(await this.ensureBuilt()) || this.graph === null) {
      return this.notBuiltStatus(await this.isLoggedIn());
    }
    this.graph.engine.resume();
    return this.builtStatus();
  }

  /** Stop the engine loop (aborts in-flight sleeps). */
  async stopEngine(): Promise<PeanutStatus> {
    if (!(await this.ensureBuilt()) || this.graph === null) {
      return this.notBuiltStatus(await this.isLoggedIn());
    }
    this.graph.engine.stop();
    return this.builtStatus();
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
    // R3: refuse manual reads while the engine runs — a second concurrent
    // `collect()` subscription on the shared tab's onResponse stream would let one
    // target ingest another's follower pages (corrupt edges).
    if (this.isEngineRunning()) {
      logger.warn('foundation.readFollowers: engine running, refusing manual read', { target });
      return { target, observed: 0, ok: false, reason: 'engine-running' };
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

    // R3: refuse manual actions while the engine loop runs — sharing the tab would
    // race the engine's own navigations/actions on one WebContents.
    if (this.isEngineRunning()) {
      logger.warn('foundation.act: engine running, refusing manual action', { action, username });
      return { ok: false, username, reason: 'engine-running' };
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
      const { status } =
        action === 'follow'
          ? await graph.churnActions.follow(username)
          : await graph.churnActions.unfollow(username);
      return this.recordManualOutcome(graph, action, username, status);
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
    status: 'ok' | 'failed' | 'blocked' | 'simulated',
  ): ActionResult {
    const now = graph.clock.now();
    const pk = this.manualActionPk(username);
    const ledgerKey = pk ?? username;

    switch (status) {
      case 'ok':
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

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  /** Engine status when built; a minimal idle status otherwise. */
  async status(): Promise<PeanutStatus> {
    if (this.graph) return this.builtStatus();
    return this.notBuiltStatus(await this.isLoggedIn());
  }

  /**
   * Close the engine + store on window teardown. Idempotent.
   *
   * f14 — ordering matters: stop the engine, AWAIT the loop's exit (so no step is
   * mid-flight), drop the request-metering subscription, then close the store. A
   * store call from a still-running step must never hit a closed DB.
   */
  async dispose(): Promise<void> {
    await this.teardownGraph();
    logger.info('foundation disposed');
  }

  /**
   * Tear down the current graph (if any): stop the engine, await its loop, remove
   * the metering subscription, and close the store — in that order (f14). Shared by
   * {@link dispose} and the R5 rebuild path. A no-op when nothing is built.
   */
  private async teardownGraph(): Promise<void> {
    const graph = this.graph;
    if (graph === null) return;
    this.graph = null;
    graph.engine.stop();
    if (graph.enginePromise !== null) {
      try {
        await graph.enginePromise;
      } catch (e) {
        logger.error('foundation.teardownGraph: engine loop rejected on stop', {
          error: String(e),
        });
      }
    }
    graph.requestMeteringUnsub();
    graph.store.close();
  }

  // -------------------------------------------------------------------------
  // Graph construction (Wave 4 §2/§3) — the exact composition, built once.
  // -------------------------------------------------------------------------

  private build(ownPk: string, ownUsername: string | undefined): BuiltGraph {
    const userData = app.getPath('userData');
    const store = new KnowledgeStore(path.join(userData, IG_DB_FILE));
    const clock = new SystemClock();
    const settings = this.resolveSettings();

    const rate = new RateGovernor(store, clock, toRateGovernorConfig(settings));
    const budget = new RequestBudget(store, clock, toRequestBudgetConfig(settings));

    // The adapter owns the single Actor + Sentinel instances the whole rim shares;
    // the Reader is pure and held directly (E2 — no dead adapter.reader slot).
    const adapter = new InstagramAdapter(this.tab);
    const actor = adapter.actor;
    const sentinel = adapter.sentinel;
    const reader = new Reader();

    // R2: one budget spend per real IG response, from the tab's onResponse pipeline.
    const requestMeteringUnsub = installRequestMetering(this.tab, budget, reader);

    const pageReader = new FollowersPageReader({ tab: this.tab, reader, actor });

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
    const ownFollowersSource: OwnFollowersSource = ownUsername
      ? new AdapterBackedOwnFollowersSource({ pageReader, ownUsername, budget, sentinel, store })
      : {
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
      onStatus: (s) => this.emit(s),
      onHalt: (reason) => {
        logger.warn('foundation: engine halted', { reason });
      },
    });

    return {
      store,
      engine,
      acquisition,
      churnActions,
      requestMeteringUnsub,
      ownPk,
      ownUsername,
      clock,
      enginePromise: null,
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
      attempts: USERNAME_RESOLVE_ATTEMPTS,
      retryMs: USERNAME_RESOLVE_RETRY_MS,
    });
  }

  // -------------------------------------------------------------------------
  // Status projection helpers
  // -------------------------------------------------------------------------

  private emit(status: EngineStatus): void {
    this.onStatusCb?.({ ...status, loggedIn: this.graph !== null });
  }

  private builtStatus(): PeanutStatus {
    // Only called when `this.graph` is set (post-build).
    const graph = this.graph;
    if (graph === null) return this.notBuiltStatus(true);
    return { ...graph.engine.status(), loggedIn: true };
  }

  private notBuiltStatus(loggedIn: boolean): PeanutStatus {
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
      loggedIn,
    };
  }
}
