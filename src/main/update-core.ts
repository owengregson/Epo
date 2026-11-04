/**
 * Self-updater decision logic — electron-free on purpose (docs/RELEASE.md §5):
 * jest constructs main-process classes with no electron mock, so everything
 * testable about the updater (mode selection, benign-error classification,
 * the status each event leads to) lives here, and only `updater.ts` — wired
 * solely from the composed app — touches electron-updater.
 */

import type { UpdateMode, UpdateStatus } from '@/shared/update-status';

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
 * about the build, not a failure). These read as a quiet `unavailable`, never
 * as "up to date"; only a genuine failure is worth the user's attention.
 */
export function isBenignFeedError(message: string): boolean {
  return /404|No published versions|status code 4|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|net::ERR|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION|app-update\.yml/i.test(
    message,
  );
}

/** The pre-first-check status for a given mode and app version: nothing is claimed yet. */
export function initialStatus(mode: UpdateMode, current: string): UpdateStatus {
  return { state: 'unchecked', mode, current, version: null, percent: null, error: null, checkedAt: null };
}

/** What electron-updater reported, as data. */
export type UpdateEvent =
  | { kind: 'checking' }
  | { kind: 'none' }
  | { kind: 'available'; version: string }
  | { kind: 'progress'; percent: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string };

/**
 * The status after one event (spec §13): a finished check — nothing found, an offer, no feed, a failure —
 * stamps `checkedAt`; only a check that found nothing reads as up to date (`idle`); a download's progress and
 * failure keep the check time, and its failure is always an error.
 */
export function nextUpdateStatus(s: UpdateStatus, e: UpdateEvent, now: number): UpdateStatus {
  switch (e.kind) {
    case 'checking':
      return { ...s, state: 'checking', error: null };
    case 'none':
      return { ...s, state: 'idle', version: null, percent: null, error: null, checkedAt: now };
    case 'available':
      return { ...s, state: 'available', version: e.version, error: null, checkedAt: now };
    case 'progress':
      return { ...s, state: 'downloading', percent: Math.round(e.percent) };
    case 'downloaded':
      return { ...s, state: 'ready', version: e.version, percent: 100, error: null };
    case 'error': {
      const checkedAt = s.state === 'checking' ? now : s.checkedAt;
      if (s.state !== 'downloading' && isBenignFeedError(e.message)) return { ...s, state: 'unavailable', error: null, checkedAt };
      return { ...s, state: 'error', percent: null, error: e.message, checkedAt };
    }
  }
}
