import type { Sentinel } from '@/adapter/sentinel';
import type { ReadPurpose } from '@/governors/read-budget';
import type { ReadUse } from '@/kernel/plan/types';
import type { StopDetail } from '@/rim/list-walk-end';
import type { Observation } from '@/store/types';

export interface WalkArgs {
  readPurpose?: ReadPurpose;
  /** Whose list to page (the prune scan passes our OWN pk). */
  pk: string;
  /** Whose list, for the live readout ("Reading @x's followers"); absent or null reads as your own. */
  ofUsername?: string | null;
  which: 'followers' | 'following';
  /**
   * Called for every parsed user, with the page's resume cursor.
   *
   * CONTRACT (docs/PRINCIPLES.md §1 — facts stream): implementations MUST
   * write each observation through to the store as it arrives — a walk that
   * stops early (sentinel, stagnation, user stop) keeps every row it saw. The
   * returned pk list carries completeness verdicts, not the facts themselves.
   */
  onObservation: (obs: Observation, cursor: string | null) => void;
  /** Cumulative observed-pk count, reported once per page that grew the set. */
  onProgress?: (observedCount: number) => void;
  sentinel: Sentinel;
  /** Per-page pacing bounds (both, or neither: the `walk.page` tempo). */
  pageMinMs?: number;
  pageMaxMs?: number;
  /** Cooperative abort, checked at the top of every page. */
  shouldStop?: () => boolean;
  /** True ends the walk (reason `caller-stop`) once this page's rows are written, before any pacing sleep. */
  stopAfterPage?: (page: readonly Observation[]) => boolean;
  /** What the walk's page reads are for: the `use` tag on each read debit. */
  readUse?: ReadUse;
  /**
   * `acquisition`: the walk pages a SOURCE's followers for the candidate pool, so a page whose rows moved
   * may be read from their new place (C2) — its continuation never is, so the walk stops after it. Own-list
   * walks (census, followers head, following check) never pass it: they read C0/C1 only.
   */
  arm?: 'acquisition';
  /** Runaway page bound; defaults to `RIM.LIST_WALK_MAX_PAGES`. */
  maxPages?: number;
  /**
   * Resume cursor from a PREVIOUS walk of this list (the persisted
   * `next_max_id`): the walk starts paging there instead of at the head, so
   * successive bounded walks never re-fetch pages already consumed. `null`/
   * absent starts at the head (a fresh walk).
   */
  startCursor?: string | null;
  /**
   * Demand-driven stop: end the walk (reason `target-reached`) once this many
   * NEW pks have been observed. Growth acquisition fetches only the pages
   * a refill actually needs instead of a whole-list census. Absent = unbounded
   * (the census walks: prune scan, own-followers).
   */
  maxNewPks?: number;
  /**
   * Caller-level newness for the demand budget: rows the CALLER already holds
   * (e.g. an edge in the store from a prior walk) do not count toward
   * `maxNewPks` — without this, overlapping windows spent the whole coverage
   * budget re-counting rows already held. Checked BEFORE `onObservation` runs
   * for the row. Also enables the known-density early stop: several
   * consecutive pages of only-already-known rows end the walk (reason
   * `no-new-for-caller`) instead of paging a fully-walked list to its end.
   */
  isKnown?: (pk: string) => boolean;
}

export interface WalkResult {
  retryAt?: number;
  pks: string[];
  pages: number;
  /** True ONLY when the end was verified (a probe) or the server's own flags ended an opaque walk. */
  complete: boolean;
  /** True when the past-the-end probe came back empty of new rows, or was rejected past the limit. */
  endConfirmed: boolean;
  /** What proved the end of a complete walk. */
  endEvidence?: 'probe' | 'probe-rejected' | 'server-flags';
  /** Why a `shape-mismatch` walk stopped (spec §10.4). */
  stopDetail?: StopDetail;
  /**
   * Rows on the walked pages that did not read. A complete walk with quarantined rows still
   * misses accounts, so every absence verdict refuses it (spec §10.4).
   */
  quarantined: number;
  /** Rows an acquisition walk read from a page whose rows moved (C2: the candidate pool only). */
  recoveredRows?: number;
  /**
   * Why the walk ended. Genuine completion: 'no-more-pages'. Demand stops:
   * 'target-reached' | 'no-new-for-caller'. Bounds: 'max-pages' | 'stagnant'.
   * Failures (`complete` always false): 'shape-mismatch' (the page no longer
   * parses — IG shape drift), 'fetch-failed', 'stop-requested', 'sentinel:*'.
   */
  reason: string;
  /**
   * Where a LATER walk should resume: the last parsed page's real `next_max_id`
   * (never the synthesized end-probe cursor), or `null` when the list finished —
   * persist this per target so successive walks pick up where this one stopped.
   */
  cursor: string | null;
}

