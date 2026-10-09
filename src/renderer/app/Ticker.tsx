import { type JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { latestLogSignal } from '@/renderer/app/shell-context';
import { clockTime } from '@/renderer/lib/format';
import { prefersReducedMotion } from '@/renderer/lib/motion';
import type { LogLevel } from '@/types';

/** Collapse the four log levels onto the ticker's two accent tones. */
function tone(level: LogLevel): string {
  return level === 'warn' ? 'warn' : level === 'error' ? 'error' : 'info';
}

/**
 * The docked activity ticker: a pulsing beacon (live only while running, via
 * `.console[data-state]`) and the most recent log line, which swaps in with a
 * short upward wipe whenever it changes.
 *
 * It reads the newest line straight off {@link latestLogSignal}: a streamed
 * line re-renders the ticker (and the Activity card), never the whole console.
 */
export function Ticker(): JSX.Element {
  const line = latestLogSignal.value;
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
