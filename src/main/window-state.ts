/**
 * Window-state persistence — the main window reopens with the size, position,
 * and maximized flag it closed with (a `window-state.json` sibling of the
 * settings file in `userData`). Deliberately Electron-free (pure geometry +
 * fs), so it unit-tests without an Electron harness; `main.ts` feeds in the
 * current display work areas and the live bounds.
 */

import * as fs from 'node:fs';
import { warn } from '../utils/logger';

/** A rectangle in screen coordinates (display work areas use this too). */
export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowState {
  /** Normal (un-maximized) top-left; absent = let the OS place the window. */
  x?: number;
  y?: number;
  /** Normal (un-maximized) size. */
  width: number;
  height: number;
  /** Re-maximize on launch when the window closed maximized. */
  maximized: boolean;
}

/** Mirrors the BaseWindow minimums in main.ts — a restored size never undercuts them. */
export const MIN_WINDOW = { width: 1024, height: 640 } as const;

/** First-launch geometry (and the fallback for an unusable saved state). */
export const DEFAULT_WINDOW_STATE: WindowState = { width: 1440, height: 920, maximized: false };

/**
 * A saved position survives only if at least this much of the window still
 * overlaps some display — an unplugged monitor must never strand the window
 * off-screen with no reachable title bar.
 */
const MIN_VISIBLE_PX = 96;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Coerce a possibly missing, hand-edited, or stale state into a usable one:
 * sizes clamp to the window minimums, the maximized flag to a boolean, and the
 * position is kept only while it still lands on one of `displays` (pass the
 * current work areas; an empty list skips the visibility check).
 */
export function sanitizeWindowState(raw: unknown, displays: WindowRect[]): WindowState {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const out: WindowState = {
    width: Math.max(
      MIN_WINDOW.width,
      finite(r.width) ? Math.round(r.width) : DEFAULT_WINDOW_STATE.width,
    ),
    height: Math.max(
      MIN_WINDOW.height,
      finite(r.height) ? Math.round(r.height) : DEFAULT_WINDOW_STATE.height,
    ),
    maximized: r.maximized === true,
  };
  if (finite(r.x) && finite(r.y)) {
    const x = Math.round(r.x);
    const y = Math.round(r.y);
    const visible =
      displays.length === 0 ||
      displays.some((d) => {
        const w = Math.min(x + out.width, d.x + d.width) - Math.max(x, d.x);
        const h = Math.min(y + out.height, d.y + d.height) - Math.max(y, d.y);
        return w >= MIN_VISIBLE_PX && h >= MIN_VISIBLE_PX;
      });
    if (visible) {
      out.x = x;
      out.y = y;
    }
  }
  return out;
}

/**
 * Read + sanitize the persisted state. A missing file is the normal first
 * launch; a parse failure degrades to the defaults with a warning (mirroring
 * `loadSettings`) — never a throw.
 */
export function loadWindowState(filePath: string, displays: WindowRect[]): WindowState {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { ...DEFAULT_WINDOW_STATE };
  }
  try {
    return sanitizeWindowState(JSON.parse(raw), displays);
  } catch (err) {
    warn('window-state: failed to parse, using defaults', { filePath, error: String(err) });
    return { ...DEFAULT_WINDOW_STATE };
  }
}

/**
 * Persist atomically (temp sibling + rename, mirroring `saveSettings`) so a
 * crash mid-write can never leave a truncated state file.
 */
export function saveWindowState(filePath: string, state: WindowState): void {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}
