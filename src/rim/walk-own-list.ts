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
import type { FollowersPageReader } from '@/rim/followers-page-reader';
import type { ListPageWalker } from '@/rim/list-page-walker';
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
}

export async function walkOwnList(args: WalkOwnListArgs): Promise<PruneScanFetch> {
  const { which, label, sentinel, opts } = args;

  const status = await sentinel.check();
  if (status !== 'ok') {
    // An empty list read as COMPLETE is the dangerous direction: it would make
    // every account we follow an unfollow candidate (or every follower lost).
    logger.warn(`${label}: sentinel blocked, incomplete scrape`, { status });
    return { pks: [], complete: false, reason: `sentinel:${status}` };
  }

  if (args.walker !== undefined && args.ownPk !== undefined) {
    const walk = await args.walker.walkAll({
      pk: args.ownPk,
      which,
      onObservation: args.onRow,
      sentinel,
      pageMinMs: opts?.scrollMinMs,
      pageMaxMs: opts?.scrollMaxMs,
      shouldStop: opts?.shouldStop,
      onProgress: opts?.onProgress,
    });
    // The walk's own completeness verdict travels with the pks — a stagnant,
    // sentinel or max-pages truncation must never pass for a full census. Only
    // a failure to FETCH falls back; a shape mismatch would drift identically
    // through the dialog path.
    if (walk.reason !== 'fetch-failed') {
      return { pks: walk.pks, complete: walk.complete, reason: walk.reason,
        ...(walk.retryAt === undefined ? {} : { retryAt: walk.retryAt }) };
    }
    logger.warn(`${label}: direct page walk failed, falling back to dialog`, {
      pages: walk.pages,
      observed: walk.pks.length,
    });
  }

  const result = await args.pageReader.collect({
    dialog: which,
    targetUsername: args.ownUsername,
    onObservation: args.onRow,
    sentinel,
    maxRounds: args.bounds.maxRounds,
    noNewStop: args.bounds.noNewStop,
    shouldStop: opts?.shouldStop,
    scrollMinMs: opts?.scrollMinMs,
    scrollMaxMs: opts?.scrollMaxMs,
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
    reason: result.endReason,
    ...(result.retryAt === undefined ? {} : { retryAt: result.retryAt }),
  };
}
