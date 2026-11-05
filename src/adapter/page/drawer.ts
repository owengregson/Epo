/**
 * The notifications drawer and the follow-requests panel.
 *
 * Three shapes of search, all scope-ordered so page CONTENT can never win over
 * the nav rail or the open drawer:
 *
 *  - by accessible name (`aria-label`) for icon controls that carry no text,
 *  - by smallest matching text for labelled entries and filter chips,
 *  - the requests panel's first Confirm control, plus whose row it is.
 */

import {
  clickableOf,
  exposedAim,
  type LocateRect,
  mk,
  norm,
  type Rect,
  type RegexLit,
  rectOf,
  scopesOf,
  smallestMatching,
} from './dom';

export interface LabeledCfg {
  /** Matched against the element's `aria-label`. */
  rx: RegexLit;
  /** Scope selectors in priority order (the rail/drawer before the body). */
  scopes: readonly string[];
  /** Elements that can carry the accessible name. */
  labeledSel: string;
  /** Press-shaped ancestors the rect is taken from. */
  clickableSel: string;
}

export interface TextEntryCfg {
  rx: RegexLit;
  scopes: readonly string[];
  /** Candidate nodes scanned for the smallest text match. */
  nodeSel: string;
  clickableSel: string;
}

export interface ConfirmRequestCfg {
  /** The per-row accept control's text. */
  rx: RegexLit;
  scopes: readonly string[];
  buttonSel: string;
  /** A bare profile path — how a row's username is recognised. */
  profilePathRx: RegexLit;
  /** How far up from the button to look for the row's profile link. */
  maxDepth: number;
}

/** The first "Confirm" control's rect, whose row it is, and how many remain. */
export interface LocateConfirmRequestResult {
  found: boolean;
  rect?: Rect;
  username?: string | null;
  remaining?: number;
}

/**
 * A control located by accessible name. The rect is its clickable ancestor's —
 * an `svg[aria-label]` is never the element the page listens on. Falls back to
 * the parent element when nothing press-shaped is above it.
 */
export function locateLabeled(cfg: LabeledCfg): LocateRect {
  const rx = mk(cfg.rx);
  for (const scope of scopesOf(cfg.scopes)) {
    for (const el of Array.from(scope.querySelectorAll(cfg.labeledSel))) {
      if (!rx.test(el.getAttribute('aria-label') || '')) continue;
      const near = el.closest(cfg.clickableSel) || el.parentElement || el;
      const rect = rectOf(near);
      const aim = exposedAim(near, rect);
      return aim === undefined ? { found: true, rect } : { found: true, rect, aim };
    }
  }
  return { found: false };
}

/** A labelled entry or filter chip, located by its smallest matching text. */
export function locateTextEntry(cfg: TextEntryCfg): LocateRect {
  const rx = mk(cfg.rx);
  for (const scope of scopesOf(cfg.scopes)) {
    const hit = smallestMatching(scope, cfg.nodeSel, rx);
    if (hit) return { found: true, rect: rectOf(clickableOf(hit, cfg.clickableSel)) };
  }
  return { found: false };
}

/**
 * The FIRST Confirm control in the open requests panel, the username of the row
 * it belongs to (nearest ancestor holding a profile link), and how many Confirm
 * controls the panel shows. The caller compares two probes across an accept to
 * verify the click actually consumed a row.
 */
export function locateConfirmRequest(cfg: ConfirmRequestCfg): LocateConfirmRequestResult {
  const rx = mk(cfg.rx);
  const isProfilePath = mk(cfg.profilePathRx);
  for (const scope of scopesOf(cfg.scopes)) {
    const buttons = Array.from(scope.querySelectorAll(cfg.buttonSel)).filter((b) =>
      rx.test(norm(b.textContent)),
    );
    if (buttons.length === 0) continue;
    const btn = buttons[0];

    let username: string | null = null;
    let node: Element | null = btn.parentElement;
    for (let depth = 0; node && depth < cfg.maxDepth && username === null; depth++) {
      for (const a of Array.from(node.querySelectorAll('a[href]'))) {
        const h = a.getAttribute('href') || '';
        if (isProfilePath.test(h)) {
          username = h.replace(/\//g, '');
          break;
        }
      }
      node = node.parentElement;
    }
    return { found: true, rect: rectOf(btn), username, remaining: buttons.length };
  }
  return { found: false };
}
