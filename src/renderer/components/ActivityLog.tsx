/** @jsx h */
import { h, Fragment } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { LogEntry, LogLevel } from '@/types';
import { clockTime } from '../format';

const MAX_LOG_LINES = 600;
const LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];
/** Distance from the bottom (px) still counted as "pinned to latest". */
const PIN_THRESHOLD = 24;

/**
 * The live structured log (spec §3): newest at the bottom, monospace, working level
 * filters, and auto-scroll that pauses the moment the user scrolls up (a "jump to
 * latest" affordance resumes it). The `log` subscription is torn down on unmount.
 */
export function ActivityLog(): h.JSX.Element {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [levels, setLevels] = useState<Set<LogLevel>>(new Set(LEVELS));
  const [pinned, setPinned] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);

  // Subscribe to the streamed log; unsubscribe exactly this listener on unmount.
  useEffect(() => {
    const onLog = (entry: LogEntry): void => {
      setLogs((prev) => {
        const next = prev.concat(entry);
        return next.length > MAX_LOG_LINES
          ? next.slice(next.length - MAX_LOG_LINES)
          : next;
      });
    };
    window.peanut.on('log', onLog);
    return () => {
      window.peanut.off('log', onLog);
    };
  }, []);

  // Keep pinned to the bottom only while the user has not scrolled up.
  useEffect(() => {
    if (pinnedRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, levels]);

  const onScroll = useCallback((): void => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_THRESHOLD;
    pinnedRef.current = atBottom;
    setPinned(atBottom);
  }, []);

  const jumpToLatest = useCallback((): void => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    pinnedRef.current = true;
    setPinned(true);
  }, []);

  const toggleLevel = useCallback((level: LogLevel): void => {
    setLevels((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  }, []);

  const visible = logs.filter((l) => levels.has(l.level));

  return (
    <section class="panel panel--log">
      <div class="panel__head">
        <span class="panel__title">Activity</span>
        <div class="log__filters" role="group" aria-label="Log level filters">
          {LEVELS.map((level) => (
            <button
              key={level}
              class="chip"
              data-level={level}
              data-on={levels.has(level) ? 'true' : 'false'}
              onClick={() => toggleLevel(level)}
            >
              {level}
            </button>
          ))}
        </div>
        <button
          class="btn btn--ghost"
          onClick={() => setLogs([])}
          disabled={logs.length === 0}
        >
          Clear
        </button>
      </div>

      <div class="log" ref={scrollRef} onScroll={onScroll}>
        {visible.length === 0 ? (
          <div class="empty">
            {logs.length === 0
              ? 'No activity yet.'
              : 'No lines match the active filters.'}
          </div>
        ) : (
          visible.map((entry, i) => (
            <div key={i} class="log__line" data-level={entry.level}>
              <span class="log__time">{clockTime(entry.at)}</span>
              <span class="log__level">{entry.level}</span>
              <span class="log__msg">{entry.message}</span>
            </div>
          ))
        )}
      </div>

      {!pinned ? (
        <button class="log__jump" onClick={jumpToLatest}>
          Jump to latest ↓
        </button>
      ) : null}
    </section>
  );
}
