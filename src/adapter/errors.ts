/**
 * Adapter error types.
 *
 * `AdapterStaleError` is thrown whenever an expected DOM contact point (a
 * selector or text-matched control from the active surface version module) is
 * absent. Instagram
 * rotates obfuscated class names and occasionally reshapes its DOM; when that
 * happens we want the failure to be LOUD and attributable — never a silently
 * swallowed no-op that lets the engine believe an action succeeded.
 */

import type { ClickVerdict } from '@/shared/click-verdict';

/**
 * Thrown when an admission gate held an action back before any press: the
 * record is untouched and the work runs later. `reason` is the typed refusal
 * when the gate named one (else the message); `until` is when it lifts, if known.
 */
export class ActionDeferredError extends Error {
  readonly reason: string;
  readonly until: number | null;

  constructor(message: string, opts: { reason?: string; until?: number | null } = {}) {
    super(message);
    this.name = 'ActionDeferredError';
    this.reason = opts.reason ?? message;
    this.until = opts.until ?? null;
  }
}

/**
 * Thrown when the click review CONSUMED the work with a verdict other than
 * `proceed` (spec §9.7). Not a deferral: the scheduler settles the record by
 * the verdict instead of retrying the same act.
 */
export class ActionReviewedError extends Error {
  constructor(readonly verdict: ClickVerdict) {
    super(`Action reviewed: ${verdict.kind}`);
    this.name = 'ActionReviewedError';
    Object.setPrototypeOf(this, ActionReviewedError.prototype);
  }
}

/**
 * Thrown when an Actor operation was interrupted by the ACTIVE driver's abort
 * signal (a user `stop()`/pause) rather than failing. Distinguishing this from
 * a timeout matters: a timeout is selector drift (loud `AdapterStaleError`, a
 * failed ledger row, a burned retry), while an abort is a normal control
 * command — the record must be left completely untouched so it retries when
 * the engine next runs.
 */
export class ActionAbortedError extends Error {
  /** The adapter operation that was interrupted, e.g. `actor.follow`. */
  readonly component: string;

  constructor(component: string) {
    super(`Adapter action aborted [${component}]: driver stop/pause interrupted the wait`);
    this.name = 'ActionAbortedError';
    this.component = component;
    Object.setPrototypeOf(this, ActionAbortedError.prototype);
  }
}

/**
 * Thrown when an Actor operation could not complete because Instagram put a
 * BLOCK/interstitial dialog on screen instead of the expected control ("Try
 * Again Later", "We restrict certain activity", …). Distinguishing this from
 * `AdapterStaleError` matters: drift is a code problem (loud stale, failed
 * ledger row), while a block is Instagram throttling the ACTION — the record/
 * candidate must be left untouched and the caller backs off (observed live
 * 2026-08-15: a prune run had every second unfollow's confirm menu replaced
 * by an interstitial, and each one burned a candidate as "failed").
 */
export class ActionBlockedError extends Error {
  /** The adapter operation that was blocked, e.g. `actor.unfollow`. */
  readonly component: string;
  /** The on-screen text that matched a block signature. */
  readonly matchedText: string;

  constructor(component: string, matchedText: string) {
    super(`Adapter action blocked [${component}]: Instagram interstitial: ${matchedText}`);
    this.name = 'ActionBlockedError';
    this.component = component;
    this.matchedText = matchedText;
    Object.setPrototypeOf(this, ActionBlockedError.prototype);
  }
}

/**
 * Thrown when Instagram's SERVER refused a follow/unfollow mutation as
 * throttling — the response said so (`feedback_required`, "Try Again Later",
 * the spam flag, HTTP 429): the "you're following too fast" case. On the web
 * client this shows NO page-level dialog; the header button merely snaps
 * back, which the DOM-only verification read as a phantom success (the
 * optimistic flip) or an anonymous failure. Distinct from `ActionBlockedError`
 * (an on-screen interstitial) because it is DEFINITIVE: the engine ladders
 * up on the first one instead of proving a streak against the wall.
 */
export class ActionRateLimitedError extends Error {
  /** The adapter operation that was refused, e.g. `actor.follow`. */
  readonly component: string;
  /** The mutation response's HTTP status. */
  readonly httpStatus: number;
  /** The server's own words (message + feedback text) for the log. */
  readonly detail: string;

  constructor(component: string, httpStatus: number, detail: string) {
    super(`Adapter action rate-limited [${component}]: HTTP ${httpStatus}: ${detail}`);
    this.name = 'ActionRateLimitedError';
    this.component = component;
    this.httpStatus = httpStatus;
    this.detail = detail;
    Object.setPrototypeOf(this, ActionRateLimitedError.prototype);
  }
}

/**
 * Thrown when a tab-facing await (navigation, in-page evaluate, CDP body read)
 * exceeded its deadline — the webContents is unresponsive or the call would
 * never settle. Typed DISTINCTLY from `AdapterStaleError` on purpose: a stall
 * is a tab/renderer-process condition, never selector drift, so it must never
 * be scored against the surface version's DOM knowledge.
 */
export class TabUnresponsiveError extends Error {
  /** The tab operation that stalled, e.g. `goto` / `evaluate` / `getBody`. */
  readonly component: string;
  /** The deadline that elapsed without a settlement, in ms. */
  readonly timeoutMs: number;
  /**
   * `'post-click'` when the stall happened AFTER an action click was dispatched
   * but BEFORE its post-state verification — the click may have LANDED on
   * Instagram even though it was never confirmed. Callers use this to mark the
   * record's next attempt as the arbiter (re-observe, never blindly re-claim).
   * Absent for stalls before any click was dispatched.
   */
  readonly phase?: 'post-click';

  constructor(component: string, timeoutMs: number, phase?: 'post-click') {
    super(`Tab unresponsive [${component}]: no settlement within ${timeoutMs}ms`);
    this.name = 'TabUnresponsiveError';
    this.component = component;
    this.timeoutMs = timeoutMs;
    this.phase = phase;
    Object.setPrototypeOf(this, TabUnresponsiveError.prototype);
  }
}

/**
 * Thrown when the tab's `webContents` is destroyed or was never initialized (a
 * teardown race, a hard navigation failure). Typed rather than string-matched:
 * every caller that must treat it as a TAB condition — record-neutral, never
 * selector drift — tests `instanceof`, so renaming the message cannot silently
 * reclassify it as a generic failure and burn a candidate.
 */
export class TabUnavailableError extends Error {
  /** The tab operation that found the webContents gone, e.g. `evaluate`. */
  readonly component: string;

  constructor(component: string) {
    super(`Tab unavailable [${component}]: webContents destroyed or not initialized`);
    this.name = 'TabUnavailableError';
    this.component = component;
    Object.setPrototypeOf(this, TabUnavailableError.prototype);
  }
}

export class AdapterStaleError extends Error {
  /** The adapter operation that failed, e.g. `actor.follow`. */
  readonly component: string;
  /** The selector / text-matcher that could not be located. */
  readonly selector: string;

  constructor(component: string, selector: string) {
    super(`Adapter stale [${component}]: expected element not found for selector: ${selector}`);
    this.name = 'AdapterStaleError';
    this.component = component;
    this.selector = selector;
    // Restore the prototype chain (required when targeting ES5/ES2022 classes
    // that extend built-ins so `instanceof` keeps working).
    Object.setPrototypeOf(this, AdapterStaleError.prototype);
  }
}
