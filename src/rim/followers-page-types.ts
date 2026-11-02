import type { Sentinel } from '@/adapter/sentinel';
import type { ReadPurpose } from '@/governors/read-budget';
import type { Observation } from '@/store/types';

/** One scrape run's parameters. */
export interface CollectArgs {
  readPurpose?: ReadPurpose;
  targetUsername: string;
  /**
   * Which profile-stat dialog to open and which paginated endpoint to parse:
   * the target's FOLLOWERS (default) or its FOLLOWING list. Both dialogs share
   * the same modal, scroll container, and page body shape — only the stat
   * clicked and the endpoint URL differ (Phase 5 auto-prune reads `following`).
   */
  dialog?: 'followers' | 'following';
  /**
   * Called for every parsed user (followers-list) and for the target's profile
   * (profile-info enrichment). The caller decides store writes / edges; the
   * cursor of the page the observation came from is passed for convenience
   * (`null` for profile-info).
   *
   * CONTRACT (docs/PRINCIPLES.md §1 — facts stream): implementations MUST
   * write each observation through to the store as it arrives, never collect
   * it for an end-of-walk flush — a truncated/aborted collect must keep every
   * row it saw. The returned `observedPks` array exists for completeness
   * verdicts and counts, not as the carrier of facts.
   */
  onObservation: (obs: Observation, cursor: string | null) => void;
  /**
   * Invoked ONCE with the target's pk the moment it is derived from a list
   * page's URL — which happens BEFORE that page's rows are parsed. Lets a
   * caller write per-row relationship edges as rows arrive (§1) instead of
   * back-filling them once the scrape ends.
   */
  onTargetPk?: (pk: string) => void;
  /**
   * Live-progress callback (optional, additive): invoked with the CUMULATIVE
   * observed-pk count whenever a parsed page GROWS the observed set (per page,
   * not per user — a page is the natural batch). Lets callers surface counts
   * mid-scrape instead of only when `collect` resolves.
   */
  onProgress?: (observedCount: number) => void;
  sentinel: Sentinel;
  /** Hard cap on scroll rounds so a scrape is always bounded. */
  maxRounds: number;
  /** Stop after this many consecutive rounds that yield no new pks. */
  noNewStop: number;
  /**
   * Jittered pacing for the prune SCAN (Phase 5): when BOTH bounds are set, every
   * wait — the initial post-open wait and each inter-round wait — is a FRESH
   * uniform draw in `[scrollMinMs, scrollMaxMs]` ms (clamped so max ≥ min), so no
   * two scroll rounds fire on a fixed cadence. When either is unset the fixed
   * `scrollWaitMs` applies (the growth scrape path, unchanged).
   */
  scrollMinMs?: number;
  scrollMaxMs?: number;
  /**
   * Cooperative abort: checked before the initial post-open wait and at the TOP
   * of each scroll round; a `true` breaks the loop. Pages already captured are
   * still drained and returned (a stop never loses parsed data).
   */
  shouldStop?: () => boolean;
  /**
   * When true, a dialog that fails to OPEN rethrows (after teardown) instead of
   * resolving with an empty result. The prune scan sets this: an unopened list
   * must read as "scan failed", never as "the list is empty" — an empty
   * followers read would otherwise mark every followed account a candidate.
   * Growth callers keep the default (false): a target whose dialog won't open
   * degrades to a no-yield scrape and the chain moves on.
   */
  throwOnOpenFailure?: boolean;
}

/** What a scrape yields back to its caller. */
export interface CollectResult {
  retryAt?: number;
  observedPks: string[];
  targetPk: string | null;
  cursor: string | null;
  /**
   * Why the scroll loop ended ('no-more-pages', 'stagnant', 'max-rounds',
   * 'stop-requested', 'sentinel:*', 'blocked-response', 'shape-mismatch',
   * 'open-failed'). 'shape-mismatch' means a captured list page no longer
   * parses (IG shape drift) — it overrides the natural end reasons so a
   * drifted page can never read as a drained list. Callers that need a FULL
   * census (prune) must treat anything but a natural drain as an incomplete
   * list, never as "this is everything".
   */
  endReason: string;
}

