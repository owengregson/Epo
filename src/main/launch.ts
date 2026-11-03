/**
 * The window launch (spec §12.8): a hidden shell, the Foundation, the module graph and IPC, and only then the
 * dashboard load; its first load reveals the window. Each part lands in the handles as it is built.
 */

import * as path from 'node:path';
import { app, type BaseWindow, Menu } from 'electron';
import type { InstagramTab } from '@/adapter/tab';
import { PUSH, type PushContract, type PushMethod } from '@/ipc/contract';
import { BOOT } from '@/kernel/boot-policy';
import { type App, composeApp } from '@/main/app';
import { ConnectivityMonitor } from '@/main/connectivity';
import { Foundation } from '@/main/foundation-wiring';
import { registerEpoIpc } from '@/main/ipc';
import type { OverlayVeil } from '@/main/overlay/veil-view';
import { electronIgSession } from '@/main/services/ig-session';
import { buildAppMenu } from '@/main/window/app-menu';
import { createAppShell } from '@/main/window/shell';
import { createStageController, statusPosture } from '@/main/window/stage-controller';
import type { LogEntry, LogLevel } from '@/shared/log-entry';
import * as logger from '@/utils/logger';

/** The live parts of the window; main reads them for focus, incidents and ordered disposal. */
export interface LaunchHandles {
  mainWindow: BaseWindow | null;
  instagramTab: InstagramTab | null;
  overlayVeil: OverlayVeil | null;
  foundation: Foundation | null;
  disposeIpc: (() => void) | null;
  connectivityMonitor: ConnectivityMonitor | null;
  /** The composed module graph (`src/main/app.ts`) — disposed on quit. */
  composedApp: App | null;
}

export interface LaunchEnv {
  /** Filled as each part is built, so a launch that fails midway still disposes what it made. */
  handles: LaunchHandles;
}

/** Where the main window's persisted geometry lives (a settings-file sibling). */
function windowStateFile(): string {
  return path.join(app.getPath('userData'), 'window-state.json');
}

export async function launchWindow(env: LaunchEnv): Promise<LaunchHandles> {
  const h = env.handles;
  // Hidden until the dashboard has painted; the page loads only once IPC answers (below).
  const shell = createAppShell({ windowStateFile: windowStateFile(), startHidden: true, deferDashboardLoad: true,
    onDashboardBlocked: (reason) => h.foundation?.stopForIncident(reason) });
  const { win, tab, veil } = shell;
  h.mainWindow = win;
  h.instagramTab = tab;
  h.overlayVeil = veil;
  win.on('closed', () => {
    h.mainWindow = null;
  });
  // The one entry point for the stage (spec §12.4): the tab sits under the dashboard from frame 1.
  const stage = createStageController({ shell, veil, dock: app.dock ?? null,
    timing: { paintMaxMs: BOOT.CURTAIN_PAINT_MAX_MS, fadeMs: BOOT.CURTAIN_FADE_MS } });
  stage.cover();

  /**
   * The typed push seam. Every main→renderer channel string comes from the
   * contract's `PUSH` table and the payload is checked against `PushContract`,
   * so a channel can no longer be misspelled here or drift from what preload
   * subscribes to (ADR 1008). Each status also titles the window and badges the Dock.
   */
  const push = <C extends PushMethod>(channel: C, payload: PushContract[C]): void => {
    shell.send(PUSH[channel], payload);
    if (channel === 'status') stage.onPosture(statusPosture(payload as PushContract['status'], Date.now()));
  };
  // ⌘1–⌘5 and ⌘, work while Instagram has focus; Windows and Linux hide the menu bar until Alt.
  const isMac = process.platform === 'darwin';
  Menu.setApplicationMenu(buildAppMenu({ onStage: (mode) => push('stageRequest', mode), isPackaged: app.isPackaged, isMac }));
  if (!isMac) win.setAutoHideMenuBar(true);

  // Stream structured logs to the renderer's log pane.
  logger.setSink((level: LogLevel, message: string, meta?: unknown) => {
    const entry: LogEntry = { level, message, meta, at: Date.now() };
    push('log', entry);
  });

  // --- Foundation (composition root) ---------------------------------------
  // Status projections are PUSHED, not polled. The veil mirrors the
  // Foundation's TabActivity state machine: it is up (and blocking the tab)
  // exactly while ANY routine holds the page — graph build/identity
  // navigation, the growth loop, a prune scan/run from the moment the IPC
  // lands, and every manual one-off op — not merely while a status projection
  // reads `running`.
  // Electron seams the composition root must not own itself: the userData
  // directory and the persistent IG session (identity cookie + logout wipe).
  const host = { userDataDir: app.getPath('userData'), igSession: electronIgSession(), push };

  const found = new Foundation({
    tab,
    userDataDir: host.userDataDir,
    igSession: host.igSession,
    tabFirstLoad: shell.igFirstLoad,
    // Digital cursor: mirror the Interactor's simulated pointer onto the veil.
    // The tap observes synthetic driver output only — the user's real mouse
    // never reaches it (and the veil page itself has no mouse listeners).
    cursorObserver: {
      moved: (x, y) => veil.cursorMoved(x, y),
      pressed: (down) => veil.cursorPressed(down),
    },
    onActivity: (active) => veil.setActive(active),
    // Live phase readout on the veil: each tab-driving layer reports what it is
    // doing (direct JSON-API reads vs real page driving) as it starts, and
    // clears when done — so the overlay shows "API · Reading follower list · 250"
    // instead of only the static "Working" chip.
    activityReporter: {
      report: (info) => veil.setActivity(info),
      clear: () => veil.setActivity(null),
    },
    // One push seam for every store-derived projection; which projections ride
    // it is the PROJECTIONS table in `main/modules/projections.ts` (§2).
    push,
    // Post-wake immediate connectivity re-probe: stop+start is the monitor's
    // public way to force one (start's first check is immediate). Closure over
    // the module ref — the monitor is constructed just below.
    requestConnectivityCheck: () => {
      h.connectivityMonitor?.stop();
      h.connectivityMonitor?.start();
    },
  });
  h.foundation = found;

  // First launch (intro tour pending): park the app BEFORE any self-starting
  // work below (profile landing, scheduled-prune watcher) can begin — the tour
  // must run over a quiet app. The renderer's tour releases the hold when it
  // closes ('tour:hold'), which then runs the deferred startup work.
  if (found.tourPending()) found.setTourHold(true);

  // --- The module graph (src/main/app.ts) ----------------------------------
  // The self-updater (docs/RELEASE.md §5) is a MODULE now: built, STARTED and
  // disposed by the kernel rather than by three hand-placed calls here.
  // Constructed there and ONLY there — never through the Foundation: jest
  // builds Foundation with no electron mock, and electron-updater requires
  // electron at module load. Dev runs resolve to mode 'off' and never check
  // anything. Its three channels ride the same contract/disposer as everything
  // else.
  const composed = await composeApp(host);
  h.composedApp = composed;
  const upd = composed.updater;

  h.disposeIpc = registerEpoIpc({
    tab,
    foundation: found,
    updater: upd,
    setStage: (mode, covered) => stage.set(mode, covered),
  });

  // --- Connectivity monitor (offline-hold for the engine loop) -------------
  const connectivity = new ConnectivityMonitor((online) => {
    h.foundation?.setConnectivity(online);
  });
  h.connectivityMonitor = connectivity;
  connectivity.start();

  // The dashboard loads against registered IPC; its first load reveals the window, the timer guards a page
  // that never finishes.
  const revealFallback = setTimeout(() => shell.reveal(), BOOT.SHOW_FALLBACK_MS);
  shell.onRendererLoad(() => {
    clearTimeout(revealFallback);
    shell.reveal();
  });
  shell.loadDashboard();

  // The startup sequence (spec §12.8): R2/R3 store-first, the landing and confirm-account behind the splash,
  // catch-up and a crash's resume after the reveal, all under the startup lease. The opt-in scheduled prune
  // starts once that lease is released, so due work still runs at launch and never contends with it.
  void found.startBoot()
    .then(() => found.startScheduledPruneWatcher())
    .catch((error: unknown) => logger.error('launch: startup sequence failed', { error: String(error) }));

  // Engine step watchdog: recovers a growth loop wedged on a never-settling
  // tab/CDP await (stop → tab reload + debugger re-attach → restart). Fires
  // only when the engine is silent past the stale window AND the DelayManager
  // holds no pending engine wait — a legitimate long park never trips it.
  found.startEngineStepWatchdog();

  logger.info('Epo window ready');
  return h;
}
