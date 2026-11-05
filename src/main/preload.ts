/**
 * Preload bridge — exposes `window.epo` to the renderer.
 *
 * Runs with `contextIsolation: true` / `nodeIntegration: false`; the renderer
 * never touches `ipcRenderer` directly. BOTH halves are GENERATED from the
 * contract's channel maps (`CHANNELS` / `PUSH`), so a new channel — invoke or
 * push — needs no edit here. Push subscriptions
 * (`on`/`off`) keep a per-channel map from the caller's callback
 * to the wrapped `ipcRenderer` listener so `off` removes the *exact* listener
 * that `on` added — no leaks.
 */

import type { IpcRendererEvent } from 'electron';
import { contextBridge, ipcRenderer } from 'electron';
import { type BridgeInvokers, type BridgeMethod, CHANNELS, PUSH } from '@/ipc/contract';
import type { EpoBridge, EpoEventChannel, EpoEventPayloads, PruneStatus } from '@/types';

/**
 * Renderer-facing channel -> underlying IPC channel. DERIVED from the
 * contract's push table (ADR 1008); this used to be a hand-kept copy of the
 * same five strings `main.ts` also wrote by hand.
 */
const EVENT_CHANNELS: Record<EpoEventChannel, string> = PUSH;

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

/** One `ipcRenderer.invoke` thunk per contract method. */
const invokers = Object.fromEntries(
  (Object.keys(CHANNELS) as BridgeMethod[]).map((method) => [
    method,
    (...args: unknown[]): Promise<unknown> => ipcRenderer.invoke(CHANNELS[method], ...args),
  ]),
) as BridgeInvokers;

const bridge: EpoBridge = {
  ...invokers,
  onPruneStatus: (cb: (status: PruneStatus) => void): void => on('pruneStatus', cb),
  offPruneStatus: (cb: (status: PruneStatus) => void): void => off('pruneStatus', cb),
  on,
  off,
};

contextBridge.exposeInMainWorld('epo', bridge);
