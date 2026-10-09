/**
 * The self-updater's projection (docs/RELEASE.md §5) — the `updateStatus` push
 * channel's payload. Pure value types shared by the updater module (main) and
 * the Updates card (renderer).
 */

/**
 * What "update itself" means on this install: 'full' downloads and installs
 * (Windows NSIS), 'notify' can only announce and open the release page
 * (unsigned macOS, Windows portable), 'off' means no updater at all
 * (unpackaged dev runs).
 */
export type UpdateMode = 'full' | 'notify' | 'off';

/** The updater's live state, pushed to the renderer as it changes. */
export interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error';
  mode: UpdateMode;
  /** The running app's version (always present — the Updates card shows it). */
  current: string;
  /** The offered version, once one is known (available/downloading/ready). */
  version: string | null;
  /** Download progress percent while 'downloading' (full mode only). */
  percent: number | null;
  /** Human-readable failure, only when state === 'error'. */
  error: string | null;
}
