import { nativeViewSignal } from '@/renderer/app/shell-context';
import type { Box } from '@/renderer/lib/anchor';

/**
 * The window region the Instagram page covers right now (spec §12.4: on Live it
 * fills the stage body, right of the console and below the stage bar), or null
 * while nothing native is drawn there. Measured, so it follows the real layout.
 */
export function coveredRegion(): Box | null {
  if (!nativeViewSignal.peek()) return null;
  const body = document.querySelector('.stagepane-body')?.getBoundingClientRect();
  if (body === undefined || body.width <= 0 || body.height <= 0) return null;
  return { x: body.left, y: body.top, w: body.width, h: body.height };
}

/** An element's box in viewport coordinates. */
export function boxOf(el: Element): Box {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}
