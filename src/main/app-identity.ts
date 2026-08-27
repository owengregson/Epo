/**
 * App identity for unpackaged runs.
 *
 * Packaged builds get their name ("Epo") from electron-builder's productName.
 * Unpackaged runs (`electron dist/main/main.js`) have no bundle metadata, so
 * Electron falls back to "Electron" — and that leaks into the macOS app menu
 * ("About Electron", "Quit Electron"), notification attribution, and the
 * userData directory (~/Library/Application Support/Electron). Claiming the
 * name here makes every run mode read "Epo".
 *
 * Call this before `app.whenReady()` and before ANYTHING touches
 * `app.getPath('userData')` — the userData path derives from the app name.
 * (The Dock name/icon of a dev run are a separate mechanism: they come from
 * the Electron.app bundle itself and are branded by
 * scripts/fix-electron-macos.mjs at launch.)
 */
import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as logger from '@/utils/logger';

/**
 * Marker for the one-time userData migration below: the database file's name
 * as it was when the data lived under the old default directory. Historical,
 * so it stays frozen even if the live DB constant ever changes.
 */
const LEGACY_DB_FILE = 'epo.db';

/** Set the app's name and move pre-rename dev data to its new home. */
export function claimAppIdentity(): void {
  app.setName('Epo');
  migrateLegacyUserData();
}

/**
 * Dev runs before 2026-08-23 stored everything under the name-derived default
 * `<appData>/Electron` — the knowledge graph, settings, and the persistent
 * `persist:ig` login partition. The first launch under the Epo name moves the
 * whole directory so none of that is orphaned. One rename, one time: if the
 * Epo directory already exists (migrated earlier, or a packaged run created
 * it first), it is never touched.
 */
function migrateLegacyUserData(): void {
  const appData = app.getPath('appData');
  const legacy = path.join(appData, 'Electron');
  const target = app.getPath('userData'); // <appData>/Epo after setName above
  if (fs.existsSync(target)) return;
  if (!fs.existsSync(path.join(legacy, LEGACY_DB_FILE))) return;
  // The rename can transiently fail while a just-quit instance's helpers
  // still hold the directory (observed 2026-08-23: a relaunch seconds after
  // quit lost that race, and the then-fallback of "start fresh" surfaced as
  // all data gone). Retry briefly; if the directory still will not move,
  // KEEP USING the legacy path — a stale directory name is recoverable on
  // the next launch, a hidden login session and knowledge graph are not.
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(legacy, target);
      logger.info('app-identity: moved dev userData to the Epo directory', {
        from: legacy,
        to: target,
      });
      return;
    } catch (e) {
      if (attempt < 5) {
        sleepSync(400);
        continue;
      }
      logger.error('app-identity: could not move legacy userData; staying on it in place', {
        from: legacy,
        to: target,
        error: String(e),
      });
      app.setPath('userData', legacy);
      // Cookies/partitions live under sessionData, which does not re-derive
      // from an explicit userData override — pin it to the same place.
      app.setPath('sessionData', legacy);
      return;
    }
  }
}

/** Blocking pre-ready wait; only used on the rare contested-rename path. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
