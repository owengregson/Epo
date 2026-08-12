/**
 * Typed IPC channel registration (main process side).
 *
 * Every renderer-invocable channel from the `PeanutBridge` contract is
 * registered here and delegates to a single `Foundation` instance (the Phase 1
 * composition root — see `foundation-wiring.ts`). `tab:show`/`tab:hide` toggle
 * the embedded tab's visibility directly.
 *
 * No silent catches: every handler that can throw wraps the call, logs the
 * error, and returns a typed `{ ok: false, reason }` so failures surface in the
 * renderer instead of rejecting an opaque invoke.
 */

import { ipcMain } from 'electron';
import type { InstagramTab } from '@/adapter/tab';
import type { Foundation } from '@/main/foundation-wiring';
import * as logger from '@/utils/logger';
import type {
  ActionResult,
  FoundationStatus,
  ReadFollowersResult,
} from '@/types';

export interface IpcContext {
  tab: InstagramTab;
  foundation: Foundation;
}

/**
 * Register all renderer-invocable handlers. Returns a disposer that removes
 * every handler (used on window teardown to avoid duplicate registration).
 */
export function registerIpc(ctx: IpcContext): () => void {
  const { tab, foundation } = ctx;

  ipcMain.handle('foundation:login', async (): Promise<FoundationStatus> => {
    logger.info('foundation:login — opening Instagram in embedded tab');
    return foundation.login();
  });

  ipcMain.handle(
    'foundation:readFollowers',
    async (_event, target: string): Promise<ReadFollowersResult> => {
      try {
        return await foundation.readFollowers(target);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        logger.error('foundation:readFollowers failed', { target, error: reason });
        return { target, observed: 0 };
      }
    },
  );

  ipcMain.handle(
    'foundation:followOne',
    async (_event, username: string): Promise<ActionResult> => {
      try {
        return await foundation.followOne(username);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        logger.error('foundation:followOne failed', { username, error: reason });
        return { ok: false, username, reason };
      }
    },
  );

  ipcMain.handle(
    'foundation:unfollowOne',
    async (_event, username: string): Promise<ActionResult> => {
      try {
        return await foundation.unfollowOne(username);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        logger.error('foundation:unfollowOne failed', { username, error: reason });
        return { ok: false, username, reason };
      }
    },
  );

  ipcMain.handle('foundation:status', async (): Promise<FoundationStatus> => {
    return foundation.status();
  });

  ipcMain.handle('tab:show', async (): Promise<void> => {
    tab.show();
  });

  ipcMain.handle('tab:hide', async (): Promise<void> => {
    tab.hide();
  });

  const channels = [
    'foundation:login',
    'foundation:readFollowers',
    'foundation:followOne',
    'foundation:unfollowOne',
    'foundation:status',
    'tab:show',
    'tab:hide',
  ];
  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
}
