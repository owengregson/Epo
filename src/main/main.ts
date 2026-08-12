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
import * as path from 'path';
import { InstagramTab } from '@/adapter/tab';
import { registerIpc } from '@/main/ipc';
import * as logger from '@/utils/logger';
import type { LogEntry, LogLevel } from '@/types';

/** Fixed width of the dashboard sidebar; the IG tab fills the remainder. */
const SIDEBAR_WIDTH = 460;

let mainWindow: BaseWindow | null = null;
let dashboardView: WebContentsView | null = null;
let instagramTab: InstagramTab | null = null;
let disposeIpc: (() => void) | null = null;

function createWindow(): void {
  const win = new BaseWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 640,
    title: 'Peanut',
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
  dashboardView = dash;
  win.contentView.addChildView(dash);
  void dash.webContents.loadFile(
    path.join(__dirname, '..', 'renderer', 'index.html'),
  );

  // --- Embedded Instagram tab (right) -------------------------------------
  const tab = new InstagramTab();
  instagramTab = tab;
  tab.attach(win);
  void tab.goto('https://www.instagram.com/');

  // --- Layout --------------------------------------------------------------
  const layout = (): void => {
    const { width, height } = win.getContentBounds();
    dash.setBounds({ x: 0, y: 0, width: SIDEBAR_WIDTH, height });
    tab.setBounds({
      x: SIDEBAR_WIDTH,
      y: 0,
      width: Math.max(0, width - SIDEBAR_WIDTH),
      height,
    });
  };
  win.on('resize', layout);
  layout();

  // --- Stream structured logs to the renderer log pane --------------------
  logger.setSink((level: LogLevel, message: string, meta?: unknown) => {
    const entry: LogEntry = { level, message, meta, at: Date.now() };
    if (!dash.webContents.isDestroyed()) {
      dash.webContents.send('peanut:log', entry);
    }
  });

  // --- IPC -----------------------------------------------------------------
  disposeIpc = registerIpc({ tab });

  win.on('closed', () => {
    disposeIpc?.();
    disposeIpc = null;
    instagramTab?.dispose();
    instagramTab = null;
    dashboardView = null;
    mainWindow = null;
  });

  logger.info('Peanut window ready');
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (mainWindow === null) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
