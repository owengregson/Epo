/**
 * Board geometry — pure, so the direction-boards test can prove that nothing
 * overlaps at the three window widths without a layout engine. Frames are
 * placed by `packFrames`; every product zone takes its height from here.
 */

/** Spec §12.2 / §12.6: the column and the top band never change size. */
export const SIDEBAR_W = 460;
export const BAND_H = 44;

/** The window widths and sidebar heights the boards are judged at. */
export const BOARD_WIDTHS = [1024, 1440, 1920] as const;
export const SIDEBAR_HEIGHTS = [640, 800, 920] as const;

/** Board canvas rhythm: outer padding and the gap between frames. */
export const BOARD_PAD = 32;
const BOARD_GAP = 32;
/** A frame's caption block above its body (a title and up to two lines of note). */
const CAPTION_H = 80;

export interface FrameSize {
  key: string;
  /** Body width; ignored when `bleed` (the frame then spans the canvas). */
  w: number;
  h: number;
  /** Full-bleed: a window exactly as wide as the canvas, alone on its row. */
  bleed?: boolean;
}

export interface Rect {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Rows of frames, centred, wrapping before the canvas edge. A bleed frame owns
 * its row edge to edge so a window board shows the app at the real window width.
 * Rect heights include the caption block.
 */
export function packFrames(frames: readonly FrameSize[], canvas: number, top = 0): Rect[] {
  const rects: Rect[] = [];
  let row: FrameSize[] = [];
  let y = top;
  const flush = (): void => {
    if (row.length === 0) return;
    const used = row.reduce((s, f) => s + f.w, 0) + BOARD_GAP * (row.length - 1);
    let x = Math.max(BOARD_PAD, Math.floor((canvas - used) / 2));
    const tallest = Math.max(...row.map((f) => f.h));
    for (const f of row) {
      rects.push({ key: f.key, x, y, w: f.w, h: f.h + CAPTION_H });
      x += f.w + BOARD_GAP;
    }
    y += tallest + CAPTION_H + BOARD_GAP;
    row = [];
  };
  for (const f of frames) {
    if (f.bleed) {
      flush();
      rects.push({ key: f.key, x: 0, y, w: canvas, h: f.h + CAPTION_H });
      y += f.h + CAPTION_H + BOARD_GAP;
      continue;
    }
    const used = row.reduce((s, g) => s + g.w + BOARD_GAP, 0);
    if (row.length > 0 && used + f.w > canvas - 2 * BOARD_PAD) flush();
    row.push(f);
  }
  flush();
  return rects;
}

/** Scaled window thumbnails per row: two below 1700 px of canvas, three above. */
export function thumbColumns(canvas: number): number {
  return canvas >= 1700 ? 3 : 2;
}

/** Edge of one thumbnail so `cols` of them fill the padded canvas. */
export function thumbWidth(canvas: number, cols: number): number {
  return Math.floor((canvas - 2 * BOARD_PAD - (cols - 1) * BOARD_GAP) / cols);
}

type SidebarMode = 'full' | 'scroll' | 'compact';

export interface SidebarGeometry {
  mode: SidebarMode;
  masthead: number;
  now: number;
  today: number;
  results: number;
  footer: number;
  /** `full`: the activity zone. `scroll`/`compact`: the one scroller (Today, Results, Activity). */
  rest: number;
}

/** Spec §12.2: fixed zones; ≥ 800 as drawn, 680–799 one scroller, < 680 also a compact Now. */
export function sidebarGeometry(height: number): SidebarGeometry {
  const mode: SidebarMode = height >= 800 ? 'full' : height >= 680 ? 'scroll' : 'compact';
  const g = { mode, masthead: BAND_H, now: mode === 'compact' ? 176 : 216, today: 172, results: 168, footer: 36 };
  const fixed = g.masthead + g.now + g.footer + (mode === 'full' ? g.today + g.results : 0);
  return { ...g, rest: height - fixed };
}

/** The Settings page's three layouts by stage width (rail · content · "What to expect"). */
export type SettingsLayout = 'wide' | 'medium' | 'narrow';

export function settingsLayout(stageWidth: number): SettingsLayout {
  return stageWidth >= 1180 ? 'wide' : stageWidth >= 840 ? 'medium' : 'narrow';
}

/** People keeps two columns only where each still gets the width its lists were built for. */
export function peopleColumns(stageWidth: number): 1 | 2 {
  return stageWidth >= 1100 ? 2 : 1;
}

/** Stage tabs: equal width `clamp(100px, (stage − 32px) / 5, 132px)`. */
export function tabWidth(stageWidth: number): number {
  return Math.min(132, Math.max(100, Math.floor((stageWidth - 32) / 5)));
}

/** True when two rects share any area. */
export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
