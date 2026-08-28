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
