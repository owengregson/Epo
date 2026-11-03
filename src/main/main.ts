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
import { app, nativeImage, powerMonitor, powerSaveBlocker } from 'electron';
import { bootstrapApp, ensureSingleInstance } from '@/main/bootstrap';
import { type LaunchHandles, launchWindow } from '@/main/launch';
import { RuntimePower } from '@/main/runtime-power';
import { applyNetworkBlock } from '@/main/services/ig-session';
import { RuntimeCoordinator } from '@/main/services/runtime-coordinator';
import { RuntimeLog } from '@/main/services/runtime-log';
import { terminateFailedStartup } from '@/main/services/startup-failure';
import * as logger from '@/utils/logger';

// Identity + the background-survival switches, at module top level: the
// userData path derives from the app name, and the switches only take effect
// before `app.whenReady()`.
bootstrapApp();

/** The live window parts, filled by {@link launchWindow} as each one is built. */
const live: LaunchHandles = {
  mainWindow: null,
  instagramTab: null,
  overlayVeil: null,
  foundation: null,
  disposeIpc: null,
  connectivityMonitor: null,
  composedApp: null,
};
let runtimePower: RuntimePower | null = null;
let runtimeLog: RuntimeLog | null = null;
let shuttingDown = false;

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
  const mainWindow = live.mainWindow;
  if (mainWindow === null || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.whenReady().then(async () => {
  if (!isPrimaryInstance) return;
  runtimeLog = new RuntimeLog(path.join(app.getPath('userData'), 'logs'));
  logger.setDurableSink((level, message, meta) => runtimeLog?.write(level, message, meta));
  setDevDockIcon();
  // Protect main-process pacing and durable wake schedules while the display
  // sleeps. Forced system sleep still needs the ordered Foundation recovery.
  runtimePower = new RuntimePower({
    blocker: powerSaveBlocker,
    monitor: powerMonitor,
    suspend: () => live.foundation?.suspendForSleep(),
    resume: async () => live.foundation?.resumeFromSleep(),
  });
  runtimePower.start();
  // An isolated launch (EPO_BLOCK_NETWORK=1) takes the IG partition offline before any tab exists.
  await applyNetworkBlock();
  await launchWindow({ handles: live });

  // NB: no `activate` → launchWindow() handler. `window-all-closed` always
  // quits (below), so a live app never has a null window to re-create — and
  // re-running launchWindow() would re-register live IPC handlers (a throw)
  // and construct a second Foundation/InstagramTab over the first.
}).catch((error: unknown) => terminateFailedStartup(error, {
  claim: () => {
    if (shuttingDown) return false;
    shuttingDown = true;
    return true;
  },
  block: (failure) => {
    if (live.foundation !== null) live.foundation.stopForIncident('startup-failed');
    else new RuntimeCoordinator(path.join(app.getPath('userData'), 'epo-runtime.json'))
      .block('startup-failed', String(failure));
  },
  dispose: disposeApplication,
  closeLog: closeRuntimeLog,
  report: (phase, failure) => logger.error(`main: ${phase}`, { error: String(failure) }),
  exit: (code) => app.exit(code),
}));

// Closing the window closes the whole app — including the engine loop, the
// knowledge store, and the persistent Instagram session — on every platform.
app.on('window-all-closed', () => {
  app.quit();
});

// Terminal exits are deliberate user stops, not crashes eligible for automatic replay.
process.on('SIGINT', () => app.quit());
process.on('SIGTERM', () => app.quit());

// Graceful shutdown: stop the engine, await its loop, close the store, then the
// tab + veil, and only then exit. `before-quit` is preventable, so we defer the
// exit until dispose settles (guarded against re-entry).
app.on('before-quit', (event) => {
  event.preventDefault();
  if (shuttingDown) return;
  shuttingDown = true;
  runtimePower?.stopWatching();
  live.foundation?.shutdownRuntime();

  // NB: we deliberately do NOT remove the IPC handlers here. The renderer's
  // in-flight polling invokes (chain:list / growth:series) can still drain after
  // the window closes; leaving the handlers registered lets them resolve to safe
  // empties (Foundation is `disposing`, so no rebuild) instead of logging
  // "No handler registered". Everything is freed when the process exits below.
  void disposeApplication().finally(() => closeRuntimeLog().finally(() => app.exit(0)));
});

/** Shared ordered cleanup, including partially composed startup resources. */
async function disposeApplication(): Promise<void> {
  const run = async (label: string, release: () => void | Promise<void>): Promise<void> => {
    try { await release(); }
    catch (error) { logger.error(`main: ${label} dispose failed`, { error: String(error) }); }
  };
  runtimePower?.stopWatching();
  live.connectivityMonitor?.stop();
  live.connectivityMonitor = null;
  const found = live.foundation;
  live.foundation = null;
  const composed = live.composedApp;
  live.composedApp = null;
  await run('foundation', () => found?.dispose());
  await run('modules', () => composed?.dispose());
  live.disposeIpc = null;
  await run('tab', () => live.instagramTab?.dispose());
  live.instagramTab = null;
  await run('veil', () => live.overlayVeil?.dispose());
  live.overlayVeil = null;
  await run('power', () => runtimePower?.dispose());
  runtimePower = null;
}

function closeRuntimeLog(): Promise<void> {
  const log = runtimeLog;
  runtimeLog = null;
  logger.setDurableSink(null);
  return log?.close() ?? Promise.resolve();
}
