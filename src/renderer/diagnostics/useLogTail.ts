import { useEffect, useState } from 'preact/hooks';
import type { LogEntry } from '@/shared/log-entry';

/** The panel keeps at most as many lines as main's log ring holds (a test pins the two together). */
export const LOG_SHOWN_MAX = 500;

export interface LogTail {
  /** Oldest first. */
  readonly entries: readonly LogEntry[];
  /** The tail could not be read; streamed lines still arrive. */
  readonly failed: boolean;
}

const cap = (entries: readonly LogEntry[]): readonly LogEntry[] =>
  entries.length > LOG_SHOWN_MAX ? entries.slice(entries.length - LOG_SHOWN_MAX) : entries;

const same = (a: LogEntry, b: LogEntry): boolean => a.at === b.at && a.level === b.level && a.message === b.message;

/**
 * The raw log for the Diagnostics panel (spec §12.9): main's ring tail, pulled once on mount, then each new
 * line as main streams it. Main sends the log push only while a panel asks for it, so the stream is on
 * exactly while this is mounted. A line streamed before the tail arrived is kept once.
 */
export function useLogTail(): LogTail {
  const [state, setState] = useState<LogTail>({ entries: [], failed: false });
  useEffect(() => {
    let alive = true;
    let early: LogEntry[] | null = [];
    const on = (entry: LogEntry): void => {
      if (!alive) return;
      if (early !== null) early.push(entry);
      else setState((s) => ({ ...s, entries: cap([...s.entries, entry]) }));
    };
    const settle = (tail: readonly LogEntry[], failed: boolean): void => {
      if (!alive) return;
      const streamed = (early ?? []).filter((e) => !tail.some((t) => same(t, e)));
      early = null;
      setState({ entries: cap([...tail, ...streamed]), failed });
    };
    window.epo.on('log', on);
    void window.epo.setLogStream(true);
    window.epo.logTail().then(
      (tail) => settle(tail, false),
      () => settle([], true),
    );
    return () => {
      alive = false;
      window.epo.off('log', on);
      void window.epo.setLogStream(false);
    };
  }, []);
  return state;
}
