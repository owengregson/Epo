import { useEffect, useRef, useState } from 'preact/hooks';
import type { LogEntry } from '@/types';

/** Ring-buffer cap for the in-memory log (Activity pane + ticker). */
const CAP = 200;

/** A streamed log entry stamped with a feed-local monotonic sequence number. */
export interface LogLine extends LogEntry {
  /** Unique within this feed — the stable render key (timestamps collide). */
  seq: number;
}

export interface LogFeed {
  /** Buffered log lines, oldest → newest, capped at {@link CAP}. */
  lines: LogLine[];
  /** The most recent line, or null before anything has streamed. */
  latest: LogLine | null;
}

/**
 * Subscribes to the streamed structured log (`on('log')`) and keeps a capped
 * rolling buffer. One subscription for the whole shell; torn down on unmount.
 */
export function useLogFeed(): LogFeed {
  const [lines, setLines] = useState<LogLine[]>([]);
  const seq = useRef(0);

  useEffect(() => {
    const onLog = (entry: LogEntry): void => {
      setLines((prev) => {
        const next = prev.concat({ ...entry, seq: seq.current++ });
        return next.length > CAP ? next.slice(next.length - CAP) : next;
      });
    };
    window.epo.on('log', onLog);
    return () => window.epo.off('log', onLog);
  }, []);

  return { lines, latest: lines.length ? lines[lines.length - 1] : null };
}
