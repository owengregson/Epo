/**
 * ActivityReporter — the seam that lets the tab-driving layers announce, in
 * plain terms, WHAT they are doing right now, so the overlay veil can show it
 * live (e.g. "Reading follower list" over the private JSON API vs "Scrolling
 * follower list" by driving the page).
 *
 * It is deliberately tiny and side-effect-free at the call site: the rim/adapter
 * classes take an optional reporter (defaulting to {@link NOOP_ACTIVITY_REPORTER})
 * and call `report(...)` when a phase of work begins and `clear()` when it ends.
 * The concrete reporter (wired in the composition root) forwards to the veil.
 */

/** Whether the current work talks to the private JSON API or drives the DOM. */
export type ActivityKind = 'api' | 'page';

export interface ActivityInfo {
  kind: ActivityKind;
  /** Short present-tense label, e.g. "Reading follower list", "Following @jane". */
  label: string;
  /** Optional cumulative count for a running phase (e.g. followers read so far). */
  count?: number;
  /**
   * The count this phase is working TOWARD, when it is genuinely known (the
   * walk's new-pk demand, an enrichment batch size). Present → the overlay
   * draws a real determinate progress bar; absent → an indeterminate sweep,
   * because inventing a denominator would misreport progress.
   */
  total?: number;
  /** Optional secondary line, e.g. the target the phase is working on. */
  detail?: string;
}

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
