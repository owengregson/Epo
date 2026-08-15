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

import { app, BaseWindow, WebContentsView, nativeImage, powerSaveBlocker } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { IG_HOME_URL, InstagramTab } from '@/adapter/tab';
import { OverlayVeil } from '@/main/overlay/veil-view';
import { Foundation } from '@/main/foundation-wiring';
import { ConnectivityMonitor } from '@/main/connectivity';
import { registerIpc } from '@/main/ipc';
import * as logger from '@/utils/logger';
import type { LogEntry, LogLevel } from '@/types';

// ---------------------------------------------------------------------------
// Background-run survival (measured, 2026-08-14 input lab):
//
// With stock settings, ANY backgrounded state — window blurred, occluded by
// another window, hidden, or minimized — marks the page `visibilityState:
// 'hidden'`, stops requestAnimationFrame COMPLETELY (0 frames vs 180/1.5s),
// and clamps timers ~15× (escalating to ~1/minute after 5 min hidden). CDP
// input still arrives, but Instagram's SPA cannot hydrate pages or advance its
// UI state machine in that state, so every action times out. These switches
// (plus `backgroundThrottling: false` on the tab, set in `tab.ts`) keep the
// renderer fully alive regardless of window state — verified: all background
// scenarios then measure identical to foreground.
// Must run before `app.whenReady()`.
// ---------------------------------------------------------------------------
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

/** Fixed width of the dashboard sidebar; the IG tab fills the remainder. */
const SIDEBAR_WIDTH = 460;

// Kept for parity with the view refs (cleared on 'closed'); nothing reads it
// since the activate→createWindow path was removed (see app.whenReady below).
let _mainWindow: BaseWindow | null = null;
let _dashboardView: WebContentsView | null = null;
let instagramTab: InstagramTab | null = null;
let overlayVeil: OverlayVeil | null = null;
let foundation: Foundation | null = null;
let _disposeIpc: (() => void) | null = null;
let connectivityMonitor: ConnectivityMonitor | null = null;

function createWindow(): void {
  const win = new BaseWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 640,
    title: 'Epo',
    backgroundColor: '#0e0e10',
  });
  _mainWindow = win;

  // --- Dashboard renderer (left) ------------------------------------------
  const dash = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  _dashboardView = dash;
  win.contentView.addChildView(dash);
  void dash.webContents.loadFile(
    path.join(__dirname, '..', 'renderer', 'index.html'),
  );

  // --- Embedded Instagram tab (right) -------------------------------------
  const tab = new InstagramTab();
  instagramTab = tab;
  tab.attach(win);
  void tab.goto(IG_HOME_URL);

  // --- Activity veil (stacked above the tab) ------------------------------
  const veil = new OverlayVeil();
  overlayVeil = veil;
  veil.attach(win); // added after the tab → renders on top of it

  // --- Layout --------------------------------------------------------------
  const layout = (): void => {
    const { width, height } = win.getContentBounds();
    dash.setBounds({ x: 0, y: 0, width: SIDEBAR_WIDTH, height });
    const tabBounds = {
      x: SIDEBAR_WIDTH,
      y: 0,
      width: Math.max(0, width - SIDEBAR_WIDTH),
      height,
    };
    tab.setBounds(tabBounds);
    veil.setBounds(tabBounds); // the veil tracks the tab region exactly
  };
  win.on('resize', layout);
  layout();

  // --- Stream structured logs to the renderer log pane --------------------
  logger.setSink((level: LogLevel, message: string, meta?: unknown) => {
    const entry: LogEntry = { level, message, meta, at: Date.now() };
    if (!dash.webContents.isDestroyed()) {
      dash.webContents.send('epo:log', entry);
    }
  });

  // --- Foundation (composition root) + IPC ---------------------------------
  // Push each engine status projection to the renderer (§5 — pushed, not polled).
  // The veil mirrors the Foundation's TabActivity state machine: it is up
  // (and blocking the tab) exactly while ANY routine holds the page — graph
  // build/identity navigation, the growth loop, a prune scan/run from the moment
  // the IPC lands, and every manual one-off op — not merely while a status
  // projection reads `running`.
  const found = new Foundation({
    tab,
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
    onStatus: (status) => {
      if (!dash.webContents.isDestroyed()) {
        dash.webContents.send('epo:status', status);
      }
    },
    onPruneStatus: (status) => {
      if (!dash.webContents.isDestroyed()) {
        dash.webContents.send('epo:prune-status', status);
      }
    },
  });
  foundation = found;
  _disposeIpc = registerIpc({ tab, foundation: found });

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

  // Opt-in scheduled auto-prune (Phase 5): fires a prune run when the user's
  // `pruneScheduleDays` cadence is due and it is safe (growth idle, active hours).
  // No-op unless the user enabled a schedule; cleared in the foundation's dispose.
  found.startScheduledPruneWatcher();

  // Teardown runs on `before-quit` (below) so it can be awaited; closing the
  // window just drops the UI refs — `window-all-closed` then quits the app.
  win.on('closed', () => {
    _dashboardView = null;
    _mainWindow = null;
  });

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

app.whenReady().then(() => {
  setDevDockIcon();
  // macOS App Nap throttles the MAIN process's timers when the app is hidden —
  // the motion profile's step pacing and the engine's action-delay deadlines
  // all run on main-process timers, so an unattended run must never nap. Held
  // for the app's lifetime (released implicitly at process exit); the display
  // may still sleep — only app suspension is blocked.
  powerSaveBlocker.start('prevent-app-suspension');
  createWindow();

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
    app.exit(0);
  };

  const found = foundation;
  foundation = null;
  if (found) {
    found
      .dispose()
      .catch((e: unknown) => logger.error('main: foundation dispose failed', { error: String(e) }))
      .finally(finish);
  } else {
    finish();
  }
});
