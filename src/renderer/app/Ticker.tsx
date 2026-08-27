/** @jsx h */
import { Fragment, h } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import type { LogEntry, LogLevel } from '@/types';
import { clockTime } from '../lib/format';
import { prefersReducedMotion } from '../lib/motion';

/** Collapse the four log levels onto the ticker's two accent tones. */
function tone(level: LogLevel): string {
  return level === 'warn' ? 'warn' : level === 'error' ? 'error' : 'info';
}

export interface TickerProps {
  /** The latest log line, or null before anything has streamed. */
  line: LogEntry | null;
}

/**
 * The docked activity ticker: a pulsing beacon (live only while running, via
 * `.console[data-state]`) and the most recent log line, which swaps in with a
 * short upward wipe whenever it changes.
 */
export function Ticker({ line }: TickerProps): h.JSX.Element {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion()) return;
    el.classList.remove('swap');
    void el.offsetWidth; // reflow → restart the swap animation
    el.classList.add('swap');
  }, [line]);

  return (
    <div class="ticker" aria-live="polite">
      <span class="beacon" aria-hidden="true" />
      <span class="tline num" ref={ref}>
        {line ? (
          <>
            <span class="ts">{clockTime(line.at)}</span>
            <span class={`lv-${tone(line.level)}`}>{line.level}</span>
            {line.message}
          </>
        ) : (
          <span class="ts">standing by</span>
        )}
      </span>
    </div>
  );
}
