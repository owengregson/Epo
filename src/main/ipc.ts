/**
 * The main-process side of the IPC contract: one handler per bridge method.
 *
 * Handlers are thin — `Foundation` already returns typed results and logs its
 * own failures, so nothing here re-implements a fallible path. `registerIpc`
 * supplies the per-channel error guard and the disposer; the `fallbacks` map
 * below states what each channel answers with when a handler throws anyway.
 * Channel strings live only in `src/ipc/contract.ts`.
 */

import type { InstagramTab } from '@/adapter/tab';
import { type IpcFallbacks, type IpcHandlers, registerIpc } from '@/ipc/register';
import type { Foundation } from '@/main/foundation-wiring';
import { bootFallbacks, bootHandlers } from '@/main/ipc-boot';
import { liveFallbacks, liveHandlers } from '@/main/ipc-live';
import { planFallbacks, planHandlers } from '@/main/ipc-plan';
import { settingsFallbacks, settingsHandlers } from '@/main/ipc-settings';
import { surfaceFallbacks, surfaceHandlers } from '@/main/ipc-surface';
import { isStageMode } from '@/shared/stage-mode';
import type { EpoStatus, StageMode, UpdateStatus } from '@/types';
import * as logger from '@/utils/logger';

/**
 * The updater's renderer-facing surface, as a structural port: `updater.ts`
 * pulls in `electron-updater` (which requires electron at module load), so
 * nothing outside `main.ts` may import it.
 */
export interface UpdaterPort {
  check(): Promise<UpdateStatus>;
  install(): UpdateStatus | Promise<UpdateStatus>;
  openLatest(): Promise<void>;
  current(): UpdateStatus;
}

export interface IpcContext {
  tab: InstagramTab;
  foundation: Foundation;
  updater: UpdaterPort;
  /**
   * Swap what fills the window region right of the console: the Instagram tab
   * ('tab') or the renderer's Graph stage ('graph'). Owned by `main.ts`, which
   * holds the window layout. `covered` hides the native views regardless of
   * mode (a renderer modal is open and must not sit under them).
   */
  setStage(mode: StageMode, covered: boolean): void;
}

/** Register every contract channel; returns the disposer for window teardown. */
export function registerEpoIpc(ctx: IpcContext): () => void {
  const { foundation, updater, setStage } = ctx;
  const currentUpdate = () => updater.current();

  const handlers: IpcHandlers = {
    // --- Manual live-gate ops ------------------------------------------------
    login: () => {
      logger.info('foundation:login — opening Instagram in embedded tab');
      return foundation.login();
    },
    readFollowers: (target) => foundation.readFollowers(target),
    followOne: (username) => foundation.followOne(username),
    unfollowOne: (username) => foundation.unfollowOne(username),
    status: () => foundation.status(),

    // --- Engine controls -----------------------------------------------------
    startEngine: () => {
      logger.info('engine:start');
      return foundation.startEngine();
    },
    pauseEngine: () => {
      logger.info('engine:pause');
      return foundation.pauseEngine();
    },
    resumeEngine: () => {
      logger.info('engine:resume');
      return foundation.resumeEngine();
    },
    stopEngine: () => {
      logger.info('engine:stop');
      return foundation.stopEngine();
    },
    restartFromSeed: (seed) => {
      logger.info('engine:restartFromSeed');
      return foundation.restartFromSeed(seed);
    },
    engineStatus: () => foundation.status(),

    // --- Auto-prune controls -------------------------------------------------
    scanPrune: () => {
      logger.info('prune:scan');
      return foundation.scanPrune();
    },
    // Annotated by protection once the unfollow-decisions stream wires it; the base fields are today's.
    pruneCandidates: async () =>
      (await foundation.pruneCandidates()).map((c) => ({ ...c, protectedBy: null, bioUnread: false })),
    startPrune: () => {
      logger.info('prune:start');
      return foundation.startPrune();
    },
    stopPrune: () => {
      logger.info('prune:stop');
      return foundation.stopPrune();
    },
    pausePrune: () => {
      logger.info('prune:pause');
      return foundation.pausePrune();
    },
    resumePrune: () => {
      logger.info('prune:resume');
      return foundation.resumePrune();
    },
    pruneStatus: () => foundation.pruneStatus(),

    // --- Read-only list projections ------------------------------------------
    chainList: () => foundation.chainList(),
    chainDetail: (targetPk) => foundation.chainDetail(targetPk),
    growthSeries: (days) => foundation.growthSeries(days),
    queueList: (state) => foundation.queueList(state),
    clearData: () => {
      logger.info('data:clear');
      return foundation.clearData();
    },

    // --- Stage ----------------------------------------------------------------
    graphSnapshot: () => foundation.graphSnapshot(),
    // Renderer input is unvalidated at the boundary: only a known stage moves.
    setStage: (mode: unknown, covered: unknown) => {
      if (isStageMode(mode)) setStage(mode, covered === true);
      else logger.warn('stage: unknown mode refused', { mode: String(mode) });
    },
    // Park/unpark the app while the renderer's tour is on screen (see
    // Foundation.setTourHold). Main engages the hold itself at launch when the
    // tour is pending; the renderer releases it when the tour closes.
    setTourHold: (held: unknown) => {
      foundation.setTourHold(held === true);
    },

    // --- Self-updater --------------------------------------------------------
    checkForUpdate: () => updater.check(),
    installUpdate: () => updater.install(),
    openLatestRelease: () => updater.openLatest(),
    ...settingsHandlers(foundation),
    ...planHandlers(),
    ...liveHandlers(currentUpdate),
    ...bootHandlers(foundation),
    ...surfaceHandlers(),
  };

  // A refused/failed control still owes the renderer a real status: the
  // status-shaped fallbacks re-read the projection rather than fabricating one.
  const status = (): Promise<EpoStatus> => foundation.status();
  const pruneStatus = () => foundation.pruneStatus();

  const fallbacks: IpcFallbacks = {
    login: status,
    readFollowers: () => ({ target: '', observed: 0, ok: false, reason: 'error' }),
    followOne: () => ({ ok: false, username: '', reason: 'error' }),
    unfollowOne: () => ({ ok: false, username: '', reason: 'error' }),
    status,
    startEngine: status,
    pauseEngine: status,
    resumeEngine: status,
    stopEngine: status,
    restartFromSeed: status,
    engineStatus: status,
    scanPrune: () => ({ ok: false, reason: 'error', following: 0, followers: 0, candidates: [] }),
    pruneCandidates: () => [],
    startPrune: async () => ({ ok: false, reason: 'error', status: await pruneStatus() }),
    stopPrune: pruneStatus,
    pausePrune: pruneStatus,
    resumePrune: pruneStatus,
    pruneStatus,
    chainList: () => [],
    chainDetail: () => null,
    growthSeries: () => ({ points: [], baselineAt: null }),
    queueList: () => ({ rows: [], truncated: false }),
    clearData: status,
    graphSnapshot: () => null,
    setStage: () => undefined,
    setTourHold: () => undefined,
    checkForUpdate: () => updater.current(),
    installUpdate: () => updater.current(),
    openLatestRelease: () => undefined,
    ...settingsFallbacks(foundation),
    ...planFallbacks(),
    ...liveFallbacks(currentUpdate),
    ...bootFallbacks(),
    ...surfaceFallbacks(),
  };

  return registerIpc(handlers, fallbacks);
}
