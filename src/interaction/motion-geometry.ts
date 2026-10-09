export interface Point {
  x: number;
  y: number;
}

export interface ElementRect extends Point {
  width: number;
  height: number;
}

export const clampNum = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

export function assertPoint(point: Point): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new RangeError('Motion coordinates must be finite');
  }
}

export function assertRect(rect: ElementRect): void {
  assertPoint(rect);
  if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height)
    || rect.width <= 0 || rect.height <= 0
    || !Number.isFinite(rect.x + rect.width) || !Number.isFinite(rect.y + rect.height)) {
    throw new RangeError('Motion rectangle must have finite, positive dimensions');
  }
}

export function containPoint(point: Point, bounds?: ElementRect): Point {
  assertPoint(point);
  if (!bounds) return point;
  assertRect(bounds);
  return {
    x: clampNum(point.x, bounds.x, bounds.x + bounds.width),
    y: clampNum(point.y, bounds.y, bounds.y + bounds.height),
  };
}

/** Visible portion of a page-reported hitbox; touching edges have no hit area. */
export function intersectRect(rect: ElementRect, bounds: ElementRect): ElementRect | null {
  assertRect(rect);
  assertRect(bounds);
  const x = Math.max(rect.x, bounds.x);
  const y = Math.max(rect.y, bounds.y);
  const right = Math.min(rect.x + rect.width, bounds.x + bounds.width);
  const bottom = Math.min(rect.y + rect.height, bounds.y + bounds.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}
