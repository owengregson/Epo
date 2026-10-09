/**
 * Scroll containers: the list modal's and the notifications drawer's.
 *
 * Class names are unstable, so the container is found by BEHAVIOUR — the
 * descendant with the greatest scrollHeight whose computed overflow-y is
 * auto|scroll and whose content overflows. Nothing is scrolled here: the rect
 * and metrics go back and the Interactor wheels it with native input events.
 */

import { type LocateScroll, largestScrollable, scopesOf, scrollReport } from './dom';

export interface ListScrollCfg {
  /** The modal the list lives in. */
  rootSel: string;
  /** Elements a wheel must NOT rest on (they open hover cards that eat it). */
  interactiveSel: string;
}

export interface DrawerScrollCfg {
  /** Drawer-ish scopes, tried in order; the first with a scroller wins. */
  scopes: readonly string[];
}

/**
 * The list modal's scroller, plus a hover-safe point to rest the cursor on.
 *
 * Without the safe point a wheel can land on a username link or avatar, which
 * opens Instagram's hover-preview card — the card overlays the row and
 * swallows every subsequent wheel event, and the walk stalls. The probe tries
 * the container's left/right gutters first (row background, no interactive
 * child), then interior columns. Absent when nothing safe is found (a dense
 * list) — the Interactor then uses its own default entry point.
 */
export function locateScrollContainer(cfg: ListScrollCfg): LocateScroll {
  const root = document.querySelector(cfg.rootSel);
  if (!root) return { found: false };
  const best = largestScrollable(root);
  if (!best) return { found: false };

  const r = best.getBoundingClientRect();
  const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
  const vh = window.innerHeight || document.documentElement.clientHeight || r.bottom;
  const topV = clamp(r.top, 0, vh);
  const botV = clamp(r.bottom, 0, vh);
  const isSafe = (x: number, y: number): boolean => {
    const el = document.elementFromPoint(Math.round(x), Math.round(y));
    if (!el) return false;
    if (el !== best && !best.contains(el)) return false; // outside the scroller
    return !el.closest(cfg.interactiveSel);
  };

  // Gutters first (left padding, then right — inset past the ~15px scrollbar),
  // then interior columns as a fallback.
  const xs = [
    r.left + 6,
    r.left + 14,
    r.right - 26,
    r.right - 18,
    r.left + r.width * 0.5,
    r.left + r.width * 0.34,
    r.left + r.width * 0.66,
  ];
  const yFracs = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74];
  let safe: { x: number; y: number } | null = null;
  for (let yi = 0; yi < yFracs.length && !safe; yi++) {
    const y = topV + (botV - topV) * yFracs[yi];
    for (const x of xs) {
      if (isSafe(x, y)) {
        safe = { x, y };
        break;
      }
    }
  }

  const out = scrollReport(best);
  if (safe) out.safePoint = safe;
  return out;
}

/** The notifications drawer's scroller — the caller wheels it to load older pages. */
export function locateDrawerScroll(cfg: DrawerScrollCfg): LocateScroll {
  for (const scope of scopesOf(cfg.scopes)) {
    const best = largestScrollable(scope);
    if (best) return scrollReport(best);
  }
  return { found: false };
}
