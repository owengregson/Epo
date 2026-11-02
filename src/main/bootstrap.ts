/**
 * What every Electron entry point (`main`, `capture`, `inspect`, `livetest`)
 * does before it has a window: claim the app identity, apply the measured
 * background-survival switches, take the single-instance lock — and, for the
 * three tool harnesses, open a full-window Instagram tab and wait out the
 * login.
 *
 * `bootstrapApp()` runs at MODULE TOP LEVEL in each entry, never inside
 * `app.whenReady()`: the command-line switches only take effect if they are set
 * before the app is ready, and the userData path derives from the app name.
 */

import { app, BaseWindow } from 'electron';
import { IG_HOME_URL, InstagramTab } from '@/adapter/tab';
import { claimAppIdentity } from '@/main/app-identity';
import { electronIgSession } from '@/main/services/ig-session';
import { HARNESS } from '@/timing/config';
import { sleep } from '@/timing/primitives';
import * as logger from '@/utils/logger';

/** Settle after a navigation to instagram.com before the page's own fetches run. */
const ORIGIN_SETTLE_MS = 2_000;

/**
 * Keep page timers, rendering and input responsive in background window states.
 *
 * Measured (2026-08-14 input lab): with stock settings a blurred, occluded,
 * hidden or minimized window marks the page `visibilityState: 'hidden'`, stops
 * requestAnimationFrame COMPLETELY (0 frames vs 180/1.5 s) and clamps timers
 * ~15× (escalating to ~1/minute after 5 minutes hidden). CDP input still
 * arrives, but Instagram's SPA cannot hydrate pages or advance its UI state
 * machine in that state, so every action times out. With these switches (plus
 * `backgroundThrottling: false` on the tab, set in `tab.ts`) ordinary background
 * states survive. Electron 44 macOS also needs a renderer-local workaround
 * for hidden-navigation input ACKs (see tab.ts). Never disable frame limiting
 * here: the global switch also disables GPU vsync, making the dashboard and
 * veil produce thousands of frames per second and stall sidebar transitions.
 * See docs/qa/render-pacing-2026-10-21.md for the measured scope of the fix.
 *
 * MUST run before `app.whenReady()`. Every entry point applies them — a tool
 * harness that drifted from production behaviour would capture misleading DOM.
 */
export function applyBackgroundSurvivalSwitches(): void {
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
}

/**
 * Identity first (the userData path derives from the app name), then the
 * survival switches. Call at module top level.
 */
export function bootstrapApp(): void {
  claimAppIdentity();
  applyBackgroundSurvivalSwitches();
}

/**
 * Take the single-instance lock. Two processes would open two windows over the
 * SAME `epo.db` and the same `persist:ig` partition, which nothing downstream
 * guards against. The second instance quits immediately; the first raises its
 * window through `focus`.
 *
 * Returns false when this process is the redundant one — the caller must then
 * do nothing else.
 */
export function ensureSingleInstance(focus: () => void): boolean {
  if (!app.requestSingleInstanceLock()) {
    logger.warn('bootstrap: another Epo instance owns the data directory, quitting');
    app.quit();
    return false;
  }
  app.on('second-instance', () => {
    logger.info('bootstrap: second instance launched, focusing the existing window');
    focus();
  });
  return true;
}

/** A tool harness's window: one BaseWindow entirely filled by the IG tab. */
export interface ToolWindow {
  win: BaseWindow;
  tab: InstagramTab;
  /** False once the window has closed (the login/inspect poll loops read this). */
  isOpen(): boolean;
  /** Resolves when the initial navigation to the Instagram home page settles. */
  ready: Promise<void>;
}

/**
 * The window every tool harness opens: a single BaseWindow whose whole content
 * area is the persistent Instagram tab, navigated to the home page.
 */
export function openToolWindow(opts: {
  title: string;
  width?: number;
  height?: number;
}): ToolWindow {
  const win = new BaseWindow({
    width: opts.width ?? 1400,
    height: opts.height ?? 900,
    title: opts.title,
    backgroundColor: '#0e0e10',
  });

  const tab = new InstagramTab();
  tab.attach(win);
  tab.show();

  const layout = (): void => {
    const { width, height } = win.getContentBounds();
    tab.setBounds({ x: 0, y: 0, width, height });
  };
  win.on('resize', layout);
  layout();

  let open = true;
  win.on('closed', () => {
    open = false;
  });

  return { win, tab, isOpen: () => open, ready: tab.goto(IG_HOME_URL) };
}

/** True once the persistent IG session holds a non-empty `sessionid` cookie. */
export async function isLoggedIn(): Promise<boolean> {
  return (await electronIgSession().readCookie('sessionid')) !== null;
}

/**
 * Poll until the user has logged in, or the window closes. Resolves true when
 * a session exists; false when the window went away first.
 */
export async function awaitLogin(
  isOpen: () => boolean,
  pollMs = HARNESS.LOGIN_POLL_MS,
): Promise<boolean> {
  while (isOpen()) {
    if (await isLoggedIn()) return true;
    await sleep(pollMs);
  }
  return false;
}

/**
 * Put the tab on an instagram.com origin so the page's own fetches are
 * same-origin (identity resolution and the direct JSON reads both require it).
 */
export async function ensureInstagramOrigin(tab: InstagramTab): Promise<void> {
  if (tab.currentUrl().includes('instagram.com')) return;
  await tab.goto(IG_HOME_URL);
  await sleep(ORIGIN_SETTLE_MS);
}
