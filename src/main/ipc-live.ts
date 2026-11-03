/**
 * The live-data rows (spec §12.9, §15.1), spread into `src/main/ipc.ts`: the live tab, the feed, the log ring and
 * its stream switch, the log folder and the updater's state. Launch binds the process's live parts once (they
 * outlive every graph); unbound, as in suites that build no window, each row answers its typed fallback.
 */

import type { PushContract, PushMethod } from '@/ipc/contract';
import type { IpcFallbacks, IpcHandlers } from '@/ipc/register';
import { notBuiltFeed } from '@/main/modules/not-built';
import type { FeedView } from '@/shared/feed';
import type { LiveTab } from '@/shared/live-op';
import type { LogEntry } from '@/shared/log-entry';
import type { UpdateStatus } from '@/shared/update-status';
import * as logger from '@/utils/logger';

type LiveRow = 'activityNow' | 'feedView' | 'logTail' | 'setLogStream' | 'openLogFolder' | 'updateStatus';

/** The live tab while nothing reports to it: no phase, not busy, no hold. */
export const NO_ACTIVITY: LiveTab = { activity: null, busy: false, holds: [] };

/** The feed the renderer was last sent: the pull backstop answers it, so a pull never disagrees with the push. */
export class FeedMirror {
  private last: FeedView | null = null;

  /** Fed every push at launch's push seam; keeps the feed's. */
  note<C extends PushMethod>(channel: C, payload: PushContract[C]): void {
    if (channel === 'feed') this.last = payload as PushContract['feed'];
  }

  latest(): FeedView | null {
    return this.last;
  }
}

/** What the live rows answer from, bound once at launch. */
export interface LivePorts {
  readonly activity: { current(): LiveTab };
  readonly log: { tail(): LogEntry[]; setStreaming(on: boolean): void };
  readonly feed: Pick<FeedMirror, 'latest'>;
  /** Whether a graph is built now; until one is, the feed pull answers the not-built feed. */
  built(): Promise<boolean>;
  /** The logs folder and the desktop's opener (an empty string means it opened). */
  readonly logsDir: string;
  openPath(dir: string): Promise<string>;
}

let bound: LivePorts | null = null;

/** Bind the process's live parts to the rows; returns the unbind. */
export function bindLiveIpc(ports: LivePorts): () => void {
  bound = ports;
  return () => {
    if (bound === ports) bound = null;
  };
}

export function liveHandlers(
  currentUpdate: () => UpdateStatus,
  ports: () => LivePorts | null = () => bound,
): Pick<IpcHandlers, LiveRow> {
  return {
    activityNow: () => ports()?.activity.current() ?? NO_ACTIVITY,
    feedView: async () => {
      const p = ports();
      const latest = p !== null && (await p.built()) ? p.feed.latest() : null;
      return latest ?? notBuiltFeed(Date.now());
    },
    logTail: () => ports()?.log.tail() ?? [],
    setLogStream: (enabled) => {
      ports()?.log.setStreaming(enabled);
    },
    openLogFolder: async () => {
      const p = ports();
      if (p === null) return;
      const failure = await p.openPath(p.logsDir);
      if (failure !== '') logger.warn('log: the logs folder did not open', { dir: p.logsDir, failure });
    },
    updateStatus: () => currentUpdate(),
  };
}

export function liveFallbacks(currentUpdate: () => UpdateStatus): Pick<IpcFallbacks, LiveRow> {
  return {
    activityNow: () => NO_ACTIVITY,
    feedView: () => notBuiltFeed(Date.now()),
    logTail: () => [],
    setLogStream: () => undefined,
    openLogFolder: () => undefined,
    updateStatus: () => currentUpdate(),
  };
}
