/** A rectangle in the coordinate space the floating element is positioned in. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Which edge of the anchor the floating element prefers. */
export type Side = 'above' | 'below' | 'left' | 'right' | 'inside';

export interface PlaceOptions {
  /** Preferred side (default `'above'`). */
  side?: Side;
  /** Gap between the anchor and the floating element. */
  gap?: number;
  /** Minimum gutter kept between the floating element and the bounds. */
  edge?: number;
  /**
   * Flip to the opposite side when the preferred one does not fit. Only
   * `'above'`/`'below'` flip — sideways placements clamp instead, because a
   * flipped side reads as a different pointer.
   */
  flip?: boolean;
  /** Cross-axis alignment for `'above'`/`'below'` (default centred). */
  align?: 'start' | 'center';
}

/**
 * Place a floating element against an anchor: measure, offset to the preferred
 * side, optionally flip, then clamp inside `bounds`.
 *
 * One positioner for every popover in the app (global tooltip, tour card, graph
 * tip) — the same clamp bug used to be fixed three times. `bounds` is the
 * viewport for fixed-position layers and the host's client box for elements
 * positioned inside a container.
 */
export function place(
  anchor: Box,
  size: { w: number; h: number },
  bounds: { w: number; h: number },
  opts: PlaceOptions = {},
): { left: number; top: number } {
  const { side = 'above', gap = 8, edge = 8, flip = true, align = 'center' } = opts;

  let left: number;
  let top: number;
  switch (side) {
    case 'inside':
      left = anchor.x + anchor.w / 2 - size.w / 2;
      top = anchor.y + anchor.h / 2 - size.h / 2;
      break;
    case 'right':
      left = anchor.x + anchor.w + gap;
      top = anchor.y + anchor.h / 2 - size.h / 2;
      break;
    case 'left':
      left = anchor.x - size.w - gap;
      top = anchor.y + anchor.h / 2 - size.h / 2;
      break;
    case 'below':
      left = align === 'start' ? anchor.x : anchor.x + anchor.w / 2 - size.w / 2;
      top = anchor.y + anchor.h + gap;
      if (flip && top + size.h > bounds.h - edge) top = anchor.y - size.h - gap;
      break;
    default:
      left = align === 'start' ? anchor.x : anchor.x + anchor.w / 2 - size.w / 2;
      top = anchor.y - size.h - gap;
      if (flip && top < edge) top = anchor.y + anchor.h + gap;
  }

  return {
    left: clampAxis(left, size.w, bounds.w, edge),
    top: clampAxis(top, size.h, bounds.h, edge),
  };
}

/** Clamp one axis into `[edge, extent - length - edge]`, never past `edge`. */
function clampAxis(value: number, length: number, extent: number, edge: number): number {
  return Math.max(edge, Math.min(value, extent - length - edge));
}

/**
 * Clamp an already-computed position so the element stays inside `bounds` —
 * for floating elements placed at a raw point (a canvas hit, a cursor) rather
 * than against an element box.
 */
export function clampInto(
  at: { left: number; top: number },
  size: { w: number; h: number },
  bounds: { w: number; h: number },
  edge = 8,
): { left: number; top: number } {
  return {
    left: clampAxis(at.left, size.w, bounds.w, edge),
    top: clampAxis(at.top, size.h, bounds.h, edge),
  };
}
