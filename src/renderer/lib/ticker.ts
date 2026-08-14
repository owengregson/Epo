/**
 * NumberTicker math — the pure half of the slot-machine number animation.
 *
 * Kept free of Preact/DOM so the column model is unit-testable under the node
 * jest environment: `formatTicker` renders a value to its display string and
 * `tickerCells` splits that string into stable, right-anchored cells the
 * component maps to rolling digit reels (digits) or static glyphs (separators).
 */

import { commas } from '@/renderer/lib/format';

/** One rendered cell of a ticker: a rolling digit column or a static glyph. */
export interface TickerCell {
  /**
   * Stable key: the cell's distance from the RIGHT end of the string (1 = the
   * units digit). Anchoring keys on the right keeps the units column the SAME
   * component instance as the number grows through a length change
   * (999 → 1,000), so a count-up rolls the low digits instead of remounting
   * every column.
   */
  key: number;
  /** The literal character this cell shows. */
  char: string;
  /** The digit 0–9 when this cell is a rolling column; `null` for separators. */
  digit: number | null;
}

/**
 * Render a value to its ticker display string: rounded, thousands-separated,
 * with an explicit sign when `signed` (headline growth counters show "+0").
 */
export function formatTicker(value: number, signed = false): string {
  const rounded = Math.round(value);
  const abs = commas(Math.abs(rounded));
  if (rounded < 0) return `-${abs}`;
  return signed ? `+${abs}` : abs;
}

/** Split a formatted string into right-anchored ticker cells. */
export function tickerCells(formatted: string): TickerCell[] {
  const chars = [...formatted];
  return chars.map((char, i) => ({
    key: chars.length - i,
    char,
    digit: char >= '0' && char <= '9' ? char.charCodeAt(0) - 48 : null,
  }));
}
