/**
 * The tab-driving layers announce WHAT they are doing as a typed `LiveOp`: `report()` when a phase
 * begins, `clear()` when it ends (default {@link NOOP_ACTIVITY_REPORTER}); the composition root
 * forwards to the veil. A `total` is a real denominator only when known; unknown stays null.
 */

import type { ActivityInfo } from '@/shared/live-op';

export type { ActivityInfo, ActivityKind } from '@/shared/live-op';

export interface ActivityReporter {
  /** Announce the current phase of tab work (replaces any prior phase). */
  report(info: ActivityInfo): void;
  /** The current phase ended; the veil returns to its idle "active" chip. */
  clear(): void;
}

/** The default: report nothing. Keeps every call site free of null checks. */
export const NOOP_ACTIVITY_REPORTER: ActivityReporter = {
  report: () => {},
  clear: () => {},
};
