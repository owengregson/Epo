/**
 * Preload bridge — exposes `window.peanut` to the renderer.
 *
 * Runs with `contextIsolation: true` / `nodeIntegration: false`; the renderer
 * never touches `ipcRenderer` directly. Push subscriptions (`on`/`off`) keep a
 * per-channel map from the caller's callback to the wrapped `ipcRenderer`
 * listener so `off` removes the *exact* listener that `on` added — no leaks.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import type {
  ActionResult,
  FoundationStatus,
  LogEntry,
  PeanutBridge,
  PeanutEventChannel,
  ReadFollowersResult,
} from '@/types';

/** Renderer-facing channel -> underlying IPC channel. */
const EVENT_CHANNELS: Record<PeanutEventChannel, string> = {
  log: 'peanut:log',
};

type BridgeListener = (payload: LogEntry) => void;
type IpcListener = (event: IpcRendererEvent, payload: LogEntry) => void;

// channel -> (caller cb -> wrapped ipc listener)
const listenerRegistry = new Map<string, Map<BridgeListener, IpcListener>>();

function on(channel: PeanutEventChannel, cb: BridgeListener): void {
  const ipcChannel = EVENT_CHANNELS[channel];
  if (!ipcChannel) return;
  let perChannel = listenerRegistry.get(ipcChannel);
  if (!perChannel) {
    perChannel = new Map();
    listenerRegistry.set(ipcChannel, perChannel);
  }
  if (perChannel.has(cb)) return; // already subscribed; no duplicate
  const wrapped: IpcListener = (_event, payload) => cb(payload);
  perChannel.set(cb, wrapped);
  ipcRenderer.on(ipcChannel, wrapped);
}

function off(channel: PeanutEventChannel, cb: BridgeListener): void {
  const ipcChannel = EVENT_CHANNELS[channel];
  if (!ipcChannel) return;
  const perChannel = listenerRegistry.get(ipcChannel);
  const wrapped = perChannel?.get(cb);
  if (perChannel && wrapped) {
    ipcRenderer.removeListener(ipcChannel, wrapped);
    perChannel.delete(cb);
  }
}

const bridge: PeanutBridge = {
  login: () => ipcRenderer.invoke('foundation:login'),
  readFollowers: (target: string): Promise<ReadFollowersResult> =>
    ipcRenderer.invoke('foundation:readFollowers', target),
  followOne: (username: string): Promise<ActionResult> =>
    ipcRenderer.invoke('foundation:followOne', username),
  unfollowOne: (username: string): Promise<ActionResult> =>
    ipcRenderer.invoke('foundation:unfollowOne', username),
  status: (): Promise<FoundationStatus> =>
    ipcRenderer.invoke('foundation:status'),
  showTab: () => ipcRenderer.invoke('tab:show'),
  hideTab: () => ipcRenderer.invoke('tab:hide'),
  on,
  off,
};

contextBridge.exposeInMainWorld('peanut', bridge);
