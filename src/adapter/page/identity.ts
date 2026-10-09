/**
 * The nav profile-avatar link — how the app learns whose account it is driving.
 *
 * The link is the anchor whose href is a bare profile path AND that contains
 * the avatar `<img>`; nav scopes are searched before the body so a profile link
 * in page content can never be mistaken for our own.
 */

import { type LocateRect, mk, type RegexLit, rectOf } from './dom';

export interface ProfileLinkCfg {
  /** A bare profile path (`/<username>/`). */
  profilePathRx: RegexLit;
  /** Scope selectors in priority order. */
  scopes: readonly string[];
}

export interface AvatarAltCfg {
  /** The avatar image, by its alt-text shape. */
  sel: string;
}

function findProfileLink(cfg: ProfileLinkCfg): Element | null {
  const isProfilePath = mk(cfg.profilePathRx);
  for (const sel of cfg.scopes) {
    for (const scope of Array.from(document.querySelectorAll(sel))) {
      for (const a of Array.from(scope.querySelectorAll('a[href]'))) {
        const h = a.getAttribute('href') || '';
        if (isProfilePath.test(h) && a.querySelector('img')) return a;
      }
    }
  }
  return null;
}

/** The nav profile link's href (`/<username>/`), or `null`. */
export function readProfileHref(cfg: ProfileLinkCfg): string | null {
  const a = findProfileLink(cfg);
  return a ? a.getAttribute('href') : null;
}

/** The nav profile link's rect — the Interactor presses it to land on our profile. */
export function locateProfileLink(cfg: ProfileLinkCfg): LocateRect {
  const a = findProfileLink(cfg);
  return a ? { found: true, rect: rectOf(a) } : { found: false };
}

/**
 * Legacy schema escape retained for stored surface documents and fixtures.
 * Runtime identity resolution supplies the native Interactor before graph
 * construction and never calls this synthetic path.
 */
export function clickProfileLink(cfg: ProfileLinkCfg): boolean {
  const a = findProfileLink(cfg);
  if (!a) return false;
  (a as HTMLElement).click();
  return true;
}

/** The avatar's RAW alt text; the username is extracted main-process side. */
export function readAvatarAlt(cfg: AvatarAltCfg): string | null {
  const img = document.querySelector(cfg.sel);
  return img ? img.getAttribute('alt') : null;
}
