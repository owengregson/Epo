/**
 * The Epo mark's one geometry source: a flattened 8 with a slot cut from its
 * lower right, read as a lowercase "e". It is ONE masked silhouette, so the
 * brushed-metal gradients flow through it without a seam, and the shine lives
 * in the edge (a bright top highlight over a satin body, a shadowed lower edge).
 *
 * The shape is locked: only its scale and position ever change. The favicon in
 * `src/renderer/index.html` carries a copy that a test pins to this module.
 */

/** One rectangle of the mask, in viewBox units; `keep` paints it, otherwise it cuts. */
interface MarkRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Corner radius (rx = ry); 0 is a square corner. */
  readonly r: number;
  readonly keep: boolean;
}

/** One gradient stop; `opacity` 1 is written without a `stop-opacity`. */
interface MarkStop {
  readonly offset: number;
  readonly color: string;
  readonly opacity: number;
}

/** A vertical linear gradient across the whole square, in user space. */
export interface MarkLayer {
  readonly y1: number;
  readonly y2: number;
  readonly stops: readonly MarkStop[];
}

export interface BrandMark {
  /** The square viewBox edge. */
  readonly size: number;
  /** Paint order: the body first, then the two counters and the slot. */
  readonly mask: readonly MarkRect[];
  /** Painted in this order over the masked square. */
  readonly layers: { readonly body: MarkLayer; readonly shadow: MarkLayer; readonly highlight: MarkLayer };
}

export const BRAND_MARK: BrandMark = {
  size: 64,
  mask: [
    { x: 7, y: 7, width: 50, height: 50, r: 16, keep: true },
    { x: 15, y: 15, width: 34, height: 13, r: 7, keep: false },
    { x: 15, y: 36, width: 34, height: 13, r: 7, keep: false },
    { x: 43, y: 36, width: 21, height: 10, r: 0, keep: false },
  ],
  layers: {
    body: {
      y1: 6,
      y2: 58,
      stops: [
        { offset: 0, color: '#eef1f5', opacity: 1 },
        { offset: 18, color: '#c9cdd4', opacity: 1 },
        { offset: 44, color: '#eceff3', opacity: 1 },
        { offset: 57, color: '#abafb7', opacity: 1 },
        { offset: 80, color: '#cccfd5', opacity: 1 },
        { offset: 100, color: '#e7eaef', opacity: 1 },
      ],
    },
    shadow: {
      y1: 30,
      y2: 57,
      stops: [
        { offset: 0, color: '#3a3d44', opacity: 0 },
        { offset: 100, color: '#2c2e34', opacity: 0.9 },
      ],
    },
    highlight: {
      y1: 7,
      y2: 40,
      stops: [
        { offset: 0, color: '#ffffff', opacity: 0.95 },
        { offset: 55, color: '#ffffff', opacity: 0 },
      ],
    },
  },
};
