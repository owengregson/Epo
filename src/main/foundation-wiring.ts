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

/**
 * A small, case-insensitive username → numeric-pk memory. Account identity is the
 * pk (never the username); this is retained as a standalone, cleanly unit-testable
 * helper (it has no live/Electron dependencies).
 */
export class PkRegistry {
  private readonly byUsername = new Map<string, string>();

  remember(username: string | undefined, pk: string): void {
    if (!username) return;
    this.byUsername.set(username.toLowerCase(), pk);
  }

  lookup(username: string): string | null {
    return this.byUsername.get(username.toLowerCase()) ?? null;
  }
}

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
   * once built (idempotent — a second call is a no-op).
   */
  async ensureBuilt(): Promise<boolean> {
    if (this.graph) return true;
    const ownPk = await this.resolveOwnPk();
    if (ownPk === null) return false;
    const ownUsername = await this.resolveOwnUsername();
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
    // Fire-and-forget: `start()` resolves only when the loop exits; do NOT await.
    void this.graph.engine.start().catch((e: unknown) => {
      logger.error('foundation: engine loop errored', { error: String(e) });
    });
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
      return { target, observed: 0 };
    }
    try {
      const { observed } = await this.graph.acquisition.acquire(target);
      return { target, observed };
    } catch (e) {
      logger.error('foundation.readFollowers: failed', { target, error: String(e) });
      return { target, observed: 0 };
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
    try {
      // R4: the rim now returns a discriminated outcome. Map it to the manual
      // IPC result — `ok`/`simulated` (dry-run no-op) succeed; `blocked`
      // (budget/sentinel) and `failed` (unconfirmed click) do not.
      const { status } =
        action === 'follow'
          ? await this.graph.churnActions.follow(username)
          : await this.graph.churnActions.unfollow(username);
      if (status === 'ok' || status === 'simulated') return { ok: true, username };
      return { ok: false, username, reason: status === 'blocked' ? 'blocked' : 'action-failed' };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      logger.error('foundation.act: failed', { action, username, error: reason });
      return { ok: false, username, reason };
    }
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  /** Engine status when built; a minimal idle status otherwise. */
  async status(): Promise<PeanutStatus> {
    if (this.graph) return this.builtStatus();
    return this.notBuiltStatus(await this.isLoggedIn());
  }

  /** Close the engine + store on window teardown. Idempotent. */
  dispose(): void {
    if (this.graph) {
      this.graph.engine.stop();
      this.graph.requestMeteringUnsub();
      this.graph.store.close();
      this.graph = null;
    }
    logger.info('foundation disposed');
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
    const ownFollowersSource: OwnFollowersSource = ownUsername
      ? new AdapterBackedOwnFollowersSource({ pageReader, ownUsername, budget, sentinel })
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
   * desktop UA lets this JSON API answer). Returns `undefined` on any failure so
   * own-followers features degrade gracefully rather than breaking the build.
   */
  private async resolveOwnUsername(): Promise<string | undefined> {
    try {
      const username = await this.tab.evaluate<string | null>(
        `(async () => {
          try {
            const res = await fetch('/api/v1/accounts/current_user/', {
              headers: { 'x-ig-app-id': '${IG_APP_ID}' },
              credentials: 'include',
            });
            if (!res.ok) return null;
            const data = await res.json();
            return data && data.user && data.user.username ? data.user.username : null;
          } catch (e) {
            return null;
          }
        })()`,
      );
      if (typeof username === 'string' && username.length > 0) return username;
      logger.warn('foundation.resolveOwnUsername: current_user returned no username');
      return undefined;
    } catch (e) {
      logger.warn('foundation.resolveOwnUsername: evaluate failed', { error: String(e) });
      return undefined;
    }
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
