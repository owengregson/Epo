/**
 * The confirm control in the unfollow / cancel-request menu.
 *
 * Two passes, primary then self-recovery:
 *
 *  1. PRIMARY — role-marked controls matching the confirm text, VISIBLE matches
 *     only (a menu can render the control twice, one `display:none`; a search
 *     taking the first DOM match kept finding the hidden copy).
 *  2. FALLBACK — Instagram periodically ships menu rows as bare divs/spans with
 *     the press handler on an unmarked ancestor, and the role query goes blind
 *     while the control sits plainly on screen. Recover by finding the DEEPEST
 *     visible element whose OWN short text matches, then prefer its nearest
 *     press-shaped ancestor. `fallback: true` marks the recovery so the Actor
 *     can warn: a persistent fallback is early drift in the primary anchors.
 */

import { clickableOf, type LocateRect, mk, norm, type RegexLit, rectOf, visible } from './dom';

export interface ConfirmCfg {
  /** The confirm text matcher (prefix match — menu rows can carry a suffix). */
  rx: RegexLit;
  /** Dialog-ish scopes searched before the whole document. */
  scopes: readonly string[];
  /** Role-marked controls (the primary pass). */
  roleSel: string;
  /** Bare containers the self-recovery pass scans. */
  deepSel: string;
  /** Press-shaped ancestors preferred for a recovery hit. */
  clickableSel: string;
  /** A recovery candidate may hold at most this many element children. */
  maxChildren: number;
  /** …and at most this much text (a whole panel is not a menu row). */
  maxTextLen: number;
}

interface Hit {
  clickable: Element;
  fallback: boolean;
}

function find(cfg: ConfirmCfg): Hit | null {
  const rx = mk(cfg.rx);
  const scopes: ParentNode[] = [];
  for (const sel of cfg.scopes) {
    for (const el of Array.from(document.querySelectorAll(sel))) scopes.push(el);
  }
  scopes.push(document);

  for (const scope of scopes) {
    for (const n of Array.from(scope.querySelectorAll(cfg.roleSel))) {
      if (rx.test(norm(n.textContent)) && visible(n)) return { clickable: n, fallback: false };
    }
  }

  for (const scope of scopes) {
    let best: Element | null = null;
    for (const el of Array.from(scope.querySelectorAll(cfg.deepSel))) {
      if (el.children.length > cfg.maxChildren) continue;
      const t = norm(el.textContent);
      if (!t || t.length > cfg.maxTextLen || !rx.test(t)) continue;
      if (!visible(el)) continue;
      // Keep descending: a later candidate the current best CONTAINS is deeper.
      if (best === null || best.contains(el)) best = el;
    }
    if (best) {
      const near = clickableOf(best, cfg.clickableSel);
      return { clickable: near !== best && visible(near) ? near : best, fallback: true };
    }
  }
  return null;
}

/** The confirm control's rect, or `found: false` when the menu holds none. */
export function locateConfirm(cfg: ConfirmCfg): LocateRect {
  const hit = find(cfg);
  if (!hit) return { found: false };
  return { found: true, rect: rectOf(hit.clickable), fallback: hit.fallback };
}
