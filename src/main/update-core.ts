/**
 * Self-updater decision logic — electron-free on purpose (docs/RELEASE.md §5):
 * jest constructs main-process classes with no electron mock, so everything
 * testable about the updater (mode selection, benign-error classification,
 * status shapes) lives here, and only `updater.ts` — wired solely from
 * `main.ts` — touches electron-updater.
 */

import type { UpdateMode, UpdateStatus } from '../types';

export interface UpdateEnvironment {
  /** `process.platform`. */
  platform: NodeJS.Platform;
  /** `app.isPackaged` — dev runs have no update artifacts to apply. */
  isPackaged: boolean;
  /** `process.env.PORTABLE_EXECUTABLE_DIR` — set by electron-builder's portable launcher. */
  portableDir: string | undefined;
}

/**
 * What "update itself" means on this install (the platform matrix in
 * docs/RELEASE.md §5):
 * - dev runs: off — there is nothing to update.
 * - Windows portable: notify — an exe cannot replace itself in place.
 * - unsigned macOS: notify — Squirrel.Mac refuses unsigned updates, and the
 *   failure fires during download, so the download must never start.
 * - Windows NSIS: full download-and-install.
 */
export function resolveUpdateMode(env: UpdateEnvironment): UpdateMode {
  if (!env.isPackaged) return 'off';
  if (env.platform === 'win32') return env.portableDir !== undefined ? 'notify' : 'full';
  if (env.platform === 'darwin') return 'notify';
  return 'off'; // no Linux packages are shipped
}

/**
 * Feed outcomes that mean "no update for you today", not "something broke":
 * the repo is private (404 until it goes public), no release exists yet, the
 * network is down, or this build carries no update metadata at all (an
 * app-update.yml-less dir/test build cannot self-update — that is a fact
 * about the build, not a failure). These collapse to a quiet `idle`; only a
 * genuine download failure is worth the user's attention.
 */
export function isBenignFeedError(message: string): boolean {
  return /404|No published versions|status code 4|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|net::ERR|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION|app-update\.yml/i.test(
    message,
  );
}

/** The pre-first-check status for a given mode and app version. */
export function initialStatus(mode: UpdateMode, current: string): UpdateStatus {
  return { state: 'idle', mode, current, version: null, percent: null, error: null };
}
