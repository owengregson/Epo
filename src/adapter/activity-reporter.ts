/**
 * ActivityReporter — the seam that lets the tab-driving layers announce WHAT
 * they are doing right now, as a typed `LiveOp` (`src/shared/live-op.ts`), so
 * the veil and the sidebar can show it live.
 *
 * It is deliberately tiny and side-effect-free at the call site: the rim/adapter
 * classes take an optional reporter (defaulting to {@link NOOP_ACTIVITY_REPORTER})
 * and call `report(...)` when a phase of work begins and `clear()` when it ends.
 * The concrete reporter (wired in the composition root) forwards to the veil.
 * A `done`/`total` pair is a real denominator only when genuinely known: an
 * unknown total stays null (an indeterminate sweep), never invented.
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
