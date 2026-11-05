/**
 * Diagnostics copy (Settings › Advanced › Diagnostics): the raw log's controls and the incident list. The
 * log itself is shown as main wrote it; everything around it is plain words.
 */
import type { LogEntry, LogLevel } from '@/shared/log-entry';

export const DIAGNOSTICS_COPY = {
  title: 'Diagnostics',
  lead: 'What Epo has been doing, line by line. Useful when something needs a look.',
  levels: { all: 'All', info: 'Info', warn: 'Warnings', error: 'Errors' },
  search: 'Search the log',
  pause: 'Pause',
  resume: 'Resume',
  copy: 'Copy',
  copied: 'Log copied.',
  copyFailed: 'Couldn’t copy the log.',
  openFolder: 'Open log folder',
  paused: 'Paused — new lines wait until you resume.',
  empty: 'No log lines yet.',
  noMatch: 'No lines match.',
  unreadable: 'Couldn’t read the earlier log. New lines still show here.',
  incidents: 'Recent incidents',
  noIncidents: 'No incidents recorded.',
  pageNow: 'The Instagram page right now',
  pageFree: 'Epo isn’t using it.',
} as const;

/** The level filter: each choice shows its level and the more serious ones. */
export type LevelFilter = keyof typeof DIAGNOSTICS_COPY.levels;

const RANK: Readonly<Record<LogLevel, number>> = { debug: 0, info: 1, warn: 2, error: 3 };
const FLOOR: Readonly<Record<LevelFilter, number>> = { all: 0, info: 1, warn: 2, error: 3 };

export function passes(entry: LogEntry, level: LevelFilter, query: string): boolean {
  if (RANK[entry.level] < FLOOR[level]) return false;
  const q = query.trim().toLowerCase();
  return q === '' || entry.message.toLowerCase().includes(q);
}

/** One log line as plain text, for the clipboard. */
export function lineText(entry: LogEntry): string {
  const meta = entry.meta === undefined ? '' : ` ${JSON.stringify(entry.meta)}`;
  return `${new Date(entry.at).toISOString()} ${entry.level.toUpperCase()} ${entry.message}${meta}`;
}
