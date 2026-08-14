/** @jsx h */
import { h } from 'preact';
import { prefersReducedMotion } from '@/renderer/lib/motion';
import { formatTicker, tickerCells } from '@/renderer/lib/ticker';

const REEL_DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

export interface NumberTickerProps {
  /** The numeric value to display (rounded, thousands-separated). */
  value: number;
  /** Prefix positives (and zero) with "+" — headline growth counters. */
  signed?: boolean;
}

/**
 * NumberTicker — slot-machine numerals for the console's live counters.
 *
 * Each digit is a vertical 0–9 reel shifted with an em-based
 * `translateY` transform, so a value change ROLLS every changed column to its
 * new digit (~420 ms on the shared `--ease` curve, see `.nt-reel` in
 * `primitives.css`). Cells are keyed from the RIGHT (see `tickerCells`) so the
 * units column survives length changes and count-ups read like an odometer.
 * Separators (thousands commas, signs) render as static glyphs.
 *
 * Under `prefers-reduced-motion` this collapses to a plain instant text swap.
 * Screen readers get the whole value once via `aria-label`; the reels (which
 * contain every digit 0–9) are hidden from the accessibility tree.
 */
export function NumberTicker({ value, signed }: NumberTickerProps): h.JSX.Element {
  const text = formatTicker(value, signed);
  if (prefersReducedMotion()) return <span class="num">{text}</span>;
  return (
    <span class="nt num" aria-label={text}>
      {tickerCells(text).map((cell) =>
        cell.digit !== null ? (
          <span key={cell.key} class="nt-col" aria-hidden="true">
            <span class="nt-reel" style={{ transform: `translateY(-${cell.digit}em)` }}>
              {REEL_DIGITS.map((d) => (
                <span key={d} class="nt-d">
                  {d}
                </span>
              ))}
            </span>
          </span>
        ) : (
          <span key={cell.key} class="nt-sep" aria-hidden="true">
            {cell.char}
          </span>
        ),
      )}
    </span>
  );
}
