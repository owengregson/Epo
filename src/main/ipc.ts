/**
 * Typed IPC channel registration (main process side).
 *
 * Every renderer-invocable channel from the `EpoBridge` contract is registered
 * here and delegates to a single `Foundation` instance (the Wave 4 composition
 * root — see `foundation-wiring.ts`). The engine controls (`engine:*`) and the
 * manual live-gate ops (`foundation:*`) both route through the same real rim/Engine.
 * `tab:show`/`tab:hide` toggle the embedded tab's visibility directly.
 *
 * No silent catches: `Foundation` already returns typed results and logs its own
 * failures, so handlers delegate directly; the manual/read handlers keep a defensive
 * wrapper that logs and returns a typed failure so nothing rejects an opaque invoke.
 */

import { ipcMain } from 'electron';
import type { InstagramTab } from '@/adapter/tab';
import type { Foundation } from '@/main/foundation-wiring';
import * as logger from '@/utils/logger';
import type {
  ActionResult,
  ChainTargetView,
  FollowState,
  NetGrowthPoint,
  EpoStatus,
  PruneControlResult,
  PruneScanResult,
  PruneStatus,
  QueueListResult,
  ReadFollowersResult,
  SeedCheck,
} from '@/types';
import type { Settings } from '@/settings/settings';

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

  // --- Manual live-gate ops --------------------------------------------------

  ipcMain.handle('foundation:login', async (): Promise<EpoStatus> => {
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

  ipcMain.handle('foundation:status', async (): Promise<EpoStatus> => {
    return foundation.status();
  });

  // --- Engine controls -------------------------------------------------------

  ipcMain.handle('engine:start', async (): Promise<EpoStatus> => {
    logger.info('engine:start');
    return foundation.startEngine();
  });

  ipcMain.handle('engine:pause', async (): Promise<EpoStatus> => {
    logger.info('engine:pause');
    return foundation.pauseEngine();
  });

  ipcMain.handle('engine:resume', async (): Promise<EpoStatus> => {
    logger.info('engine:resume');
    return foundation.resumeEngine();
  });

  ipcMain.handle('engine:stop', async (): Promise<EpoStatus> => {
    logger.info('engine:stop');
    return foundation.stopEngine();
  });

  ipcMain.handle('engine:status', async (): Promise<EpoStatus> => {
    return foundation.status();
  });

  // --- Auto-prune controls (Phase 5) -----------------------------------------
  // Foundation returns typed results (mutual-exclusion refusals included); the
  // defensive wrapper guarantees nothing rejects an opaque invoke.

  ipcMain.handle('prune:scan', async (): Promise<PruneScanResult> => {
    try {
      logger.info('prune:scan');
      return await foundation.scanPrune();
    } catch (e) {
      logger.error('prune:scan failed', { error: String(e) });
      return { ok: false, reason: String(e), following: 0, followers: 0, candidates: [] };
    }
  });

  ipcMain.handle('prune:start', async (): Promise<PruneControlResult> => {
    try {
      logger.info('prune:start');
      return await foundation.startPrune();
    } catch (e) {
      logger.error('prune:start failed', { error: String(e) });
      return { ok: false, reason: String(e), status: await foundation.pruneStatus() };
    }
  });

  ipcMain.handle('prune:stop', async (): Promise<PruneStatus> => {
    try {
      logger.info('prune:stop');
      return await foundation.stopPrune();
    } catch (e) {
      logger.error('prune:stop failed', { error: String(e) });
      return await foundation.pruneStatus();
    }
  });

  ipcMain.handle('prune:status', async (): Promise<PruneStatus> => {
    return foundation.pruneStatus();
  });

  // --- Read-only list projections + settings (§5) ----------------------------
  // Foundation already logs and returns safe values on failure; the defensive
  // wrapper guarantees nothing rejects an opaque invoke.

  ipcMain.handle('chain:list', async (): Promise<ChainTargetView[]> => {
    try {
      return await foundation.chainList();
    } catch (e) {
      logger.error('chain:list failed', { error: String(e) });
      return [];
    }
  });

  ipcMain.handle('growth:series', async (_e, days: number): Promise<NetGrowthPoint[]> => {
    try {
      return await foundation.growthSeries(days);
    } catch (e) {
      logger.error('growth:series failed', { error: String(e) });
      return [];
    }
  });

  ipcMain.handle('seed:check', async (_e, username: string): Promise<SeedCheck> => {
    try {
      return await foundation.checkSeed(username);
    } catch (e) {
      logger.error('seed:check failed', { error: String(e) });
      return { ok: false, exists: false, followersVisible: false, isPrivate: false, reason: 'error' };
    }
  });

  ipcMain.handle(
    'queue:list',
    async (_event, state: FollowState): Promise<QueueListResult> => {
      try {
        return await foundation.queueList(state);
      } catch (e) {
        logger.error('queue:list failed', { state, error: String(e) });
        return { rows: [], truncated: false };
      }
    },
  );

  ipcMain.handle('settings:get', async (): Promise<Settings> => {
    return foundation.getSettings();
  });

  ipcMain.handle(
    'settings:update',
    async (_event, partial: Partial<Settings>): Promise<Settings> => {
      logger.info('settings:update');
      return foundation.updateSettings(partial);
    },
  );

  ipcMain.handle('settings:reset', async (): Promise<Settings> => {
    try {
      logger.info('settings:reset');
      return await foundation.resetSettings();
    } catch (e) {
      logger.error('settings:reset failed', { error: String(e) });
      return await foundation.getSettings();
    }
  });

  ipcMain.handle('data:clear', async (): Promise<EpoStatus> => {
    try {
      logger.info('data:clear');
      return await foundation.clearData();
    } catch (e) {
      logger.error('data:clear failed', { error: String(e) });
      return await foundation.status();
    }
  });

  // --- Tab visibility --------------------------------------------------------

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
    'engine:start',
    'engine:pause',
    'engine:resume',
    'engine:stop',
    'engine:status',
    'prune:scan',
    'prune:start',
    'prune:stop',
    'prune:status',
    'chain:list',
    'growth:series',
    'seed:check',
    'queue:list',
    'settings:get',
    'settings:update',
    'settings:reset',
    'data:clear',
    'tab:show',
    'tab:hide',
  ];
  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
}
