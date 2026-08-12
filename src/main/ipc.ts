/**
 * Typed IPC channel registration (main process side).
 *
 * Every renderer-invocable channel from the `PeanutBridge` contract is
 * registered here. Handlers that depend on not-yet-built modules (the
 * KnowledgeStore, the Instagram Adapter, the governors) return typed
 * placeholder values and are marked `TODO(phase1-wiring)`. The real
 * composition happens in Task 9 (`foundation-wiring.ts`), which will replace
 * these stub bodies while keeping the exact same channel contract.
 */

import { ipcMain } from 'electron';
import type { InstagramTab } from '@/adapter/tab';
import { IG_HOME_URL } from '@/adapter/tab';
import * as logger from '@/utils/logger';
import type {
  ActionResult,
  FoundationStatus,
  ReadFollowersResult,
} from '@/types';

// Defaults from Global Constraints (§9): hard ceiling 50, operating rate 25.
// The real values come from Settings once the governors are wired (Task 9).
const DEFAULT_DAILY_HARD_CEILING = 50;
const DEFAULT_DAILY_OPERATING_RATE = 25;

export interface IpcContext {
  tab: InstagramTab;
}

/**
 * Register all renderer-invocable handlers. Returns a disposer that removes
 * every handler (used on window teardown to avoid duplicate registration).
 */
export function registerIpc(ctx: IpcContext): () => void {
  const { tab } = ctx;

  ipcMain.handle('foundation:login', async (): Promise<void> => {
    logger.info('foundation:login — opening Instagram in embedded tab');
    tab.show();
    await tab.goto(IG_HOME_URL);
  });

  ipcMain.handle(
    'foundation:readFollowers',
    async (_event, target: string): Promise<ReadFollowersResult> => {
      // TODO(phase1-wiring): drive Reader over tab.onResponse and write each
      // observed follower into KnowledgeStore.observe(...). Task 9.
      logger.info('foundation:readFollowers (stub)', { target });
      return { target, observed: 0 };
    },
  );

  ipcMain.handle(
    'foundation:followOne',
    async (_event, username: string): Promise<ActionResult> => {
      // TODO(phase1-wiring): gate behind RateGovernor + RequestBudget, run
      // Sentinel.check(), then Actor.follow(); record action + edge. Task 9.
      logger.info('foundation:followOne (stub)', { username });
      return { ok: false, username, reason: 'not-wired (phase1-wiring pending)' };
    },
  );

  ipcMain.handle(
    'foundation:unfollowOne',
    async (_event, username: string): Promise<ActionResult> => {
      // TODO(phase1-wiring): same gating as followOne, then Actor.unfollow().
      logger.info('foundation:unfollowOne (stub)', { username });
      return { ok: false, username, reason: 'not-wired (phase1-wiring pending)' };
    },
  );

  ipcMain.handle('foundation:status', async (): Promise<FoundationStatus> => {
    // TODO(phase1-wiring): source loggedIn from Sentinel, action counts from
    // KnowledgeStore.actionCountSince(...), and rates from Settings. Task 9.
    const currentUrl = tab.currentUrl();
    const loggedIn =
      currentUrl.startsWith('https://www.instagram.com/') &&
      !currentUrl.includes('/accounts/login');
    return {
      loggedIn,
      currentUrl,
      actionsToday: 0,
      remainingToday: DEFAULT_DAILY_OPERATING_RATE,
      dailyHardCeiling: DEFAULT_DAILY_HARD_CEILING,
      dailyOperatingRate: DEFAULT_DAILY_OPERATING_RATE,
    };
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
