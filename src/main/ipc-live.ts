/**
 * The live-data rows' handlers and typed fallbacks (spec §12.9), spread into
 * `src/main/ipc.ts`. Until the live-data stream lands, the live tab reports no
 * phase and no hold, the feed is the not-built one, the log ring is empty and its
 * switches do nothing; the updater pull serves the updater's current state as today.
 */

import type { IpcFallbacks, IpcHandlers } from '@/ipc/register';
import { notBuiltFeed } from '@/main/modules/not-built';
import type { LiveTab } from '@/shared/live-op';
import type { UpdateStatus } from '@/shared/update-status';

type LiveRow = 'activityNow' | 'feedView' | 'logTail' | 'setLogStream' | 'openLogFolder' | 'updateStatus';

/** The live tab while nothing reports to it: no phase, not busy, no hold. */
export const NO_ACTIVITY: LiveTab = { activity: null, busy: false, holds: [] };

export function liveHandlers(currentUpdate: () => UpdateStatus): Pick<IpcHandlers, LiveRow> {
  return {
    activityNow: () => NO_ACTIVITY,
    feedView: () => notBuiltFeed(Date.now()),
    logTail: () => [],
    setLogStream: () => undefined,
    openLogFolder: () => undefined,
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
