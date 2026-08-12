/**
 * Preload bridge — exposes `window.peanut` to the renderer.
 *
 * Runs with `contextIsolation: true` / `nodeIntegration: false`; the renderer
 * never touches `ipcRenderer` directly. Push subscriptions (`on`/`off`) keep a
 * per-channel map from the caller's callback to the wrapped `ipcRenderer`
 * listener so `off` removes the *exact* listener that `on` added — no leaks.
 * Both push channels (`log` and pushed `status`) flow through the same map.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import type {
  ActionResult,
  PeanutBridge,
  PeanutEventChannel,
  PeanutEventPayloads,
  PeanutStatus,
  ReadFollowersResult,
} from '@/types';

/** Renderer-facing channel -> underlying IPC channel. */
const EVENT_CHANNELS: Record<PeanutEventChannel, string> = {
  log: 'peanut:log',
  status: 'peanut:status',
};

type AnyListener = (payload: unknown) => void;
type IpcListener = (event: IpcRendererEvent, payload: unknown) => void;

// channel -> (caller cb -> wrapped ipc listener)
const listenerRegistry = new Map<string, Map<AnyListener, IpcListener>>();

function on<C extends PeanutEventChannel>(
  channel: C,
  cb: (payload: PeanutEventPayloads[C]) => void,
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

function off<C extends PeanutEventChannel>(
  channel: C,
  cb: (payload: PeanutEventPayloads[C]) => void,
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

const bridge: PeanutBridge = {
  login: (): Promise<PeanutStatus> => ipcRenderer.invoke('foundation:login'),
  readFollowers: (target: string): Promise<ReadFollowersResult> =>
    ipcRenderer.invoke('foundation:readFollowers', target),
  followOne: (username: string): Promise<ActionResult> =>
    ipcRenderer.invoke('foundation:followOne', username),
  unfollowOne: (username: string): Promise<ActionResult> =>
    ipcRenderer.invoke('foundation:unfollowOne', username),
  status: (): Promise<PeanutStatus> => ipcRenderer.invoke('foundation:status'),
  startEngine: (): Promise<PeanutStatus> => ipcRenderer.invoke('engine:start'),
  pauseEngine: (): Promise<PeanutStatus> => ipcRenderer.invoke('engine:pause'),
  resumeEngine: (): Promise<PeanutStatus> => ipcRenderer.invoke('engine:resume'),
  stopEngine: (): Promise<PeanutStatus> => ipcRenderer.invoke('engine:stop'),
  engineStatus: (): Promise<PeanutStatus> => ipcRenderer.invoke('engine:status'),
  showTab: () => ipcRenderer.invoke('tab:show'),
  hideTab: () => ipcRenderer.invoke('tab:hide'),
  on,
  off,
};

contextBridge.exposeInMainWorld('peanut', bridge);
