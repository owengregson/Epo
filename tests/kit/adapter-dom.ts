/**
 * jsdom helpers for the page-script suites (`tests/page/**`).
 *
 * jsdom has no layout engine: every `getBoundingClientRect()` is 0×0 and
 * `scrollHeight`/`clientHeight` are 0. The page scripts deliberately decide by
 * GEOMETRY (a control must be visibly pressable; a scroller must overflow), so
 * these helpers stamp the geometry a real browser would have computed.
 */

import type { RegexLit } from '@/adapter/page';

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The default box every mounted element gets: on-screen and comfortably pressable. */
export const DEFAULT_BOX: Box = { x: 40, y: 40, width: 200, height: 40 };

/** Serialize a RegExp the way the version module hands it to page context. */
export const rx = (re: RegExp): RegexLit => ({ source: re.source, flags: re.flags });

/** Stamp one element's viewport rect. */
export function box(el: Element, b: Box): void {
  el.getBoundingClientRect = (): DOMRect =>
    ({
      x: b.x,
      y: b.y,
      left: b.x,
      top: b.y,
      right: b.x + b.width,
      bottom: b.y + b.height,
      width: b.width,
      height: b.height,
      toJSON: () => ({}),
    }) as DOMRect;
}

/** Make an element behave as a scroller with overflowing content. */
export function scroller(
  el: Element,
  opts: { scrollHeight: number; clientHeight: number; scrollTop?: number },
): void {
  const prior = el.getAttribute('style');
  el.setAttribute('style', prior ? `${prior};overflow-y:auto` : 'overflow-y:auto');
  for (const [k, v] of Object.entries({
    scrollHeight: opts.scrollHeight,
    clientHeight: opts.clientHeight,
    scrollTop: opts.scrollTop ?? 0,
  })) {
    Object.defineProperty(el, k, { value: v, configurable: true });
  }
}

/**
 * Render `html` into the document and give every element the default box, so a
 * test only has to stamp the geometry it actually cares about.
 */
export function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  for (const el of Array.from(document.querySelectorAll('*'))) box(el, DEFAULT_BOX);
  box(document.body, DEFAULT_BOX);
  return document.body;
}

/** Replace `document.elementFromPoint` (jsdom has no hit testing) with a stub. */
export function hitTest(fn: (x: number, y: number) => Element | null): void {
  document.elementFromPoint = fn as typeof document.elementFromPoint;
}
