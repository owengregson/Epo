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
import { SHELL_GEOMETRY } from '@/kernel/shell-geometry';
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
const SIDEBAR_WIDTH = SHELL_GEOMETRY.SIDEBAR_WIDTH_PX;

/** Height of the renderer's stage bar — must match `.stagebar` in shell.css. */
const STAGE_BAR_HEIGHT = SHELL_GEOMETRY.STAGE_BAR_HEIGHT_PX;

/** The window and dashboard background: the renderer's `--bg`, so no frame ever paints another colour. */
const BACKGROUND = '#0d0d0f';

/** Debounce for geometry persistence — resize/move fire per frame. */
const BOUNDS_PERSIST_MS = SHELL_GEOMETRY.BOUNDS_PERSIST_MS;

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
  /** The tab's first navigation to the home page: 'ready' once it settles, 'failed' when it threw. */
  igFirstLoad: Promise<'ready' | 'failed'>;
  /** Load the dashboard page held back by `deferDashboardLoad` (idempotent; a no-op once loaded). */
  loadDashboard(): void;
  /** Show a window built hidden — maximized when its saved state was — then focus it (idempotent). */
  reveal(): void;
}

export interface AppShellOptions {
  /** Where the window's persisted geometry file lives. */
  windowStateFile: string;
  onDashboardBlocked?(reason: string): void;
  /** Build the window hidden until `reveal()` (default: shown at construction, as before). */
  startHidden?: boolean;
  /** Hold the dashboard load until `loadDashboard()` (default: loaded at once, as before). */
  deferDashboardLoad?: boolean;
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
    backgroundColor: BACKGROUND,
    show: opts.startHidden !== true,
  });
  // A hidden window maximizes at reveal(): maximize() on a never-shown window would show it.
  let revealed = opts.startHidden !== true;
  if (state.maximized && revealed) win.maximize();

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
  dash.setBackgroundColor(BACKGROUND);
  let dashboardOwnsStage = false;
  let handingOffFocus = false;
  const focusDashboard = (): void => {
    // WebContents.focus can activate its window: passive handoffs must never
    // raise Epo over another app or focus its still-hidden boot window.
    if (handingOffFocus || !revealed || !dashboardOwnsStage || win.isDestroyed()
      || !win.isVisible() || !win.isFocused() || dash.webContents.isDestroyed()
      || dash.webContents.isFocused()) return;
    handingOffFocus = true;
    try {
      dash.webContents.focus();
    } catch (error) {
      logger.warn('shell: dashboard focus failed', { error: String(error) });
    } finally {
      handingOffFocus = false;
    }
  };
  win.on('focus', focusDashboard);
  // CSS px always equal DIP: zoom would desync the native tab's bounds from the layout.
  void dash.webContents.setVisualZoomLevelLimits(1, 1).catch((error: unknown) =>
    logger.warn('shell: dashboard zoom limits failed', { error: String(error) }));
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
  let dashboardLoaded = false;
  const loadDashboard = (): void => {
    if (dashboardLoaded) return;
    dashboardLoaded = true;
    dashboard.load();
  };
  if (opts.deferDashboardLoad !== true) loadDashboard();

  // --- Embedded Instagram tab (right) ---------------------------------------
  const tab = new InstagramTab();
  tab.attach(win);
  const igFirstLoad = tab.goto(IG_HOME_URL).then(() => {
    focusDashboard();
    return 'ready' as const;
  }, (error: unknown) => {
    logger.warn('shell: initial tab load failed', { error: String(error) });
    // The initial error document can finish after the tour took focus. Recheck
    // current stage ownership once; later engine navigation owns its own input.
    focusDashboard();
    return 'failed' as const;
  });

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
      dashboardOwnsStage = mode !== 'tab' || covered;
      if (mode === 'tab' && !covered) {
        tab.show();
        veil.setObscured(false);
      } else {
        tab.hide();
        veil.setObscured(true);
      }
      focusDashboard();
    },
    send: (channel, payload) => {
      if (!dash.webContents.isDestroyed()) dash.webContents.send(channel, payload);
    },
    onRendererLoad: (cb) => {
      dash.webContents.on('did-finish-load', cb);
    },
    igFirstLoad,
    loadDashboard,
    reveal: () => {
      if (revealed || win.isDestroyed()) return;
      revealed = true;
      if (state.maximized) win.maximize();
      else win.show();
      win.focus();
      focusDashboard();
    },
  };
}
