/**
 * The self-updater backend (docs/RELEASE.md §5) — wired from `main.ts` and
 * ONLY there: jest builds Foundation with no electron mock, and
 * electron-updater requires electron at module load, so this file must never
 * be imported by `foundation-wiring.ts` or anything a test touches. All the
 * unit-testable decisions live in `update-core.ts`.
 *
 * Hard rules (each load-bearing, see the design doc):
 * - `autoDownload` stays false and `checkForUpdatesAndNotify()` is never
 *   used: on unsigned macOS the signature failure fires DURING download, so
 *   notify-mode installs must never start one.
 * - The explicit install path is `quitAndInstall()` — for NSIS it launches
 *   the installer before quitting, immune to the app's
 *   `before-quit → preventDefault → app.exit(0)` shutdown dance.
 *   `autoInstallOnAppQuit` stays on as a bonus, not the contract.
 * - Benign feed outcomes (private repo 404, zero releases, offline) read as a
 *   quiet `unavailable`, never as "up to date"; a real failure surfaces as `error`.
 * - It starts `unchecked`, and every finished check stamps `checkedAt` (spec §13).
 */

import { app, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import {
  initialStatus, isBenignFeedError, nextUpdateStatus, resolveAppVersion, resolveUpdateMode, type UpdateEvent,
} from '@/main/update-core';
import type { UpdateStatus } from '@/shared/update-status';
import { UPDATER } from '@/timing/config';
import * as logger from '@/utils/logger';

const LATEST_RELEASE_URL = 'https://github.com/owengregson/Epo/releases/latest';

export interface EpoUpdaterDeps {
  /** Pushed on every state change (the renderer mirrors it live). */
  onStatus(status: UpdateStatus): void;
}

export class EpoUpdater {
  private readonly deps: EpoUpdaterDeps;
  private status: UpdateStatus;
  private timer: NodeJS.Timeout | null = null;

  constructor(deps: EpoUpdaterDeps) {
    this.deps = deps;
    const mode = resolveUpdateMode({
      platform: process.platform,
      isPackaged: app.isPackaged,
      defaultApp: process.defaultApp,
      portableDir: process.env.PORTABLE_EXECUTABLE_DIR,
    });
    this.status = initialStatus(mode, resolveAppVersion(app.isPackaged, app.getVersion(), process.defaultApp));
    if (mode === 'off') return;

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = null; // our structured logger below, not its console one

    autoUpdater.on('checking-for-update', () => this.apply({ kind: 'checking' }));
    autoUpdater.on('update-not-available', () => this.apply({ kind: 'none' }));
    autoUpdater.on('update-available', (info) => {
      logger.info('updater: update available', { version: info.version, mode });
      this.apply({ kind: 'available', version: info.version });
      if (mode === 'full') {
        // NSIS installs only — notify mode never starts a download it cannot
        // apply. Failures surface through the 'error' listener below.
        autoUpdater.downloadUpdate().catch(() => {});
      }
    });
    autoUpdater.on('download-progress', (p) => this.apply({ kind: 'progress', percent: p.percent }));
    autoUpdater.on('update-downloaded', (info) => {
      logger.info('updater: downloaded, installs on restart', { version: info.version });
      this.apply({ kind: 'downloaded', version: info.version });
    });
    autoUpdater.on('error', (err) => {
      const message = err instanceof Error ? err.message : String(err);
      // Private repo today, no releases yet, or offline: quiet and unavailable, not red.
      if (this.status.state !== 'downloading' && isBenignFeedError(message)) logger.info('updater: no update feed', { message });
      else logger.warn('updater: failed', { message });
      this.apply({ kind: 'error', message });
    });
  }

  /** Launch check now, then every CHECK_INTERVAL_MS (unref — never keeps the app alive). */
  start(): void {
    if (this.status.mode === 'off') return;
    void this.check();
    this.timer = setInterval(() => void this.check(), UPDATER.CHECK_INTERVAL_MS);
    this.timer.unref();
  }

  /** One feed check; resolves with the status after the check settles. */
  async check(): Promise<UpdateStatus> {
    if (this.status.mode === 'off') return this.status;
    try {
      await autoUpdater.checkForUpdates();
    } catch {
      // Classified and reported by the 'error' listener; nothing extra here.
    }
    return this.status;
  }

  /** Full mode with a download ready: run the installer and restart. */
  install(): UpdateStatus {
    if (this.status.mode === 'full' && this.status.state === 'ready') {
      logger.info('updater: installing on user request', { version: this.status.version });
      autoUpdater.quitAndInstall();
    }
    return this.status;
  }

  /** Notify mode's action: the latest-release page in the default browser. */
  async openLatest(): Promise<void> {
    await shell.openExternal(LATEST_RELEASE_URL);
  }

  current(): UpdateStatus {
    return this.status;
  }

  dispose(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    autoUpdater.removeAllListeners();
  }

  private apply(event: UpdateEvent): void {
    this.status = nextUpdateStatus(this.status, event, Date.now());
    this.deps.onStatus(this.status);
  }
}
