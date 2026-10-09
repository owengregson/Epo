import { useRef } from 'preact/hooks';
import { logSignal } from '@/renderer/app/shell-context';
import { useBridgeEvent } from '@/renderer/hooks/useBridgeEvent';
import type { LogEntry } from '@/types';

/** Ring-buffer cap for the in-memory log (Activity pane + ticker). */
const CAP = 200;

/** A streamed log entry stamped with a feed-local monotonic sequence number. */
export interface LogLine extends LogEntry {
  /** Unique within this feed — the stable render key (timestamps collide). */
  seq: number;
}

/**
 * Subscribes to the streamed structured log (`on('log')`) and keeps a capped
 * rolling buffer on {@link logSignal}. One subscription for the whole shell;
 * torn down on unmount. Publishing to a signal is what keeps a streamed line
 * from re-rendering the tree — only the Ticker and the Activity card read it.
 */
export function useLogFeed(): void {
  const seq = useRef(0);

  useBridgeEvent('log', (entry) => {
    const prev = logSignal.value;
    const next = prev.concat({ ...entry, seq: seq.current++ });
    logSignal.value = next.length > CAP ? next.slice(next.length - CAP) : next;
  });
}
