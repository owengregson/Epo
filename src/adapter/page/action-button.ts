/**
 * The profile action button (Follow / Following / Requested / Follow Back).
 *
 * Matched by LEADING TEXT, never by class: Instagram's class names are
 * obfuscated and rotate. The search is scoped to the anchor the version module
 * supplies — the verified `<header>` — and there is deliberately NO
 * document-wide fallback tier: a broader scope can match a DIFFERENT account's
 * Follow button (suggestion carousels, hover cards) while the header is still
 * hydrating, click it, and then "verify" against the same wrong button.
 */

import { mk, norm, type Rect, type RegexLit, rectOf } from './dom';

/** The leading state a button's text reports. */
export type ButtonState = 'follow' | 'follow-back' | 'following' | 'requested';

export interface ActionButtonCfg {
  /** The verified anchor the button lives in (header-scoped, never wider). */
  sel: string;
  /**
   * Leading-word matchers. Order is load-bearing: `followBack` and `following`
   * are tested before the bare `follow` regex, which would also match their
   * leading word.
   */
  rx: Record<ButtonState, RegexLit>;
}

/** What `op` would do with a located button, plus its rect. */
export interface LocateActionResult {
  found: boolean;
  state?: ButtonState;
  wouldClick?: boolean;
  needsConfirm?: boolean;
  rect?: Rect;
}

/** The post-click state probe's answer. */
export interface ProbeStateResult {
  found: boolean;
  state: ButtonState | 'unknown';
}

/** The one text search both the locate and the probe run. */
function search(cfg: ActionButtonCfg): { btn: Element; state: ButtonState } | null {
  const order: ButtonState[] = ['follow-back', 'following', 'requested', 'follow'];
  const tests = order.map((state) => ({ state, re: mk(cfg.rx[state]) }));
  for (const n of Array.from(document.querySelectorAll(cfg.sel))) {
    const t = norm(n.textContent);
    if (!t) continue;
    for (const { state, re } of tests) {
      if (re.test(t)) return { btn: n, state };
    }
  }
  return null;
}

/**
 * Locate the action button and report whether `op` would press it — the
 * Interactor performs the press, so nothing is clicked here.
 */
export function locateActionButton(
  cfg: ActionButtonCfg & { op: 'follow' | 'unfollow' },
): LocateActionResult {
  const hit = search(cfg);
  if (!hit) return { found: false };
  const state = hit.state;
  let wouldClick = false;
  let needsConfirm = false;
  if (cfg.op === 'follow') {
    if (state === 'follow' || state === 'follow-back') wouldClick = true;
  } else if (state === 'following' || state === 'requested') {
    // Both open a menu: unfollowing, and cancelling a pending request.
    wouldClick = true;
    needsConfirm = true;
  }
  return { found: true, state, wouldClick, needsConfirm, rect: rectOf(hit.btn) };
}

/** Read the button's current leading state (the Actor's post-click check). */
export function probeActionButton(cfg: ActionButtonCfg): ProbeStateResult {
  const hit = search(cfg);
  return hit ? { found: true, state: hit.state } : { found: false, state: 'unknown' };
}
