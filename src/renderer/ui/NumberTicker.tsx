import { type JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { reducedMotionSignal } from '@/renderer/app/motion-signal';
import { formatTicker, tickerCells } from '@/renderer/lib/ticker';

const REEL_DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

export interface NumberTickerProps {
  /** The numeric value to display (rounded, thousands-separated). */
  value: number;
  /** Prefix positives (and zero) with "+" — headline growth counters. */
  signed?: boolean;
  /** Write a negative with the true minus sign (U+2212) instead of a hyphen. */
  minus?: boolean;
  /** Called when the value rises after the ticker armed (the "+N" chip), with the rise. */
  onIncrease?(delta: number): void;
}

/**
 * NumberTicker — slot-machine numerals for the live counters (spec §12.7 "settle").
 *
 * Each digit is a vertical 0–9 reel shifted with an em-based `translateY`, so a value change ROLLS every
 * changed column (`--dur-4` on the shared ease, `.nt-reel` in `controls.css`). Cells are keyed from the
 * RIGHT so the units column survives length changes. The ticker ARMS one frame after mount: the first value
 * shows at once (counts never roll at boot) and only later changes roll and report a rise.
 *
 * Under reduced motion it is a plain text swap. Screen readers get the whole value once via `aria-label`.
 */
export function NumberTicker({ value, signed, minus, onIncrease }: NumberTickerProps): JSX.Element {
  const raw = formatTicker(value, signed);
  const text = minus ? raw.replace('-', '−') : raw;
  const [armed, setArmed] = useState(false);
  const shown = useRef(value);
  const rise = useRef(onIncrease);
  rise.current = onIncrease;

  useEffect(() => {
    const frame = requestAnimationFrame(() => setArmed(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const before = shown.current;
    shown.current = value;
    if (armed && Math.round(value) > Math.round(before)) rise.current?.(Math.round(value) - Math.round(before));
  }, [value, armed]);

  if (reducedMotionSignal.value) return <span class="num">{text}</span>;
  return (
    <span class={armed ? 'nt num is-armed' : 'nt num'} aria-label={text}>
      {tickerCells(text).map((cell) =>
        cell.digit !== null ? (
          <span key={cell.key} class="nt-col" aria-hidden="true">
            <span
              class="nt-reel"
              style={{ transform: `translateY(-${cell.digit}em)`, transition: armed ? undefined : 'none' }}
            >
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
