
import type { ActivityReporter } from '@/adapter/activity-reporter';
import type { Actor } from '@/adapter/actor';
import type { Sentinel } from '@/adapter/sentinel';
import type { InstagramTab } from '@/adapter/tab';
import type { ChainController, } from '@/engine/chain-controller';
import type { ChurnScheduler } from '@/engine/churn-scheduler';
import type {
  Engine,
  EngineStatus,
} from '@/engine/engine';
import type { FollowbackWatcher } from '@/engine/followback-watcher';
import type {
  PruneEngine,
  PruneStatus,
} from '@/engine/prune-engine';
import type { Scanner } from '@/engine/scanner';
import type { SystemClock } from '@/governors/clock';
import type { PlanService } from '@/governors/plan-service';
import type { PlanPreviewPort } from '@/governors/plan-types';
import type { RateGovernor } from '@/governors/rate-governor';
import type { CursorObserver } from '@/interaction/input-driver';
import type { PlanDayClock } from '@/kernel/plan';
import type { CatchUpLaunch } from '@/main/modules/catch-up';
import type { AdapterBackedChurnActions } from '@/rim/churn-actions';
import type { IgActivityClock } from '@/rim/ig-activity-clock';
import type { ProfileVisitor } from '@/rim/profile-visit-port';
import type { FollowerAcquisition } from '@/rim/types';
import type { EffectiveSettings } from '@/settings/effective';
import type {
  Settings,
} from '@/settings/settings';
import type { StartupStep } from '@/shared/boot';
import type { SettingsCapabilities } from '@/shared/settings-view';
import type { StatusFields } from '@/shared/status-fields';
import type { ProtectionIndex } from '@/shared/unfollow-protection';
import type { KnowledgeStore } from '@/store/knowledge-store';
import type { DelayManager } from '@/timing/delay-manager';
import type { ScheduleManager } from '@/timing/schedule-manager';

/** One source of status fields beyond the engine's own, read on every composed status. */
export interface StatusContributor {
  readonly name: keyof StatusFields | string;
  contribute(graph: BuiltGraph | null, now: number): Partial<StatusFields>;
}

/** What each wiring module returns for the graph: its startup steps and status contributors. */
export interface WiringParts {
  readonly startupSteps: readonly StartupStep[];
  readonly statusContributors: readonly StatusContributor[];
}

/** The graph's plan (spec §5.13): the single writer of the day plan and its one plan-day boundary. */
export interface GraphPlan {
  readonly service: PlanService;
  readonly dayClock: PlanDayClock;
  readonly activity: IgActivityClock;
  /** The machine woke: the plan and its next edge are re-read from the wall clock. */
  resumed(): void;
  /** A census completed: the remainder re-plans its demand. */
  demandChanged(): void;
  /** True while a Boost window is open (a prune waits for it). */
  boostActive(): boolean;
  /** Stop the plan's triggers and withdraw what the graph registered (the graph is closing). */
  dispose(): void;
}

/** The composition root's plan surface (spec §5.6, §8.2): run intent, the live settings and a status push. */
export interface PlanHost {
  runIntent(): 'running' | 'stopped' | 'paused';
  readonly settings: {
    effective(): EffectiveSettings;
    onChange(fn: () => void): () => void;
    setPlanPort(port: PlanPreviewPort | null): void;
    setCapabilities(patch: Partial<SettingsCapabilities>): void;
  };
  pushStatus(): void;
}

/** The lazily-built dependency graph, cached once `ownPk` is resolvable. */
export interface BuiltGraph {
  prepareMutation(): Promise<boolean>;
  resolveIdentity(username: string): Promise<string | null>;
  noteMutation(): void;
  store: KnowledgeStore;
  engine: Engine;
  acquisition: FollowerAcquisition;
  churnActions: AdapterBackedChurnActions;
  /** The adapter's actor — kept for the paced own-profile landing click. */
  actor: Actor;
  /** Disposer for the passive relationship reconciler. */
  relationshipReconcilerUnsub: () => void;
  /** Disposer for the always-on profile observer (every profile body → store). */
  profileInfoUnsub: () => void;
  /** Reads a profile by VISITING it — the seed check's one read. */
  profiles: ProfileVisitor;
  ownPk: string;
  /** Our own username at build time, or `undefined` when it could not be resolved. */
  ownUsername: string | undefined;
  /** The single clock the graph shares — used to timestamp manual-op ledger rows. */
  clock: SystemClock;
  /** The ONE wait owner both engines share. */
  delays: DelayManager;
  /** The shared block-detection sentinel — gates manual one-shot fetches (seed check). */
  sentinel: Sentinel;
  /**
   * The loop promise returned by the most recent `engine.start()`, kept so
   * `dispose()` can await the loop's exit before closing the store. Null until
   * the engine is first started.
   */
  enginePromise: Promise<void> | null;
  /** The auto-prune routine — mutually exclusive with the engine. */
  pruneEngine: PruneEngine;
  /**
   * The run promise of the most recent `pruneEngine.run()`, kept so `dispose()`
   * can await its exit before closing the store. Null until first started.
   */
  prunePromise: Promise<void> | null;
  /** Live component handles kept so runtime Settings changes can reload configs. */
  rate: RateGovernor;
  churn: ChurnScheduler;
  scanner: Scanner;
  followback: FollowbackWatcher;
  chain: ChainController;
  plan: GraphPlan;
  /** Every wiring module's startup steps, aggregated once per build (a rebuild never duplicates one). */
  startupSteps: readonly StartupStep[];
  /** Every wiring module's status contributors, aggregated once per build. */
  statusContributors: readonly StatusContributor[];
}

/** Everything {@link buildGraph} needs from the composition root. */
export interface GraphBuildDeps {
  recoverTab?(reason: string): Promise<void>;
  validateIdentity?(): Promise<boolean>;
  onProgress?(phase: string): void;
  tab: InstagramTab;
  /** Directory holding the knowledge DB (and the settings file beside it). */
  userDataDir: string;
  /** File name of the knowledge DB inside {@link GraphBuildDeps.userDataDir}. */
  dbFile: string;
  /** Live phase readout tap (the veil); a no-op reporter when main wires none. */
  reporter: ActivityReporter;
  /** Optional tap on the Interactor's synthetic cursor. */
  cursorObserver?: CursorObserver;
  /** The Foundation's one ScheduleManager (the follow-back sweep cadence rides it). */
  scheduler: ScheduleManager;
  /** The settings snapshot the graph is constructed from. */
  settings: Settings;
  /** Re-read of the live settings (the persisted cadence getters call this). */
  resolveSettings(): Settings;
  /** The settings service's protection surface: the live index and the capability flags (spec §6.3, §7). */
  protection: { index(): ProtectionIndex; setCapabilities(patch: Partial<SettingsCapabilities>): void };
  plan: PlanHost;
  /** Persist a settings patch (cadence timestamps, `pruneLastRunAt`). */
  updateSettings(partial: Partial<Settings>): void;
  /** The v1 sweep stamp the settings migration carried: taken once by the reopen state, then consumed (spec §9.11). */
  bookkeeping?: { take(): { readonly forPk: string | null; readonly sweepLastRunAt: number | null } | null; consume(): void };
  /** The launch's state the catch-up admits on, and BL's landing (spec §9.6); absent: no catch-up step. */
  launch?: CatchUpLaunch;
  /** The ACTIVE driver's run token; adapter/rim waits link to it so stop() interrupts. */
  driverSignal(): AbortSignal | undefined;
  onStatus(status: EngineStatus): void;
  onPruneStatus(status: PruneStatus): void;
  onHalt(reason: string): void;
}

