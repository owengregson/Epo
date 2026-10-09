/**
 * The followers / following count controls in the profile header.
 *
 * On current Instagram both stats are `<a href="#">` that open the modal via
 * JS — NOT `/<user>/followers/` links — so they are located by TEXT: the
 * anchor/button whose text names one stat and not the other. The rect reported
 * is the nearest CLICKABLE ancestor's: the element the page itself treats as
 * the control.
 */

import { clickableOf, type LocateRect, mk, norm, type RegexLit, rectOf, scopesOf } from './dom';

export interface StatCfg {
  which: 'followers' | 'following';
  /** Both matchers — each stat is identified by matching one and NOT the other. */
  rx: { followers: RegexLit; following: RegexLit };
  /** Scope selectors in priority order (header before main before body). */
  scopes: readonly string[];
  /** Candidate controls inside a scope. */
  candSel: string;
  /** Press-shaped ancestors the rect is taken from. */
  clickableSel: string;
}

/** The stat control's clickable rect, or `found: false`. */
export function locateStat(cfg: StatCfg): LocateRect {
  const followers = mk(cfg.rx.followers);
  const following = mk(cfg.rx.following);
  const wanted = (t: string): boolean =>
    cfg.which === 'followers'
      ? followers.test(t) && !following.test(t)
      : following.test(t) && !followers.test(t);

  for (const scope of scopesOf(cfg.scopes)) {
    for (const el of Array.from(scope.querySelectorAll(cfg.candSel))) {
      if (wanted(norm(el.textContent))) {
        return { found: true, rect: rectOf(clickableOf(el, cfg.clickableSel)) };
      }
    }
  }
  return { found: false };
}
