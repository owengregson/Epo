/**
 * Preload bridge — exposes `window.epo` to the renderer.
 *
 * Runs with `contextIsolation: true` / `nodeIntegration: false`; the renderer
 * never touches `ipcRenderer` directly. Push subscriptions (`on`/`off`) keep a
 * per-channel map from the caller's callback to the wrapped `ipcRenderer`
 * listener so `off` removes the *exact* listener that `on` added — no leaks.
 * Every push channel (the streaming log and the pushed projections) flows
 * through the same map.
 */

import type { IpcRendererEvent } from 'electron';
import { contextBridge, ipcRenderer } from 'electron';
import type { Settings } from '@/settings/settings';
import type {
  ActionResult,
  ChainTargetView,
  EpoBridge,
  EpoEventChannel,
  EpoEventPayloads,
  EpoStatus,
  FollowState,
  GraphSnapshot,
  NetGrowthPoint,
  PruneCandidate,
  PruneControlResult,
  PruneScanResult,
  PruneStatus,
  QueueListResult,
  ReadFollowersResult,
  SeedCheck,
  StageMode,
  UpdateStatus,
} from '@/types';

/** Renderer-facing channel -> underlying IPC channel. */
const EVENT_CHANNELS: Record<EpoEventChannel, string> = {
  log: 'epo:log',
  status: 'epo:status',
  pruneStatus: 'epo:prune-status',
  updateStatus: 'epo:update-status',
  chainList: 'epo:chain-list',
};

type AnyListener = (payload: unknown) => void;
type IpcListener = (event: IpcRendererEvent, payload: unknown) => void;

// channel -> (caller cb -> wrapped ipc listener)
const listenerRegistry = new Map<string, Map<AnyListener, IpcListener>>();

function on<C extends EpoEventChannel>(
  channel: C,
  cb: (payload: EpoEventPayloads[C]) => void,
): void {
  const ipcChannel = EVENT_CHANNELS[channel];
  if (!ipcChannel) return;
  let perChannel = listenerRegistry.get(ipcChannel);
  if (!perChannel) {
    perChannel = new Map();
    listenerRegistry.set(ipcChannel, perChannel);
  }
  const listener = cb as AnyListener;
  if (perChannel.has(listener)) return; // already subscribed; no duplicate
  const wrapped: IpcListener = (_event, payload) => {
    listener(payload);
  };
  perChannel.set(listener, wrapped);
  ipcRenderer.on(ipcChannel, wrapped);
}

function off<C extends EpoEventChannel>(
  channel: C,
  cb: (payload: EpoEventPayloads[C]) => void,
): void {
  const ipcChannel = EVENT_CHANNELS[channel];
  if (!ipcChannel) return;
  const perChannel = listenerRegistry.get(ipcChannel);
  const listener = cb as AnyListener;
  const wrapped = perChannel?.get(listener);
  if (perChannel && wrapped) {
    ipcRenderer.removeListener(ipcChannel, wrapped);
    perChannel.delete(listener);
  }
}

const bridge: EpoBridge = {
  login: (): Promise<EpoStatus> => ipcRenderer.invoke('foundation:login'),
  readFollowers: (target: string): Promise<ReadFollowersResult> =>
    ipcRenderer.invoke('foundation:readFollowers', target),
  followOne: (username: string): Promise<ActionResult> =>
    ipcRenderer.invoke('foundation:followOne', username),
  unfollowOne: (username: string): Promise<ActionResult> =>
    ipcRenderer.invoke('foundation:unfollowOne', username),
  status: (): Promise<EpoStatus> => ipcRenderer.invoke('foundation:status'),
  startEngine: (): Promise<EpoStatus> => ipcRenderer.invoke('engine:start'),
  pauseEngine: (): Promise<EpoStatus> => ipcRenderer.invoke('engine:pause'),
  resumeEngine: (): Promise<EpoStatus> => ipcRenderer.invoke('engine:resume'),
  stopEngine: (): Promise<EpoStatus> => ipcRenderer.invoke('engine:stop'),
  restartFromSeed: (seed: string): Promise<EpoStatus> =>
    ipcRenderer.invoke('engine:restartFromSeed', seed),
  engineStatus: (): Promise<EpoStatus> => ipcRenderer.invoke('engine:status'),
  scanPrune: (): Promise<PruneScanResult> => ipcRenderer.invoke('prune:scan'),
  pruneCandidates: (): Promise<PruneCandidate[]> => ipcRenderer.invoke('prune:candidates'),
  startPrune: (): Promise<PruneControlResult> => ipcRenderer.invoke('prune:start'),
  stopPrune: (): Promise<PruneStatus> => ipcRenderer.invoke('prune:stop'),
  pruneStatus: (): Promise<PruneStatus> => ipcRenderer.invoke('prune:status'),
  onPruneStatus: (cb: (status: PruneStatus) => void): void => on('pruneStatus', cb),
  offPruneStatus: (cb: (status: PruneStatus) => void): void => off('pruneStatus', cb),
  chainList: (): Promise<ChainTargetView[]> => ipcRenderer.invoke('chain:list'),
  growthSeries: (days: number): Promise<NetGrowthPoint[]> =>
    ipcRenderer.invoke('growth:series', days),
  checkSeed: (username: string): Promise<SeedCheck> => ipcRenderer.invoke('seed:check', username),
  queueList: (state: FollowState): Promise<QueueListResult> =>
    ipcRenderer.invoke('queue:list', state),
  getSettings: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
  updateSettings: (partial: Partial<Settings>): Promise<Settings> =>
    ipcRenderer.invoke('settings:update', partial),
  resetSettings: (): Promise<Settings> => ipcRenderer.invoke('settings:reset'),
  clearData: (): Promise<EpoStatus> => ipcRenderer.invoke('data:clear'),
  showTab: () => ipcRenderer.invoke('tab:show'),
  hideTab: () => ipcRenderer.invoke('tab:hide'),
  graphSnapshot: (): Promise<GraphSnapshot | null> => ipcRenderer.invoke('graph:snapshot'),
  setStage: (mode: StageMode): Promise<void> => ipcRenderer.invoke('stage:set', mode),
  setTourHold: (held: boolean): Promise<void> => ipcRenderer.invoke('tour:hold', held),
  checkForUpdate: (): Promise<UpdateStatus> => ipcRenderer.invoke('update:check'),
  installUpdate: (): Promise<UpdateStatus> => ipcRenderer.invoke('update:install'),
  openLatestRelease: (): Promise<void> => ipcRenderer.invoke('update:open-latest'),
  on,
  off,
};

contextBridge.exposeInMainWorld('epo', bridge);
