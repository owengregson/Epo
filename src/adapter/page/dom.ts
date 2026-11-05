/**
 * In-page DOM mechanics shared by every page script.
 *
 * Everything under `src/adapter/page/` runs INSIDE the Instagram tab, bundled
 * into one string by `esbuild.page.mjs` and evaluated by the Actor. It carries
 * ZERO Instagram literals: every selector, regex, and scope list arrives as a
 * JSON config object built by the active version module, so a DOM change on
 * Instagram's side still touches only `src/adapter/versions/*` — while the
 * mechanics themselves are type-checked, linted, and DOM-tested like any other
 * code (`tests/page/**`).
 */

/** A RegExp serialized for the JSON trip into page context. */
export interface RegexLit {
  source: string;
  flags: string;
}

/** A viewport bounding rect (CSS px), as the locate scripts report it. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Rebuild a RegExp from its serialized form. */
export const mk = (lit: RegexLit): RegExp => new RegExp(lit.source, lit.flags);

/** Collapse whitespace and trim — how every text matcher sees an element. */
export const norm = (t: string | null | undefined): string => (t || '').replace(/\s+/g, ' ').trim();

/** The element's viewport rect, in the shape that survives structured clone. */
export const rectOf = (el: Element): Rect => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
};

/** The centre of a rect: where a press aims and where a hit test samples. */
export const centreOf = (r: Rect): { x: number; y: number } => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

/** Hit-test samples per axis when measuring how much of a control is exposed. */
const AIM_GRID = 8;

/**
 * The part of `el`'s rect a press can actually reach: the bounding box of the
 * sample cells whose hit test lands on `el` or inside it. Live 2026-11-02 the
 * drawer's header overlapped the lower half of its close X, and the click guard
 * (rightly) refused a press there — so the locate reports where one CAN land.
 * `undefined` when every cell is exposed (aim at the whole rect), when none is
 * (nothing to aim at: the guard refuses the press, loudly), or when the page
 * cannot hit-test.
 */
export function exposedAim(el: Element, rect: Rect): Rect | undefined {
  if (typeof document.elementFromPoint !== 'function') return undefined;
  const cw = rect.width / AIM_GRID;
  const ch = rect.height / AIM_GRID;
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  let hits = 0;
  for (let i = 0; i < AIM_GRID; i++) {
    for (let j = 0; j < AIM_GRID; j++) {
      const top = document.elementFromPoint(rect.x + (i + 0.5) * cw, rect.y + (j + 0.5) * ch);
      if (top === null || !el.contains(top)) continue;
      hits += 1;
      x0 = Math.min(x0, rect.x + i * cw);
      y0 = Math.min(y0, rect.y + j * ch);
      x1 = Math.max(x1, rect.x + (i + 1) * cw);
      y1 = Math.max(y1, rect.y + (j + 1) * ch);
    }
  }
  if (hits === 0 || hits === AIM_GRID * AIM_GRID) return undefined;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * Whether a control is worth pressing: a non-degenerate rect with its centre
 * on-viewport, not hidden/collapsed/transparent.
 *
 * Guards the hidden-twin trap: some menus render a matching control twice (one
 * `display:none`), and a search returning the FIRST DOM match kept finding the
 * hidden copy while the real control sat plainly on screen.
 */
export function visible(el: Element): boolean {
  const r = rectOf(el);
  if (!(r.width >= 2 && r.height >= 2)) return false;
  const c = centreOf(r);
  if (c.x <= 0 || c.y <= 0 || c.x >= window.innerWidth || c.y >= window.innerHeight) return false;
  const st = window.getComputedStyle(el);
  if (st.visibility === 'hidden' || st.display === 'none') return false;
  return Number(st.opacity === '' ? 1 : st.opacity) > 0.05;
}

/**
 * Whether a press at `el`'s centre reaches it: the hit test lands on it or inside it. `visible()`
 * alone accepts a layer still fading out beneath a newer one. A page that cannot hit-test defers to it.
 */
export function onTop(el: Element): boolean {
  if (typeof document.elementFromPoint !== 'function') return true;
  const c = centreOf(rectOf(el));
  const hit = document.elementFromPoint(c.x, c.y);
  return hit !== null && el.contains(hit);
}

/**
 * The element the PAGE treats as the control: the nearest press-shaped
 * ancestor matching `selector`, or the element itself. Pressing a text node's
 * own rect can miss a handler that lives on a wrapping button.
 */
export const clickableOf = (el: Element, selector: string): Element => el.closest(selector) || el;

/**
 * The scopes a search walks, in priority order. Each entry is a selector; ALL
 * matches of each are included, so `'nav, [role="navigation"]'` yields every
 * nav before the next entry. A missing scope is skipped, never null-padded.
 */
export function scopesOf(selectors: readonly string[]): Element[] {
  const out: Element[] = [];
  for (const sel of selectors) {
    for (const el of Array.from(document.querySelectorAll(sel))) out.push(el);
  }
  return out;
}

/**
 * The SMALLEST element in `scope` whose own text matches `rx` — its text
 * matches but no child's does. Without this, every ancestor of a label matches
 * first and the search returns a whole panel instead of the control.
 */
export function smallestMatching(scope: ParentNode, nodeSel: string, rx: RegExp): Element | null {
  for (const n of Array.from(scope.querySelectorAll(nodeSel))) {
    if (!rx.test(norm(n.textContent))) continue;
    let smallest = true;
    for (const c of Array.from(n.children)) {
      if (rx.test(norm(c.textContent))) {
        smallest = false;
        break;
      }
    }
    if (smallest) return n;
  }
  return null;
}

/**
 * The descendant of `root` with the greatest `scrollHeight` whose computed
 * overflow-y is auto|scroll and whose content actually overflows — the list's
 * own scroller. Class names rotate, so the container is found by BEHAVIOUR.
 */
export function largestScrollable(root: ParentNode): Element | null {
  let best: Element | null = null;
  let bestH = 0;
  for (const el of Array.from(root.querySelectorAll('*'))) {
    const oy = window.getComputedStyle(el).overflowY;
    if (oy !== 'auto' && oy !== 'scroll') continue;
    if (el.scrollHeight <= el.clientHeight) continue;
    if (el.scrollHeight > bestH) {
      bestH = el.scrollHeight;
      best = el;
    }
  }
  return best;
}

/** A located control's rect, plus whether a self-recovery pass found it. */
export interface LocateRect {
  found: boolean;
  rect?: Rect;
  /** The exposed part of `rect` when part of it is covered (see {@link exposedAim}). */
  aim?: Rect;
  fallback?: boolean;
}

/** A located scroll container: rect, metrics, and an optional hover-safe point. */
export interface LocateScroll {
  found: boolean;
  rect?: Rect;
  scrollTop?: number;
  scrollHeight?: number;
  clientHeight?: number;
  safePoint?: { x: number; y: number };
}

/** Report a scroll container's rect + metrics. */
export const scrollReport = (el: Element): LocateScroll => ({
  found: true,
  rect: rectOf(el),
  scrollTop: el.scrollTop,
  scrollHeight: el.scrollHeight,
  clientHeight: el.clientHeight,
});
