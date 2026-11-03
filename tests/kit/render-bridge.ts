/**
 * Renderer test bed: a fake `window.epo` bridge.
 *
 * Every bridge method resolves from a mutable `data` bag so a suite can stage a
 * projection before render; `emit(channel, payload)` drives the push channels the
 * renderer subscribes to (`status`, `pruneStatus`, `chainList`, `log`,
 * `updateStatus`, `settings`, `settingsFacts`, `feed`, `activity`, `stageRequest`),
 * which is how §2 liveness is exercised without a main process.
 * `calls` records every invocation so control wiring can be asserted.
 */
import type { PruneStatus } from '@/engine/prune-engine';
import { NO_ACTIVITY } from '@/main/ipc-live';
import { BOOST_OFF } from '@/main/ipc-plan';
import { notBuiltFacts, notBuiltFeed, notBuiltSurfaceReport } from '@/main/modules/not-built';
import { transitionalView } from '@/main/modules/settings-transitional';
import { resetShellSignals } from '@/renderer/app/shell-context';
import { effectiveFromV1 } from '@/settings/effective';
import type { FeedView } from '@/shared/feed';
import type { LiveTab } from '@/shared/live-op';
import type { SettingsFacts } from '@/shared/settings-facts';
import type { SettingsView } from '@/shared/settings-view';
import type { SurfaceReport } from '@/shared/surface-health';
import type {
  ChainTargetView,
  EpoBridge,
  EpoEventChannel,
  EpoEventPayloads,
  EpoStatus,
  Settings,
  UpdateStatus,
} from '@/types';

/** A neutral idle engine status — the shape every projection starts from. */
export function idleStatus(over: Partial<EpoStatus> = {}): EpoStatus {
  return {
    basis: 'built',
    state: 'idle',
    loggedIn: true,
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
    parkedUntil: null,
    parkReason: null,
    netToday: 0,
    online: true,
    haltReason: null,
    recovery: null,
    pacing: null,
    ...over,
  };
}

/** A neutral idle prune status. */
export function idlePruneStatus(over: Partial<PruneStatus> = {}): PruneStatus {
  return {
    state: 'idle',
    following: 0,
    followers: 0,
    candidates: 0,
    scanReady: false,
    scanAt: null,
    unfollowed: 0,
    remaining: 0,
    dailyDone: 0,
    dailyLimit: 0,
    lastRunAt: null,
    lastSentinel: null,
    haltReason: null,
    nextActionAt: null,
    upNext: null,
    scanPhase: null,
    scanEstimates: null,
    graph: { following: 0, followers: 0, notFollowingBack: 0 },
    census: null,
    rawRemaining: 0,
    ...over,
  };
}

/** One chain-lineage row — the `chainList` push payload's element. */
export function chainTarget(over: Partial<ChainTargetView> = {}): ChainTargetView {
  return {
    accountPk: '100',
    source: 'seed',
    status: 'active',
    chainIndex: 0,
    username: 'someone',
    yield: { total: 0, followedBack: 0, followBackRate: 0, poolSize: 0, mutualOverlap: 0 },
    ...over,
  };
}

const IDLE_UPDATE: UpdateStatus = {
  state: 'idle',
  mode: 'notify',
  current: '0.0.0-test',
  version: null,
  percent: null,
  error: null,
};

/** The mutable projections the fake resolves its reads from. */
export interface FakeBridgeData {
  status: EpoStatus;
  pruneStatus: PruneStatus;
  settings: Settings;
  update: UpdateStatus;
  /** What the `chain:list` PULL backstop resolves with (the push is `emit`). */
  chainList: ChainTargetView[];
  /** The Settings view the `settings:view` pull resolves with (the push is `settings`). */
  settingsView: SettingsView;
  settingsFacts: SettingsFacts;
  feed: FeedView;
  /** What the `activity:now` pull resolves with (the push is `activity`). */
  activity: LiveTab;
  /** What the `surface:report` pull resolves with (the summary rides `status.surface`). */
  surfaceReport: SurfaceReport;
}

export interface FakeBridge {
  /** Install as `window.epo` (and return the handle for assertions). */
  readonly bridge: EpoBridge;
  /** Staged projections — mutate before or between renders. */
  readonly data: FakeBridgeData;
  /** Every bridge call, in order: `[method, ...args]`. */
  readonly calls: Array<[string, ...unknown[]]>;
  /** Push a payload down a subscribed channel (the §2 store-mutation tick). */
  emit<C extends EpoEventChannel>(channel: C, payload: EpoEventPayloads[C]): void;
  /** Listener count on a channel — asserts the `off` half of a subscription. */
  listenerCount(channel: EpoEventChannel): number;
  /** Make the next call to `method` reject with `message`. */
  failNext(method: string, message: string): void;
  /** Override what `method` resolves with (a value or a factory). */
  stub(method: string, value: unknown | (() => unknown)): void;
}

/**
 * Build a fake bridge and install it on `window.epo`. Call inside `beforeEach`;
 * jsdom's window is recreated per file, so no teardown is required.
 *
 * The shell's projections live in module-scope signals, which outlive a single
 * `render()` — they are reset here so one case cannot paint the previous
 * case's status before the first pull lands.
 */
export function installFakeBridge(settings: Settings): FakeBridge {
  resetShellSignals();
  const listeners = new Map<string, Set<(p: never) => void>>();
  const calls: Array<[string, ...unknown[]]> = [];
  const failures = new Map<string, string>();
  const stubs = new Map<string, unknown>();
  const data: FakeBridgeData = {
    status: idleStatus(),
    pruneStatus: idlePruneStatus(),
    settings,
    update: IDLE_UPDATE,
    chainList: [],
    settingsView: transitionalView(settings, effectiveFromV1(settings), 0,
      { plan: false, tempo: false, boost: false, protectionEverywhere: false }),
    settingsFacts: notBuiltFacts('loading'),
    feed: notBuiltFeed(0),
    activity: NO_ACTIVITY,
    surfaceReport: notBuiltSurfaceReport(0),
  };

  /** Every promise-returning method routes through here: record, then resolve. */
  const call = <T>(method: string, args: unknown[], fallback: () => T): Promise<T> => {
    calls.push([method, ...args]);
    const failure = failures.get(method);
    if (failure !== undefined) {
      failures.delete(method);
      return Promise.reject(new Error(failure));
    }
    const stub = stubs.get(method);
    if (stub !== undefined) {
      stubs.delete(method);
      return Promise.resolve((typeof stub === 'function' ? (stub as () => T)() : stub) as T);
    }
    return Promise.resolve(fallback());
  };

  const bridge = {
    login: (...a: unknown[]) => call('login', a, () => data.status),
    readFollowers: (...a: unknown[]) =>
      call('readFollowers', a, () => ({ ok: true, added: 0, total: 0 })),
    followOne: (...a: unknown[]) => call('followOne', a, () => ({ ok: true })),
    unfollowOne: (...a: unknown[]) => call('unfollowOne', a, () => ({ ok: true })),
    status: (...a: unknown[]) => call('status', a, () => data.status),
    engineStatus: (...a: unknown[]) => call('engineStatus', a, () => data.status),
    startEngine: (...a: unknown[]) => call('startEngine', a, () => data.status),
    pauseEngine: (...a: unknown[]) => call('pauseEngine', a, () => data.status),
    resumeEngine: (...a: unknown[]) => call('resumeEngine', a, () => data.status),
    stopEngine: (...a: unknown[]) => call('stopEngine', a, () => data.status),
    restartFromSeed: (...a: unknown[]) => call('restartFromSeed', a, () => data.status),
    scanPrune: (...a: unknown[]) =>
      call('scanPrune', a, () => ({ ok: true, following: 0, followers: 0, candidates: [] })),
    pruneCandidates: (...a: unknown[]) => call('pruneCandidates', a, () => []),
    startPrune: (...a: unknown[]) =>
      call('startPrune', a, () => ({ ok: true, status: data.pruneStatus })),
    stopPrune: (...a: unknown[]) => call('stopPrune', a, () => data.pruneStatus),
    pausePrune: (...a: unknown[]) => call('pausePrune', a, () => data.pruneStatus),
    resumePrune: (...a: unknown[]) => call('resumePrune', a, () => data.pruneStatus),
    pruneStatus: (...a: unknown[]) => call('pruneStatus', a, () => data.pruneStatus),
    onPruneStatus: (cb: (s: PruneStatus) => void) => subscribe('pruneStatus', cb),
    offPruneStatus: (cb: (s: PruneStatus) => void) => unsubscribe('pruneStatus', cb),
    chainList: (...a: unknown[]) => call('chainList', a, () => data.chainList),
    chainDetail: (...a: unknown[]) => call('chainDetail', a, () => null),
    growthSeries: (...a: unknown[]) =>
      call('growthSeries', a, () => ({ points: [], baselineAt: null })),
    checkSeed: (...a: unknown[]) =>
      call('checkSeed', a, () => ({
        ok: true,
        exists: true,
        followersVisible: true,
        isPrivate: false,
      })),
    queueList: (...a: unknown[]) => call('queueList', a, () => ({ rows: [], truncated: false })),
    getSettings: (...a: unknown[]) => call('getSettings', a, () => data.settings),
    updateSettings: (...a: unknown[]) =>
      call('updateSettings', a, () => {
        data.settings = { ...data.settings, ...(a[0] as Partial<Settings>) };
        return data.settings;
      }),
    resetSettings: (...a: unknown[]) => call('resetSettings', a, () => data.settings),
    clearData: (...a: unknown[]) => call('clearData', a, () => data.status),
    graphSnapshot: (...a: unknown[]) => call('graphSnapshot', a, () => null),
    setStage: (...a: unknown[]) => call('setStage', a, () => undefined),
    setTourHold: (...a: unknown[]) => call('setTourHold', a, () => undefined),
    checkForUpdate: (...a: unknown[]) => call('checkForUpdate', a, () => data.update),
    installUpdate: (...a: unknown[]) => call('installUpdate', a, () => data.update),
    openLatestRelease: (...a: unknown[]) => call('openLatestRelease', a, () => undefined),
    bootRevealed: (...a: unknown[]) => call('bootRevealed', a, () => undefined),
    settingsView: (...a: unknown[]) => call('settingsView', a, () => data.settingsView),
    applySettings: (...a: unknown[]) =>
      call('applySettings', a, () => ({ kind: 'refused', reason: 'internal', detail: 'fake', view: data.settingsView })),
    previewSettings: (...a: unknown[]) => call('previewSettings', a, () => ({ kind: 'unavailable' })),
    settingsBasis: (...a: unknown[]) => call('settingsBasis', a, () => ({ kind: 'unavailable' })),
    settingsFacts: (...a: unknown[]) => call('settingsFacts', a, () => data.settingsFacts),
    suggestAccounts: (...a: unknown[]) => call('suggestAccounts', a, () => ({ kind: 'ok', rows: [] })),
    keptList: (...a: unknown[]) => call('keptList', a, () => ({ kind: 'ok', rows: [], total: 0 })),
    startBoost: (...a: unknown[]) => call('startBoost', a, () => ({ kind: 'refused', reason: 'internal', boost: BOOST_OFF })),
    endBoost: (...a: unknown[]) => call('endBoost', a, () => ({ kind: 'refused', reason: 'internal', boost: BOOST_OFF })),
    previewBoost: (...a: unknown[]) => call('previewBoost', a, () => null),
    activityNow: (...a: unknown[]) => call('activityNow', a, () => data.activity),
    feedView: (...a: unknown[]) => call('feedView', a, () => data.feed),
    logTail: (...a: unknown[]) => call('logTail', a, () => []),
    setLogStream: (...a: unknown[]) => call('setLogStream', a, () => undefined),
    openLogFolder: (...a: unknown[]) => call('openLogFolder', a, () => undefined),
    updateStatus: (...a: unknown[]) => call('updateStatus', a, () => data.update),
    surfaceReport: (...a: unknown[]) => call('surfaceReport', a, () => data.surfaceReport),
    on: (channel: string, cb: (p: never) => void) => subscribe(channel, cb),
    off: (channel: string, cb: (p: never) => void) => unsubscribe(channel, cb),
  } as unknown as EpoBridge;

  function subscribe(channel: string, cb: (p: never) => void): void {
    const set = listeners.get(channel) ?? new Set();
    set.add(cb);
    listeners.set(channel, set);
  }
  function unsubscribe(channel: string, cb: (p: never) => void): void {
    listeners.get(channel)?.delete(cb);
  }

  const fake: FakeBridge = {
    bridge,
    data,
    calls,
    emit(channel, payload) {
      for (const cb of [...(listeners.get(channel) ?? [])]) {
        (cb as (p: unknown) => void)(payload);
      }
    },
    listenerCount: (channel) => listeners.get(channel)?.size ?? 0,
    failNext: (method, message) => failures.set(method, message),
    stub: (method, value) => stubs.set(method, value),
  };

  (window as unknown as { epo: EpoBridge }).epo = bridge;
  return fake;
}
