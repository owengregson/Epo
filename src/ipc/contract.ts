/**
 * The renderer ⟷ main request/response contract.
 *
 * Every invocable channel name is written HERE and nowhere else: `CHANNELS`
 * maps the bridge method the renderer calls (`window.epo.<method>`) to its IPC
 * channel string, and `IpcContract` gives that method its argument tuple and
 * result type. The main-process handler map (`src/ipc/register.ts`), the
 * handler disposer, the preload bridge, and `EpoBridge` are all derived from
 * these two — so a channel can no longer be registered without a handler,
 * exposed without a type, or forgotten by the disposer.
 *
 * The push half (main → renderer) is the same discipline in the same file:
 * `PUSH` + `PushContract` at the bottom, from which `EpoEventChannel`,
 * `EpoEventPayloads`, preload's subscription map and `main.ts`'s sends all
 * derive. See ADR 1008.
 *
 * Per-topic rows live in `contract-{settings,plan,live,surface}.ts` and are
 * spread in here, so each channel string is still written exactly once.
 *
 * Dependency-free by construction: type-only imports, plus frozen literals.
 * Imported by main, preload AND the renderer — so the boundary VALIDATORS live
 * next door in `src/ipc/guards.ts` (zod is a main-process cost, not a renderer
 * bundle cost). See ADR 1009.
 */

// biome-ignore-all lint/suspicious/noConfusingVoidType: `res: void` is the
// acknowledgement-only result of a fire-and-forget channel; it flows into a
// return position (`Promise<Res<M>>`) everywhere it is used.

import type { FeedView } from '@/shared/feed';
import type { LiveTab } from '@/shared/live-op';
import type { SettingsFacts } from '@/shared/settings-facts';
import type { SettingsView } from '@/shared/settings-view';
import type { ProtectedBy } from '@/shared/unfollow-protection';
import type {
  ActionResult,
  ChainTargetDetail,
  ChainTargetView,
  EpoStatus,
  FollowState,
  GraphSnapshot,
  GrowthSeriesRead,
  LogEntry,
  PruneCandidate,
  PruneControlResult,
  PruneScanResult,
  PruneStatus,
  QueueListResult,
  ReadFollowersResult,
  SeedCheck,
  Settings,
  StageMode,
  UpdateStatus,
} from '@/types';
import { LIVE_CHANNELS, type LiveIpcContract } from './contract-live';
import { PLAN_CHANNELS, type PlanIpcContract } from './contract-plan';
import { SETTINGS_CHANNELS, type SettingsIpcContract } from './contract-settings';
import { SURFACE_CHANNELS, type SurfaceIpcContract } from './contract-surface';

/** A prune candidate as the candidates channel serves it, annotated by the protection predicate. */
export interface PruneCandidateView extends PruneCandidate {
  /** The rule that keeps it, or null when none does. */
  readonly protectedBy: ProtectedBy | null;
  /** True when a configured bio rule could not be judged from the stored facts. */
  readonly bioUnread: boolean;
}

/**
 * Bridge method → IPC channel. The ONLY place a channel string appears.
 *
 * `status` and `engineStatus` are two names for one projection: both channels
 * stay registered so neither side of an in-flight release breaks.
 */
export const CHANNELS = {
  login: 'foundation:login',
  readFollowers: 'foundation:readFollowers',
  followOne: 'foundation:followOne',
  unfollowOne: 'foundation:unfollowOne',
  status: 'foundation:status',
  startEngine: 'engine:start',
  pauseEngine: 'engine:pause',
  resumeEngine: 'engine:resume',
  stopEngine: 'engine:stop',
  restartFromSeed: 'engine:restartFromSeed',
  engineStatus: 'engine:status',
  scanPrune: 'prune:scan',
  pruneCandidates: 'prune:candidates',
  startPrune: 'prune:start',
  stopPrune: 'prune:stop',
  pausePrune: 'prune:pause',
  resumePrune: 'prune:resume',
  pruneStatus: 'prune:status',
  chainList: 'chain:list',
  chainDetail: 'chain:detail',
  growthSeries: 'growth:series',
  checkSeed: 'seed:check',
  queueList: 'queue:list',
  getSettings: 'settings:get',
  updateSettings: 'settings:update',
  resetSettings: 'settings:reset',
  clearData: 'data:clear',
  graphSnapshot: 'graph:snapshot',
  setStage: 'stage:set',
  setTourHold: 'tour:hold',
  checkForUpdate: 'update:check',
  installUpdate: 'update:install',
  openLatestRelease: 'update:open-latest',
  bootRevealed: 'boot:revealed',
  ...SETTINGS_CHANNELS,
  ...PLAN_CHANNELS,
  ...LIVE_CHANNELS,
  ...SURFACE_CHANNELS,
} as const;

/** A renderer-callable bridge method name. */
export type BridgeMethod = keyof typeof CHANNELS;

/** An IPC channel string handled in the main process. */
export type Channel = (typeof CHANNELS)[BridgeMethod];

/** Argument tuple + result type per bridge method. */
export interface IpcContract extends SettingsIpcContract, PlanIpcContract, LiveIpcContract, SurfaceIpcContract {
  /** Open Instagram in the embedded tab (login is performed by the user). */
  login: { req: []; res: EpoStatus };
  /** Read a target account's followers into the knowledge graph. */
  readFollowers: { req: [target: string]; res: ReadFollowersResult };
  /** Follow a single account by username. */
  followOne: { req: [username: string]; res: ActionResult };
  /** Unfollow a single account by username. */
  unfollowOne: { req: [username: string]; res: ActionResult };
  /** A status snapshot for the control shell. */
  status: { req: []; res: EpoStatus };
  /** Start the engine loop (builds the graph if needed). */
  startEngine: { req: []; res: EpoStatus };
  /** Pause the engine between actions. */
  pauseEngine: { req: []; res: EpoStatus };
  /** Resume a paused engine. */
  resumeEngine: { req: []; res: EpoStatus };
  /** Stop the engine loop (aborts in-flight sleeps). */
  stopEngine: { req: []; res: EpoStatus };
  /** Scrap the current chain and restart from `seed` (persists the seed first). */
  restartFromSeed: { req: [seed: string]; res: EpoStatus };
  /** The same projection as {@link IpcContract.status}. */
  engineStatus: { req: []; res: EpoStatus };
  /** READ-ONLY prune scan: the raw following − followers census (no unfollows). */
  scanPrune: { req: []; res: PruneScanResult };
  /** The persisted scan's not-yet-visited candidates (raw census), annotated by protection. */
  pruneCandidates: { req: []; res: PruneCandidateView[] };
  /** Start one prune run (mutually exclusive with the growth engine). */
  startPrune: { req: []; res: PruneControlResult };
  /** Stop an active prune scan/run between actions. */
  stopPrune: { req: []; res: PruneStatus };
  /** Pause an active prune run between unfollows (the run keeps the tab). */
  pausePrune: { req: []; res: PruneStatus };
  /** Resume a paused prune run. */
  resumePrune: { req: []; res: PruneStatus };
  /** The prune status projection. */
  pruneStatus: { req: []; res: PruneStatus };
  /** The chain lineage: every target with its username and computed yield. */
  chainList: { req: []; res: ChainTargetView[] };
  /** The Targets console's detail projection for one chain target. */
  chainDetail: { req: [targetPk: string]; res: ChainTargetDetail | null };
  /** Cumulative net own-follower growth per day, plus the measurement baseline. */
  growthSeries: { req: [days?: number]; res: GrowthSeriesRead };
  /** Read-only precheck of a seed username (existence + followers visibility). */
  checkSeed: { req: [username: string]; res: SeedCheck };
  /** A capped page of follow_records in one lifecycle state, joined to accounts. */
  queueList: { req: [state: FollowState]; res: QueueListResult };
  /** The persisted settings object. */
  getSettings: { req: []; res: Settings };
  /** Merge a partial into settings, persist, and reload the live engine configs. */
  updateSettings: { req: [partial: Partial<Settings>]; res: Settings };
  /** Reset all settings to defaults (data + session kept). */
  resetSettings: { req: []; res: Settings };
  /** Wipe the knowledge DB + IG session (logout); settings kept. */
  clearData: { req: []; res: EpoStatus };
  /** The full knowledge graph shaped for the Graph view (null before login). */
  graphSnapshot: { req: []; res: GraphSnapshot | null };
  /**
   * Swap the window region right of the console. `covered` hides the native
   * views even on 'tab' while a renderer modal is open — they float above
   * anything the renderer draws, so no CSS stacking can put a dialog over them.
   */
  setStage: { req: [mode: StageMode, covered: boolean]; res: void };
  /** Park/unpark the app while the intro tour is on screen. */
  setTourHold: { req: [held: boolean]; res: void };
  /** Ask the updater to check the release feed now. */
  checkForUpdate: { req: []; res: UpdateStatus };
  /** Full mode, state 'ready': install the downloaded update and restart. */
  installUpdate: { req: []; res: UpdateStatus };
  /** Notify mode: open the latest-release page in the default browser. */
  openLatestRelease: { req: []; res: void };
  /** The renderer revealed the app (the boot sequence moves to live). */
  bootRevealed: { req: []; res: void };
}

/** Argument tuple for one bridge method. */
export type Req<M extends BridgeMethod> = IpcContract[M]['req'];

/** Result type for one bridge method. */
export type Res<M extends BridgeMethod> = IpcContract[M]['res'];

/**
 * Drift guards: `CHANNELS` and `IpcContract` must name exactly the same set of
 * methods. Adding to one without the other is a compile error here.
 */
type MissingFromContract = Exclude<BridgeMethod, keyof IpcContract>;
type MissingFromChannels = Exclude<keyof IpcContract, BridgeMethod>;
type _ContractCoversEveryChannel = MissingFromContract extends never ? true : never;
type _ChannelsCoverEveryContract = MissingFromChannels extends never ? true : never;
const _contractIsComplete: _ContractCoversEveryChannel = true;
const _channelsAreComplete: _ChannelsCoverEveryContract = true;
void _contractIsComplete;
void _channelsAreComplete;

/** The invoke half of `window.epo`, derived so no signature is written twice. */
export type BridgeInvokers = {
  [M in BridgeMethod]: (...args: Req<M>) => Promise<Res<M>>;
};

// ---------------------------------------------------------------------------
// The push half: main → renderer. Same discipline, same guards.
// ---------------------------------------------------------------------------

/**
 * Push channel name → IPC channel string. The ONLY place a `epo:*` string
 * appears.
 *
 * Before this table the five push channels were declared in three hand-written
 * places — `preload.ts`'s `EVENT_CHANNELS`, `main.ts`'s literal `shell.send()`
 * calls, and `EpoEventPayloads` in `types.ts` — which is exactly the pre-0101
 * situation the invoke channels were in. See ADR 1008.
 */
export const PUSH = {
  log: 'epo:log',
  status: 'epo:status',
  pruneStatus: 'epo:prune-status',
  updateStatus: 'epo:update-status',
  chainList: 'epo:chain-list',
  settings: 'epo:settings',
  settingsFacts: 'epo:settings-facts',
  feed: 'epo:feed',
  activity: 'epo:activity',
  stageRequest: 'epo:stage-request',
} as const;

/** A renderer-subscribable push channel name (`window.epo.on(<name>, …)`). */
export type PushMethod = keyof typeof PUSH;

/** An IPC channel string pushed from the main process. */
export type PushChannel = (typeof PUSH)[PushMethod];

/** Payload type per push channel. */
export interface PushContract {
  /** One structured log line, streamed to the renderer's log pane. */
  log: LogEntry;
  /** The growth status projection (pushed on engine emit and on store mutation). */
  status: EpoStatus;
  /** The prune status projection (same throttled store-mutation push). */
  pruneStatus: PruneStatus;
  /** The self-updater's state machine. */
  updateStatus: UpdateStatus;
  /**
   * The chain projection, re-shaped and pushed on every store mutation (same
   * throttled push as `status` — PRINCIPLES §2), so target yields tick DURING
   * walks, where observations move no status counter.
   */
  chainList: ChainTargetView[];
  /** The Settings view, sent by the settings service after every persisted write (not graph-derived). */
  settings: SettingsView;
  /** The store-derived Settings facts (a projection row; also sent on each settings change). */
  settingsFacts: SettingsFacts;
  /** The live feed (a projection row, deduplicated). */
  feed: FeedView;
  /** The live tab's phase and holds (not graph-derived, so not a projection row). */
  activity: LiveTab;
  /** A stage the application menu asks the renderer to show. */
  stageRequest: StageMode;
}

/** Payload type for one push channel. */
export type Push<C extends PushMethod> = PushContract[C];

/**
 * Drift guards for the push half, mirroring the invoke half above: `PUSH` and
 * `PushContract` must name exactly the same set of channels.
 */
type MissingFromPushContract = Exclude<PushMethod, keyof PushContract>;
type MissingFromPush = Exclude<keyof PushContract, PushMethod>;
type _PushContractCoversEveryChannel = MissingFromPushContract extends never ? true : never;
type _PushCoversEveryContract = MissingFromPush extends never ? true : never;
const _pushContractIsComplete: _PushContractCoversEveryChannel = true;
const _pushChannelsAreComplete: _PushCoversEveryContract = true;
void _pushContractIsComplete;
void _pushChannelsAreComplete;
