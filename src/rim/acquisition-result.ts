/**
 * Why an acquire ended — split by TRUTH VALUE, not by scrape path.
 *
 * Genuine outcomes (the scrape ran and its result is trustworthy evidence
 * about the target's audience):
 *  - 'no-more-pages':     the walk VERIFIED the end of the target's list.
 *  - 'target-reached':    this refill's new-pk demand was met.
 *  - 'coverage-cap':      the audience coverage cap is already spent (no fetch).
 *  - 'no-new-for-caller': consecutive pages held only rows the store already has.
 *  - 'page-budget':       the per-acquire page/round budget was spent (the
 *                         resume cursor is persisted; the next refill continues).
 *  - 'stagnant':          the list stopped yielding new rows before a verified
 *                         end (the dialog's natural drain; duplicate windows on
 *                         the direct walk).
 *
 * Failures (the scrape could NOT trustworthily read the list — `observed: 0`
 * with one of these is NOT audience-exhaustion evidence and must never feed
 * the irreversible exhaustion cascade):
 *  - 'shape-mismatch':    the list page no longer parses (IG shape drift).
 *  - 'fetch-failed':      repeated fetch failures (throttle/network/walls).
 *  - 'sentinel-blocked':  the account was blocked before or during the scrape.
 *  - 'stopped':           a cooperative stop ended the walk mid-list.
 *  - 'dialog-failed':     the dialog fallback could not open/read the list.
 */
export type AcquireEndReason =
  | 'no-more-pages'
  | 'target-reached'
  | 'coverage-cap'
  | 'no-new-for-caller'
  | 'page-budget'
  | 'stagnant'
  | 'shape-mismatch'
  | 'fetch-failed'
  | 'sentinel-blocked'
  | 'stopped'
  | 'dialog-failed'
  | 'read-budget';

/** The failure half of {@link AcquireEndReason} (see the taxonomy above). */
export const ACQUIRE_FAILURE_REASONS: ReadonlySet<AcquireEndReason> = new Set([
  'shape-mismatch',
  'fetch-failed',
  'sentinel-blocked',
  'stopped',
  'dialog-failed',
]);

/** Whether an acquire's end reason means the read FAILED (vs a genuine outcome). */
export function isAcquireFailure(reason: AcquireEndReason): boolean {
  return ACQUIRE_FAILURE_REASONS.has(reason);
}

/**
 * What one acquire yields. Additive over the `FollowerAcquisition` port's
 * `{observed, targetPk}` shape (which this satisfies structurally): the
 * `endReason` says WHY the acquire ended, so callers can tell a genuine
 * completion from a failed read instead of treating every `observed: 0` as
 * exhaustion. Existing port-typed callers are unaffected.
 */
export interface AcquireResult {
  observed: number;
  targetPk: string | null;
  endReason: AcquireEndReason;
  globallyNew?: number;
  retryAt?: number;
}

/** Map a {@link ListPageWalker} end reason into the acquire taxonomy. */
export function reasonFromWalk(reason: string): AcquireEndReason {
  switch (reason) {
    case 'read-budget':
      return 'read-budget';
    case 'no-more-pages':
      return 'no-more-pages';
    case 'target-reached':
      return 'target-reached';
    case 'no-new-for-caller':
      return 'no-new-for-caller';
    case 'max-pages':
      return 'page-budget';
    case 'stagnant':
      return 'stagnant';
    case 'shape-mismatch':
      return 'shape-mismatch';
    case 'stop-requested':
      return 'stopped';
    case 'fetch-failed':
      return 'fetch-failed';
    default:
      // 'sentinel:*' and anything a future walker adds: never let an unmapped
      // reason read as a genuine outcome — default to the failure family.
      return reason.startsWith('sentinel:') ? 'sentinel-blocked' : 'fetch-failed';
  }
}

/** Map a dialog-scrape (`FollowersPageReader.collect`) end reason likewise. */
export function reasonFromDialog(endReason: string): AcquireEndReason {
  switch (endReason) {
    case 'read-budget':
      return 'read-budget';
    case 'no-more-pages':
      return 'no-more-pages';
    case 'stagnant':
      return 'stagnant';
    case 'max-rounds':
      return 'page-budget';
    case 'stop-requested':
      return 'stopped';
    case 'shape-mismatch':
      return 'shape-mismatch';
    case 'blocked-response':
      return 'fetch-failed';
    case 'open-failed':
      return 'dialog-failed';
    default:
      return endReason.startsWith('sentinel:') ? 'sentinel-blocked' : 'dialog-failed';
  }
}

