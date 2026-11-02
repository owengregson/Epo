/**
 * The app window: geometry, the three stacked views, and the stage swap.
 *
 * One `BaseWindow` hosts, side by side, the dashboard renderer (Preact control
 * shell) on the left and the embedded, persistent Instagram tab on the right,
 * with the activity veil stacked above the tab. Everything here is layout and
 * plumbing — no engine, no IPC, no updater; `main.ts` composes those around the
 * shell this returns.
 *
 * View stacking order is load-bearing: the dashboard is added first (bottom,
 * full window), then the tab, then the veil on top of it.
 */

import * as path from 'node:path';
import { BaseWindow, screen, WebContentsView } from 'electron';
import { IG_HOME_URL, InstagramTab } from '@/adapter/tab';
import { OverlayVeil } from '@/main/overlay/veil-view';
import { DashboardRecovery } from '@/main/services/dashboard-recovery';
import {
  loadWindowState,
  MIN_WINDOW,
  saveWindowState,
  type WindowState,
} from '@/main/window-state';
import type { StageMode } from '@/types';
import * as logger from '@/utils/logger';

/** Fixed width of the dashboard sidebar; the IG tab fills the remainder. */
const SIDEBAR_WIDTH = 460;

/** Height of the renderer's stage bar — must match `.stagebar` in graph.css. */
const STAGE_BAR_HEIGHT = 44;

/** Debounce for geometry persistence — resize/move fire per frame. */
const BOUNDS_PERSIST_MS = 500;

export interface AppShell {
  win: BaseWindow;
  tab: InstagramTab;
  veil: OverlayVeil;
  /**
   * Swap what fills the region right of the console. 'graph'/'prune' hide the
   * tab beneath the opaque dashboard while its native view keeps rendering;
   * native visibility must stay enabled for acknowledged CDP input. The veil
   * stays out of the way; 'tab' restores both. `covered` conceals them on 'tab'
   * too: native views float above everything the renderer draws, so an open
   * renderer modal (whole-window scrim + dialog) needs them out of the way.
   */
  setStage(mode: StageMode, covered: boolean): void;
  /** Push on a renderer event channel, unless the view is already destroyed. */
  send(channel: string, payload: unknown): void;
  /** Run `cb` every time the renderer finishes loading (status replay). */
  onRendererLoad(cb: () => void): void;
}

export interface AppShellOptions {
  /** Where the window's persisted geometry file lives. */
  windowStateFile: string;
  onDashboardBlocked?(reason: string): void;
}

export function createAppShell(opts: AppShellOptions): AppShell {
  // Reopen with the geometry the last session closed with. The saved position
  // is validated against the CURRENT displays (an unplugged monitor drops it
  // back to OS placement, never an off-screen window).
  const displays = screen.getAllDisplays().map((d) => d.workArea);
  const state = loadWindowState(opts.windowStateFile, displays);
  const win = new BaseWindow({
    width: state.width,
    height: state.height,
    ...(state.x !== undefined && state.y !== undefined ? { x: state.x, y: state.y } : {}),
    minWidth: MIN_WINDOW.width,
    minHeight: MIN_WINDOW.height,
    title: 'Epo',
    backgroundColor: '#0e0e10',
  });
  if (state.maximized) win.maximize();

  // getNormalBounds() keeps reporting the un-maximized rect while maximized, so
  // a maximized close still restores to a sane normal size.
  let boundsTimer: ReturnType<typeof setTimeout> | null = null;
  const persistBounds = (): void => {
    if (win.isDestroyed()) return;
    const b = win.getNormalBounds();
    const next: WindowState = {
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      maximized: win.isMaximized(),
    };
    try {
      saveWindowState(opts.windowStateFile, next);
    } catch (e) {
      logger.warn('shell: window-state persist failed', { error: String(e) });
    }
  };
  const queuePersistBounds = (): void => {
    if (boundsTimer !== null) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(persistBounds, BOUNDS_PERSIST_MS);
  };
  win.on('move', queuePersistBounds);
  win.on('maximize', queuePersistBounds);
  win.on('unmaximize', queuePersistBounds);
  win.on('close', () => {
    if (boundsTimer !== null) clearTimeout(boundsTimer);
    persistBounds();
  });

  // --- Dashboard renderer (left) --------------------------------------------
  const dash = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Bottom layer, full window: the page renders the console column PLUS the
  // stage area (the stage bar and, in graph mode, the graph canvas).
  win.contentView.addChildView(dash);
  const dashboardFile = path.join(__dirname, '..', 'renderer', 'index.html');
  const dashboard = new DashboardRecovery({
    load: () => dash.webContents.loadFile(dashboardFile),
    available: () => !win.isDestroyed() && !dash.webContents.isDestroyed(),
    blocked: (reason) => opts.onDashboardBlocked?.(reason),
  });
  dash.webContents.on('render-process-gone', (_event, details) => {
    dashboard.failed(details.reason);
  });
  dash.webContents.on('unresponsive', () => dashboard.failed('unresponsive'));
  win.on('closed', () => dashboard.stop());
  dashboard.load();

  // --- Embedded Instagram tab (right) ---------------------------------------
  const tab = new InstagramTab();
  tab.attach(win);
  void tab.goto(IG_HOME_URL).catch((error: unknown) => logger.warn('shell: initial tab load failed', { error: String(error) }));

  // --- Activity veil (stacked above the tab) --------------------------------
  const veil = new OverlayVeil();
  veil.attach(win); // added after the tab → renders on top of it

  // --- Layout ----------------------------------------------------------------
  // The stage bar (the renderer's Instagram ⟷ Graph selector) owns the top
  // strip of the stage area, so the tab view starts below it.
  const layout = (): void => {
    const { width, height } = win.getContentBounds();
    dash.setBounds({ x: 0, y: 0, width, height });
    const tabBounds = {
      x: SIDEBAR_WIDTH,
      y: STAGE_BAR_HEIGHT,
      width: Math.max(0, width - SIDEBAR_WIDTH),
      height: Math.max(0, height - STAGE_BAR_HEIGHT),
    };
    tab.setBounds(tabBounds);
    veil.setBounds(tabBounds); // the veil tracks the tab region exactly
  };
  win.on('resize', () => {
    layout();
    queuePersistBounds();
  });
  layout();

  return {
    win,
    tab,
    veil,
    setStage: (mode, covered) => {
      if (mode === 'tab' && !covered) {
        tab.show();
        veil.setObscured(false);
      } else {
        tab.hide();
        veil.setObscured(true);
      }
    },
    send: (channel, payload) => {
      if (!dash.webContents.isDestroyed()) dash.webContents.send(channel, payload);
    },
    onRendererLoad: (cb) => {
      dash.webContents.on('did-finish-load', cb);
    },
  };
}
