/**
 * Main-process registration for the {@link IpcContract}.
 *
 * `registerIpc` binds one handler per bridge method, wraps each in the `safe()`
 * guard, and returns a disposer derived from the same map — so the disposer can
 * never drift from the registrations (it used to be a hand-maintained array
 * that had already lost the `update:*` channels).
 *
 * No silent catches: a throwing handler logs at error level with its channel
 * and scalar arguments, then answers with that channel's OWN typed fallback.
 * A fallback is never a bare `null` — the renderer always receives the shape
 * its contract promises.
 *
 * The same wrapper applies the boundary GUARDS (`src/ipc/guards.ts`) BEFORE
 * the handler runs, so a malformed payload never reaches the store or the
 * settings file. A refusal takes the identical exit as a throw: an error log
 * naming the channel and the failing path, then the typed fallback — never an
 * exception across the boundary. See ADR 1009.
 */

import { ipcMain } from 'electron';
import { type BridgeMethod, CHANNELS, type Req, type Res } from '@/ipc/contract';
import { checkArgs } from '@/ipc/guards';
import * as logger from '@/utils/logger';

/** One implementation per bridge method, typed by the contract. */
export type IpcHandlers = {
  [M in BridgeMethod]: (...args: Req<M>) => Promise<Res<M>> | Res<M>;
};

/** The typed value a channel answers with when its handler throws. */
export type IpcFallbacks = {
  [M in BridgeMethod]: () => Promise<Res<M>> | Res<M>;
};

type AnyHandler = (...args: unknown[]) => unknown;

/** Scalar arguments only — enough context to identify the call, never a payload dump. */
function logArgs(args: unknown[]): (string | number)[] {
  return args.filter((a): a is string | number => typeof a === 'string' || typeof a === 'number');
}

/**
 * Register every contract channel. Returns a disposer removing all of them
 * (used on window teardown so a second window never re-registers a live
 * handler).
 */
export function registerIpc(handlers: IpcHandlers, fallbacks: IpcFallbacks): () => void {
  const methods = Object.keys(CHANNELS) as BridgeMethod[];
  for (const method of methods) {
    const channel = CHANNELS[method];
    const handler = handlers[method] as AnyHandler;
    const fallback = fallbacks[method] as () => unknown;
    ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
      const bad = checkArgs(method, args);
      if (bad !== null) {
        logger.error(`ipc ${channel} refused: invalid argument`, {
          arg: bad.arg,
          path: bad.path,
          reason: bad.message,
          args: logArgs(args),
        });
        return await fallback();
      }
      try {
        return await handler(...args);
      } catch (e) {
        logger.error(`ipc ${channel} failed`, { error: String(e), args: logArgs(args) });
        return await fallback();
      }
    });
  }
  return () => {
    for (const method of methods) ipcMain.removeHandler(CHANNELS[method]);
  };
}
