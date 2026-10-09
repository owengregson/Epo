/**
 * Electron entry point.
 *
 * Composes a single window that hosts, side by side:
 *   - the dashboard renderer (Preact control shell) on the left, and
 *   - the embedded, persistent Instagram tab (`InstagramTab`) on the right.
 *
 * All engine logic lives in the main process; the renderer only sends IPC and
 * renders state. The structured logger is streamed to the renderer so the log
 * pane is live.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { app, type BaseWindow, nativeImage, powerMonitor, powerSaveBlocker } from 'electron';
import type { InstagramTab } from '@/adapter/tab';
import { PUSH, type PushContract, type PushMethod } from '@/ipc/contract';
import { type App, composeApp } from '@/main/app';
import { bootstrapApp, ensureSingleInstance } from '@/main/bootstrap';
import { ConnectivityMonitor } from '@/main/connectivity';
import { Foundation } from '@/main/foundation-wiring';
import { registerEpoIpc } from '@/main/ipc';
import type { OverlayVeil } from '@/main/overlay/veil-view';
import { RuntimePower } from '@/main/runtime-power';
import { electronIgSession } from '@/main/services/ig-session';
import { createAppShell } from '@/main/window/shell';
import type { LogEntry, LogLevel } from '@/types';
import * as logger from '@/utils/logger';

// Identity + the background-survival switches, at module top level: the
// userData path derives from the app name, and the switches only take effect
// before `app.whenReady()`.
bootstrapApp();

/** The live window — read only by the single-instance focus handler. */
let mainWindow: BaseWindow | null = null;
let instagramTab: InstagramTab | null = null;
let overlayVeil: OverlayVeil | null = null;
let foundation: Foundation | null = null;
let _disposeIpc: (() => void) | null = null;
let connectivityMonitor: ConnectivityMonitor | null = null;
/** The composed module graph (`src/main/app.ts`) — disposed on quit. */
let composedApp: App | null = null;
let runtimePower: RuntimePower | null = null;

/** Where the main window's persisted geometry lives (a settings-file sibling). */
function windowStateFile(): string {
  return path.join(app.getPath('userData'), 'window-state.json');
}

async function createWindow(): Promise<void> {
  const shell = createAppShell({ windowStateFile: windowStateFile() });
  const { win, tab, veil } = shell;
  mainWindow = win;
  instagramTab = tab;
  overlayVeil = veil;
  win.on('closed', () => {
    mainWindow = null;
  });

  /**
   * The typed push seam. Every main→renderer channel string comes from the
   * contract's `PUSH` table and the payload is checked against `PushContract`,
   * so a channel can no longer be misspelled here or drift from what preload
   * subscribes to (ADR 1008).
   */
  const push = <C extends PushMethod>(channel: C, payload: PushContract[C]): void => {
    shell.send(PUSH[channel], payload);
  };

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
      connectivityMonitor?.stop();
      connectivityMonitor?.start();
    },
  });
  foundation = found;

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
  composedApp = composed;
  const upd = composed.updater;
  // The renderer may finish loading after the launch check settled — replay
  // the current status so the Updates card never starts blank.
  shell.onRendererLoad(() => push('updateStatus', upd.current()));

  _disposeIpc = registerEpoIpc({
    tab,
    foundation: found,
    updater: upd,
    setStage: shell.setStage,
  });

  // Default page: rest on the user's OWN profile, not the home feed. The
  // Foundation waits for the logged-in graph, then the Interactor moves the
  // simulated cursor to the nav avatar link and clicks it (under the veil's
  // activity machine). A logged-out tab quietly stays on the login page.
  void found.landOnOwnProfile();

  // --- Connectivity monitor (offline-hold for the engine loop) -------------
  const connectivity = new ConnectivityMonitor((online) => {
    foundation?.setConnectivity(online);
  });
  connectivityMonitor = connectivity;
  connectivity.start();

  // Opt-in scheduled auto-prune: fires a prune run when the user's
  // `pruneScheduleDays` cadence is due and it is safe (tab free, active hours).
  // No-op unless the user enabled a schedule; cleared in the foundation's dispose.
  found.startScheduledPruneWatcher();

  // Engine step watchdog: recovers a growth loop wedged on a never-settling
  // tab/CDP await (stop → tab reload + debugger re-attach → restart). Fires
  // only when the engine is silent past the stale window AND the DelayManager
  // holds no pending engine wait — a legitimate long park never trips it.
  found.startEngineStepWatchdog();

  logger.info('Epo window ready');
}

/**
 * Unpackaged runs (`npm run dev` / `npm start`) have no .app bundle for macOS
 * to read an icon from, so the Dock shows Electron's stock icon. Set it
 * explicitly from the source asset. Packaged builds skip this — the bundle's
 * `icon.icns` (electron-builder, from `build/`) is authoritative there.
 */
function setDevDockIcon(): void {
  if (process.platform !== 'darwin' || app.isPackaged) return;
  // Bundled main lives at dist/main/main.js; the icon stays in build/.
  const iconPath = path.resolve(__dirname, '../../build/icon.png');
  if (!fs.existsSync(iconPath)) return;
  const icon = nativeImage.createFromPath(iconPath);
  if (!icon.isEmpty()) app.dock?.setIcon(icon);
}

// A second process would open a second window over the SAME epo.db and the same
// `persist:ig` partition; SQLite will not stop it. Take the lock before
// anything else runs.
const isPrimaryInstance = ensureSingleInstance(() => {
  if (mainWindow === null || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.whenReady().then(() => {
  if (!isPrimaryInstance) return;
  setDevDockIcon();
  // Protect main-process pacing and durable wake schedules while the display
  // sleeps. Forced system sleep still needs the ordered Foundation recovery.
  runtimePower = new RuntimePower({
    blocker: powerSaveBlocker,
    monitor: powerMonitor,
    suspend: () => foundation?.suspendForSleep(),
    resume: async () => foundation?.resumeFromSleep(),
  });
  runtimePower.start();
  void createWindow().catch((e: unknown) => {
    logger.error('main: window composition failed', { error: String(e) });
  });

  // NB: no `activate` → createWindow() handler. `window-all-closed` always
  // quits (below), so a live app never has a null window to re-create — and
  // re-running createWindow() would re-register live IPC handlers (a throw)
  // and construct a second Foundation/InstagramTab over the first.
});

// Closing the window closes the whole app — including the engine loop, the
// knowledge store, and the persistent Instagram session — on every platform.
app.on('window-all-closed', () => {
  app.quit();
});

// Graceful shutdown: stop the engine, await its loop, close the store, then the
// tab + veil, and only then exit. `before-quit` is preventable, so we defer the
// exit until dispose settles (guarded against re-entry).
let shuttingDown = false;
app.on('before-quit', (event) => {
  if (shuttingDown) return;
  shuttingDown = true;
  event.preventDefault();
  runtimePower?.stopWatching();

  // NB: we deliberately do NOT remove the IPC handlers here. The renderer's
  // in-flight polling invokes (chain:list / growth:series) can still drain after
  // the window closes; leaving the handlers registered lets them resolve to safe
  // empties (Foundation is `disposing`, so no rebuild) instead of logging
  // "No handler registered". Everything is freed when the process exits below.
  const finish = (): void => {
    _disposeIpc = null;
    connectivityMonitor?.stop();
    connectivityMonitor = null;
    instagramTab?.dispose();
    instagramTab = null;
    overlayVeil?.dispose();
    overlayVeil = null;
    runtimePower?.dispose();
    runtimePower = null;
    app.exit(0);
  };

  // The module graph releases in the exact reverse of the order it started
  // (the kernel's guarantee, so nothing here maintains a teardown list).
  const composed = composedApp;
  composedApp = null;
  const disposeModules = (): Promise<void> =>
    composed === null
      ? Promise.resolve()
      : composed
          .dispose()
          .catch((e: unknown) =>
            logger.error('main: module dispose failed', { error: String(e) }),
          );

  const found = foundation;
  foundation = null;
  if (found) {
    found
      .dispose()
      .catch((e: unknown) => logger.error('main: foundation dispose failed', { error: String(e) }))
      .then(disposeModules)
      .finally(finish);
  } else {
    void disposeModules().finally(finish);
  }
});
