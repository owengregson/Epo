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

import { app, BaseWindow, WebContentsView } from 'electron';
import * as path from 'node:path';
import { InstagramTab } from '@/adapter/tab';
import { OverlayVeil } from '@/main/overlay/veil-view';
import { Foundation } from '@/main/foundation-wiring';
import { ConnectivityMonitor } from '@/main/connectivity';
import { registerIpc } from '@/main/ipc';
import * as logger from '@/utils/logger';
import type { LogEntry, LogLevel } from '@/types';

/** Fixed width of the dashboard sidebar; the IG tab fills the remainder. */
const SIDEBAR_WIDTH = 460;

let mainWindow: BaseWindow | null = null;
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
  mainWindow = win;

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
  void tab.goto('https://www.instagram.com/');

  // --- Automation veil (stacked above the tab) ----------------------------
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
  // The veil is up (and blocking the tab) whenever an automated routine is
  // driving Instagram — the growth engine running, OR the auto-prune scanning or
  // unfollowing. The two states arrive on separate status streams (and during a
  // prune hand-off growth is PAUSED while prune drives), so track each and raise
  // the veil when either is active.
  let veilGrowthActive = false;
  let veilPruneActive = false;
  const refreshVeil = (): void => veil.setActive(veilGrowthActive || veilPruneActive);
  const found = new Foundation({
    tab,
    onStatus: (status) => {
      if (!dash.webContents.isDestroyed()) {
        dash.webContents.send('epo:status', status);
      }
      veilGrowthActive = status.state === 'running';
      refreshVeil();
    },
    onPruneStatus: (status) => {
      if (!dash.webContents.isDestroyed()) {
        dash.webContents.send('epo:prune-status', status);
      }
      veilPruneActive = status.state === 'scanning' || status.state === 'running';
      refreshVeil();
    },
  });
  foundation = found;
  _disposeIpc = registerIpc({ tab, foundation: found });

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
    mainWindow = null;
  });

  logger.info('Epo window ready');
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (!shuttingDown && mainWindow === null) createWindow();
  });
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
