/**
 * Mount a REAL, scrubbed Instagram snapshot into jsdom.
 *
 * jsdom has no layout engine: every `getBoundingClientRect()` is 0×0 and
 * `scrollHeight`/`clientHeight` are 0. The page scripts deliberately decide by
 * GEOMETRY (a control must be visibly pressable; a scroller must overflow), so
 * the geometry a browser would have computed is stamped on.
 *
 * The difference from `tests/kit/adapter-dom.ts` is the input: those suites
 * mount hand-written markup that encodes what we BELIEVE Instagram ships. These
 * mount what it actually shipped on 2026-08-12, obfuscated class names and all.
 */

import { box, DEFAULT_BOX, hitTest } from '../kit/adapter-dom';
import { domText } from './corpus';

/**
 * Render a corpus snapshot and give every element a pressable box — except the
 * ones the page itself hides, which keep the degenerate rect a real browser
 * would report for them (the hidden-twin trap depends on that difference).
 */
export function mountSnapshot(file: string): HTMLElement {
  document.body.innerHTML = domText(file);
  for (const el of Array.from(document.querySelectorAll('*'))) {
    const style = (el.getAttribute('style') ?? '').replace(/\s+/g, '');
    const hidden = style.includes('display:none') || style.includes('visibility:hidden');
    box(el, hidden ? { x: 0, y: 0, width: 0, height: 0 } : DEFAULT_BOX);
  }
  box(document.body, DEFAULT_BOX);
  return document.body;
}

/** Make one element behave as a scroller with overflowing content. */
export function asScroller(
  el: Element,
  opts: { scrollHeight: number; clientHeight: number; scrollTop?: number },
): void {
  // The trailing `;` must be trimmed: `…;;overflow-y:auto` is invalid CSS and
  // jsdom drops the whole declaration, which silently un-scrolls the element.
  const prior = (el.getAttribute('style') ?? '').trim().replace(/;+$/, '');
  el.setAttribute('style', prior === '' ? 'overflow-y:auto' : `${prior};overflow-y:auto`);
  for (const [key, value] of Object.entries({
    scrollHeight: opts.scrollHeight,
    clientHeight: opts.clientHeight,
    scrollTop: opts.scrollTop ?? 0,
  })) {
    Object.defineProperty(el, key, { value, configurable: true });
  }
}

/**
 * A suggestion carousel carrying ANOTHER account's Follow button — the exact
 * shape ADR 0302 refuses a document-wide fallback for. Appended OUTSIDE the
 * header, where a widened scope would find it.
 */
export const suggestionCarousel = (): string =>
  `<div role="region" aria-label="Suggested for you">
     <div><a href="/user_zz9/"><img alt="user_zz9's profile picture"></a>
     <button type="button">Follow</button></div>
     <div><a href="/user_zz8/"><img alt="user_zz8's profile picture"></a>
     <button type="button">Follow</button></div>
   </div>`;

export { hitTest };
