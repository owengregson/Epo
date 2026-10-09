import type { Rect } from './dom';

/** Recheck the real hit target immediately before pressing, after cursor travel. */
export function canClick({ target, point }: { target: Rect; point: { x: number; y: number } }): boolean {
  return clickTarget({ target, point }) !== null;
}

/** Returning the node lets CDP hold its identity without adding page globals. */
export function clickTarget({ target, point }: { target: Rect; point: { x: number; y: number } }): Element | null {
  if (![target.x, target.y, target.width, target.height, point.x, point.y].every(Number.isFinite)) return null;
  if (point.x <= 0 || point.y <= 0 || point.x >= window.innerWidth || point.y >= window.innerHeight) return null;
  if (point.x <= target.x || point.y <= target.y || point.x >= target.x + target.width || point.y >= target.y + target.height) return null;
  let matched: Element | null = null;
  // Walk only the TOP hit's ancestors. elementsFromPoint would also include a
  // covered button and incorrectly sanction pressing the overlay above it.
  for (let el = document.elementFromPoint(point.x, point.y); el; el = el.parentElement) {
    if (el.matches(':disabled, [aria-disabled="true"], [inert]')) return null;
    const rect = el.getBoundingClientRect();
    if (Math.round(rect.x) === Math.round(target.x)
      && Math.round(rect.y) === Math.round(target.y)
      && Math.round(rect.width) === Math.round(target.width)
      && Math.round(rect.height) === Math.round(target.height)) matched ??= el;
  }
  return matched;
}
