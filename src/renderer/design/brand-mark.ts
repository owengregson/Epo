/**
 * The Epo mark's one geometry source: a flattened 8 with a slot cut from its
 * lower right, read as a lowercase "e". It is ONE masked silhouette, so the
 * brushed-metal gradients flow through it without a seam, and the shine lives
 * in the edge (a bright top highlight over a satin body, a shadowed lower edge).
 *
 * The shape is locked: only its scale and position ever change. The favicon in
 * `src/renderer/index.html` is `brandMarkSvg()` as a data URI, pinned byte for
 * byte by a test. It lives here, not in `src/shared/`: the static-timing gate
 * scans `src/shared` and these numbers would need allow-list entries there.
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

const LAYER_IDS = { body: 'epoBody', shadow: 'epoShadow', highlight: 'epoHi' } as const;
const LAYER_ORDER = ['body', 'shadow', 'highlight'] as const;

const rectSvg = (r: MarkRect): string =>
  `<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}"${r.r > 0 ? ` rx="${r.r}" ry="${r.r}"` : ''} fill="${r.keep ? '#fff' : '#000'}"/>`;

const stopSvg = (s: MarkStop): string =>
  `<stop offset="${s.offset}%" stop-color="${s.color}"${s.opacity === 1 ? '' : ` stop-opacity="${s.opacity}"`}/>`;

/** The mark as one standalone SVG document: the favicon's only source. */
export function brandMarkSvg(): string {
  const n = BRAND_MARK.size;
  const gradients = LAYER_ORDER.map((k) => {
    const l = BRAND_MARK.layers[k];
    return `<linearGradient id="${LAYER_IDS[k]}" x1="0" y1="${l.y1}" x2="0" y2="${l.y2}" gradientUnits="userSpaceOnUse">${l.stops.map(stopSvg).join('')}</linearGradient>`;
  }).join('');
  const fills = LAYER_ORDER.map((k) => `<rect width="${n}" height="${n}" fill="url(#${LAYER_IDS[k]})"/>`).join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}" viewBox="0 0 ${n} ${n}" fill="none" role="img" aria-label="Epo">` +
    `<defs><mask id="epoCut" maskUnits="userSpaceOnUse" x="0" y="0" width="${n}" height="${n}">${BRAND_MARK.mask.map(rectSvg).join('')}</mask>${gradients}</defs>` +
    `<g mask="url(#epoCut)">${fills}</g></svg>`
  );
}
