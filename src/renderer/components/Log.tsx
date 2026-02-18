import { h } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import type { LogEntry } from '../../types';

interface Props {
  logs: LogEntry[];
  logFilter: string;
  setLogFilter: (f: string) => void;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function Log({ logs, logFilter, setLogFilter }: Props) {
  const entriesRef = useRef<HTMLDivElement>(null);

  const filteredLogs = logFilter === 'all'
    ? logs
    : logs.filter((l) => l.level === logFilter);

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (entriesRef.current) {
      entriesRef.current.scrollTop = entriesRef.current.scrollHeight;
    }
  }, [filteredLogs.length]);

  const filters = ['all', 'info', 'warn', 'error', 'debug'];

  return (
    <div class="log-viewer">
      <div class="log-toolbar">
        {filters.map((f) => (
          <button
            key={f}
            class={`log-filter-btn ${logFilter === f ? 'active' : ''}`}
            onClick={() => setLogFilter(f)}
          >
            {f}
          </button>
        ))}
      </div>
      <div class="log-entries" ref={entriesRef}>
        {filteredLogs.length === 0 ? (
          <div class="log-empty"><span>No log entries yet.</span></div>
        ) : (
          filteredLogs.map((l, i) => {
            const time = new Date(l.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            return (
              <div class="log-entry" key={i}>
                <span class="log-time">{time}</span>
                <span class={`log-level ${l.level}`}>{l.level}</span>
                <span class="log-message" dangerouslySetInnerHTML={{ __html: escapeHtml(l.message) }} />
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
