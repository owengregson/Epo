/**
 * The live-data invoke rows (spec §12.9, §15.1): the feed pull, the log ring and
 * its stream switch, the log folder and the updater's state pull. Channel strings
 * written here once and spread into `CHANNELS`. Type-only imports plus one literal.
 */

// biome-ignore-all lint/suspicious/noConfusingVoidType: `res: void` is the
// acknowledgement-only result of a fire-and-forget channel.

import type { FeedView } from '@/shared/feed';
import type { LogEntry } from '@/shared/log-entry';
import type { UpdateStatus } from '@/shared/update-status';

export const LIVE_CHANNELS = {
  feedView: 'feed:get',
  logTail: 'log:tail',
  setLogStream: 'log:stream',
  openLogFolder: 'log:open-folder',
  updateStatus: 'update:status',
} as const;

export interface LiveIpcContract {
  /** The feed projection (also pushed on store mutation). */
  feedView: { req: []; res: FeedView };
  /** The in-process log ring, oldest first. */
  logTail: { req: []; res: LogEntry[] };
  /** Stream log lines while a Diagnostics panel is mounted. */
  setLogStream: { req: [enabled: boolean]; res: void };
  /** Open the logs folder in the system file browser. */
  openLogFolder: { req: []; res: void };
  /** The updater's current state (pulled at mount; pushes follow). */
  updateStatus: { req: []; res: UpdateStatus };
}
