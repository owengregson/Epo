/**
 * `walkOwnList` — one whole-list census of OUR OWN followers or following.
 *
 * The two prune-scan sources differ only in WHICH list they walk and what each
 * row means to the store; the walk itself — sentinel gate, direct API walk,
 * dialog-scroll fallback, completeness verdict — is one procedure and lives
 * here so a change to the fallback rule cannot land in one source and not the
 * other.
 *
 * Completeness is the whole point of this path. The prune scan turns absence
 * into a verdict ("this follower is gone", "unfollow this account"), so an
 * incomplete read must NEVER be reported as a finished one: a blocked sentinel
 * yields `complete: false` rather than an empty list, an unopened dialog fails
 * the scan rather than reading as "you have no followers", and only the API's
 * own `no-more-pages` proves a dialog scrape drained the list.
 */

import type { Sentinel } from '@/adapter/sentinel';
import type { PruneScanFetch, PruneScanOpts } from '@/engine/prune-engine';
import { measuredRowsPerPage } from '@/kernel/derive-reentry';
import type { FollowersPageReader } from '@/rim/followers-page-reader';
import type { ListPageWalker } from '@/rim/list-page-walker';
import type { WalkResult } from '@/rim/list-walk-types';
import type { Observation } from '@/store/types';
import * as logger from '@/utils/logger';

export interface WalkOwnListArgs {
  /** Which of our own lists to walk. */
  which: 'followers' | 'following';
  /** Log prefix identifying the calling source. */
  label: string;
  /** Our own username — the dialog fallback navigates to our profile. */
  ownUsername: string;
  sentinel: Sentinel;
  pageReader: FollowersPageReader;
  /**
   * The FAST path. With a walker AND our pk, the list is paged straight off
   * the friendships API at full page size (~4× the dialog's scroll batches);
   * the dialog scrape runs only when the direct walk cannot fetch at all.
   */
  walker?: ListPageWalker;
  ownPk?: string;
  /** Runaway bounds for the dialog fallback's scroll loop. */
  bounds: { maxRounds: number; noNewStop: number };
  /** Called per parsed row, at observation time (docs/PRINCIPLES.md §1). */
  onRow: (obs: Observation) => void;
  /** The engine's scan opts: cooperative stop, jittered pacing, live progress. */
  opts?: PruneScanOpts;
  /**
   * A header-relative census (spec §5.8): the pages the list needs and the longest walk the host
   * session can finish. A list needing more is refused before any page ('too-large').
   */
  census?: { readonly pages: number; readonly walkMax: number };
}

/** The census result plus what the walk measured: its rows and pages (the page size), and how its end was proved. */
export interface OwnListFetch extends PruneScanFetch {
  readonly rows?: number;
  readonly pages?: number;
  readonly endEvidence?: WalkResult['endEvidence'];
  readonly stopDetail?: WalkResult['stopDetail'];
}

export async function walkOwnList(args: WalkOwnListArgs): Promise<OwnListFetch> {
  const { which, label, sentinel, opts } = args;

  const status = await sentinel.check();
  if (status !== 'ok') {
    // An empty list read as COMPLETE is the dangerous direction: it would make
    // every account we follow an unfollow candidate (or every follower lost).
    logger.warn(`${label}: sentinel blocked, incomplete scrape`, { status });
    return { pks: [], complete: false, reason: `sentinel:${status}` };
  }

  if (args.census !== undefined && args.census.pages > args.census.walkMax) {
    logger.info(`${label}: the list is too long for one walk, census refused`, { ...args.census });
    return { pks: [], complete: false, reason: 'too-large' };
  }

  if (args.walker !== undefined && args.ownPk !== undefined) {
    const pageSizes: number[] = [];
    const walk = await args.walker.walkAll({
      pk: args.ownPk,
      which,
      onObservation: args.onRow,
      stopAfterPage: (page) => { pageSizes.push(page.length); return false; },
      sentinel,
      shouldStop: opts?.shouldStop,
      onProgress: opts?.onProgress,
      readUse: 'census',
      ...(args.census === undefined ? {} : { maxPages: args.census.pages }),
    });
    // The walk's own completeness verdict travels with the pks — a stagnant,
    // sentinel or max-pages truncation must never pass for a full census — and so
    // do its quarantined rows, which make every absence verdict refuse it (spec §10.4).
    // Only a failure to FETCH falls back; a shape mismatch would drift identically
    // through the dialog path.
    if (walk.reason !== 'fetch-failed') {
      // The last page may be short or a plain end probe; only earlier pages measure a full page.
      const full = pageSizes.slice(0, -1);
      return { rowsPerPage: measuredRowsPerPage({ rows: full.reduce((sum, size) => sum + size, 0), fullPages: full.length }, null),
        pks: walk.pks, complete: walk.complete, reason: walk.reason, quarantined: walk.quarantined,
        rows: walk.pks.length, pages: walk.pages,
        ...(walk.endEvidence === undefined ? {} : { endEvidence: walk.endEvidence }),
        ...(walk.stopDetail === undefined ? {} : { stopDetail: walk.stopDetail }),
        ...(walk.retryAt === undefined ? {} : { retryAt: walk.retryAt }) };
    }
    logger.warn(`${label}: direct page walk failed, falling back to dialog`, {
      pages: walk.pages,
      observed: walk.pks.length,
    });
  }

  const result = await args.pageReader.collect({
    dialog: which, readUse: 'census',
    targetUsername: args.ownUsername,
    onObservation: args.onRow,
    sentinel,
    maxRounds: Math.min(args.bounds.maxRounds, args.census === undefined ? args.bounds.maxRounds : Math.max(0, args.census.pages - 1)),
    noNewStop: args.bounds.noNewStop,
    shouldStop: opts?.shouldStop,
    onProgress: opts?.onProgress,
    // An unopened dialog must FAIL the scan, never read as an empty list.
    throwOnOpenFailure: true,
  });
  // A dialog scrape can only PROVE completion when the API itself said
  // no-more-pages; a stagnation stop is ambiguous (small list vs. throttle)
  // and the prune engine's completeness gate refuses it.
  return {
    pks: result.observedPks,
    complete: result.endReason === 'no-more-pages',
    reason: result.endReason, pages: result.pages, rowsPerPage: result.rowsPerPage,
    ...(result.retryAt === undefined ? {} : { retryAt: result.retryAt }),
  };
}
