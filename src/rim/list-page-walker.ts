/**
 * ListPageWalker — DIRECT paginated walk of a friendships list.
 *
 * The list dialog's own scroll pagination carries only ~12 users per fetch, so
 * a whole-list census (the prune scan) over thousands of accounts takes many
 * minutes of scrolling. This walker instead pages the SAME endpoint directly
 * from page context (`SURFACE.listPageScript` → FetchEnvelope) at the API's
 * full page size, cursor to cursor — one bounded, jittered loop:
 *
 *   fetch page → parse (versioned extractor) → observe → paced sleep → next,
 *   with a long jittered rest every few pages (anti-throttle breather).
 *
 * Robustness contract:
 *  - Sentinel re-checked at the TOP of every page.
 *  - An end-of-list claim is VERIFIED, never trusted: one more page is
 *    requested past the claimed end (via the leftover cursor, or the surface's
 *    synthesized offset probe when none was handed back). Nothing new — an
 *    empty page OR an outright rejection of the past-the-limit offset — is
 *    `endConfirmed`; new rows = the claim was false and the walk CONTINUES.
 *  - A non-ok envelope / evaluate throw gets ONE retried attempt (same cursor,
 *    long-rest backoff) before the walk ends `reason: 'fetch-failed'` — then
 *    callers fall back to the dialog-scroll scrape.
 *  - Stagnation tolerates a few duplicate-window pages (IG shifts windows on a
 *    live list) instead of aborting on the first one.
 *  - `complete` is true ONLY when the API itself reported no further pages, so
 *    a truncated walk can never masquerade as a full census.
 *  - Cooperative stop + the active driver's abort signal break the walk
 *    mid-sleep, exactly like the page reader's scroll loop.
 */

import {
  type ActivityReporter,
  NOOP_ACTIVITY_REPORTER,
} from '@/adapter/activity-reporter';
import { asFetchEnvelope, SURFACE } from '@/adapter/ig-surface';
import type { Reader } from '@/adapter/reader';
import type { Sentinel } from '@/adapter/sentinel';
import { type Clock, SystemClock } from '@/governors/clock';
import type { RimTab } from '@/rim/types';
import type { Observation } from '@/store/types';
import { RIM } from '@/timing/config';
import { sample, sleep, uniform } from '@/timing/primitives';
import * as logger from '@/utils/logger';

export interface ListPageWalkerDeps {
  tab: RimTab;
  reader: Reader;
  clock?: Clock;
  /** Live activity readout for the veil; defaults to a no-op. */
  reporter?: ActivityReporter;
  /** Injected pause; defaults to a real setTimeout (tests record the ms instead). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injectable randomness for the jittered pacing (deterministic tests). */
  rng?: () => number;
  /** Provider of the ACTIVE driver's abort signal (breaks sleeps mid-wait). */
  abortSignal?: () => AbortSignal | undefined;
}

export interface WalkArgs {
  /** Whose list to page (the prune scan passes our OWN pk). */
  pk: string;
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
  /** Per-page pacing bounds; defaults to `RIM.LIST_WALK_PAGE_{MIN,MAX}_MS`. */
  pageMinMs?: number;
  pageMaxMs?: number;
  /** Cooperative abort, checked at the top of every page. */
  shouldStop?: () => boolean;
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
  pks: string[];
  pages: number;
  /** True ONLY when the API reported no further pages — a genuine full walk. */
  complete: boolean;
  /** True when the past-the-end probe came back empty of new rows (complete walks only). */
  endConfirmed: boolean;
  reason: string;
  /**
   * Where a LATER walk should resume: the last parsed page's real `next_max_id`
   * (never the synthesized end-probe cursor), or `null` when the list finished —
   * persist this per target so successive walks pick up where this one stopped.
   */
  cursor: string | null;
}

export class ListPageWalker {
  private readonly tab: RimTab;
  private readonly reader: Reader;
  private readonly clock: Clock;
  private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly rng: () => number;
  private readonly abortSignal?: () => AbortSignal | undefined;
  private readonly reporter: ActivityReporter;

  constructor(deps: ListPageWalkerDeps) {
    this.tab = deps.tab;
    this.reader = deps.reader;
    this.clock = deps.clock ?? new SystemClock();
    this.sleepFn = deps.sleep ?? sleep;
    this.rng = deps.rng ?? Math.random;
    this.abortSignal = deps.abortSignal;
    this.reporter = deps.reporter ?? NOOP_ACTIVITY_REPORTER;
  }

  async walkAll(args: WalkArgs): Promise<WalkResult> {
    const { pk, which, onObservation, sentinel } = args;
    const maxPages = args.maxPages ?? RIM.LIST_WALK_MAX_PAGES;
    const externalStop = args.shouldStop ?? ((): boolean => false);
    const shouldStop = (): boolean =>
      externalStop() || this.abortSignal?.()?.aborted === true;
    const pacePolicy = uniform(
      args.pageMinMs ?? RIM.LIST_WALK_PAGE_MIN_MS,
      args.pageMaxMs ?? RIM.LIST_WALK_PAGE_MAX_MS,
    );
    const restPolicy = uniform(RIM.LIST_WALK_REST_MIN_MS, RIM.LIST_WALK_REST_MAX_MS);

    // Live veil readout: this walk hits the private JSON API directly (not the
    // page), so it reads as an 'api' phase, counting followers as they arrive.
    // `maxNewPks` (when the caller set one) is a REAL denominator — the number
    // of accounts this run is walking toward — so the overlay can draw a true
    // determinate bar; an unbounded census reports no total (indeterminate).
    const activityLabel = which === 'following' ? 'Reading following list' : 'Reading follower list';
    const reportActivity = (count: number): void =>
      this.reporter.report({
        kind: 'api',
        label: activityLabel,
        count,
        total: args.maxNewPks,
      });
    reportActivity(0);

    const observed = new Set<string>();
    /** Pks new to the CALLER (per `isKnown`), the real demand-budget metric. */
    let callerNewPks = 0;
    /** Consecutive pages contributing nothing caller-new (isKnown walks only). */
    let knownStagnantPages = 0;
    let cursor: string | null = args.startCursor ?? null;
    // The resume point handed back to the caller: always a REAL `next_max_id`
    // from a parsed page (or the untouched startCursor), never the synthesized
    // end-probe value `cursor` temporarily holds during verification.
    let resumeCursor: string | null = args.startCursor ?? null;
    let pages = 0;
    let complete = false;
    let endConfirmed = false;
    let reason = 'max-pages';
    // End-of-list claims are probed, not trusted: true while the CURRENT fetch
    // is the one-page-past-the-end verification request.
    let pendingEndClaim = false;
    // One transient fetch failure per cursor is retried (long-rest backoff);
    // the second consecutive failure ends the walk.
    let fetchFailures = 0;
    // Consecutive pages yielding no new pks (duplicate windows); bounded below.
    let stagnantPages = 0;
    // Diagnostics: total rows the API actually returned (duplicates included)
    // and the final page's pagination fields. `rows − observed` distinguishes
    // "overlapping pages" from "IG returned short pages" — a short-page walk
    // that still ends `no-more-pages` means the header count includes GHOSTS
    // (deactivated accounts kept in the count but never returned in the list).
    let rows = 0;
    let lastPage: { rows: number; hasMore: boolean; cursorPresent: boolean } | null = null;

    for (let page = 0; page < maxPages; page++) {
      if (shouldStop()) {
        reason = 'stop-requested';
        break;
      }
      const status = await sentinel.check();
      if (status !== 'ok') {
        reason = `sentinel:${status}`;
        logger.warn('rim.list-page-walker: sentinel non-ok, stopping walk', { pk, which, status });
        break;
      }
      let env: ReturnType<typeof asFetchEnvelope> = null;
      let failureDetail: Record<string, unknown> | null = null;
      try {
        env = asFetchEnvelope(
          await this.tab.evaluate<unknown>(SURFACE.listPageScript(pk, which, cursor)),
        );
        if (env === null || !env.ok) {
          failureDetail = {
            status: env?.status ?? null,
            textHead: env?.textHead?.slice(0, 80) ?? null,
          };
        }
      } catch (e) {
        failureDetail = { error: String(e) };
      }
      if (failureDetail !== null || env === null || !env.ok) {
        // A REJECTED past-the-end probe is a CONFIRMATION, not a failure: the
        // walk already consumed every page the API offered, and IG answers a
        // past-the-limit offset with an error (e.g. 400 "unable to fetch
        // followers"). Nothing exists beyond the end — never a fallback.
        if (pendingEndClaim) {
          complete = true;
          endConfirmed = true;
          reason = 'no-more-pages';
          logger.info('rim.list-page-walker: past-the-end probe rejected — end confirmed', {
            pk,
            which,
            pages,
            observed: observed.size,
            ...failureDetail,
          });
          break;
        }
        fetchFailures += 1;
        if (fetchFailures >= 2) {
          reason = 'fetch-failed';
          logger.warn('rim.list-page-walker: page fetch failed twice, stopping', {
            pk,
            which,
            pages,
            ...failureDetail,
          });
          break;
        }
        // One transient blip (throttle, network) is retried on the SAME cursor
        // after a long-rest backoff — a whole census must not fall over on it.
        logger.warn('rim.list-page-walker: page fetch failed, retrying once', {
          pk,
          which,
          pages,
          ...failureDetail,
        });
        await this.sleepFn(sample(restPolicy, this.rng), this.abortSignal?.());
        continue;
      }
      fetchFailures = 0;
      pages += 1;

      const now = this.clock.now();
      const parsed =
        which === 'following'
          ? this.reader.parseFollowingList(env.json, now)
          : this.reader.parseFollowersList(env.json, now);
      const sizeBefore = observed.size;
      const callerNewBefore = callerNewPks;
      for (const obs of parsed.observations) {
        if (!observed.has(obs.accountPk)) {
          // Newness to the CALLER must be judged BEFORE onObservation writes
          // the row's edge into the store, or every row would read as known.
          if (args.isKnown === undefined || !args.isKnown(obs.accountPk)) callerNewPks += 1;
        }
        observed.add(obs.accountPk);
        onObservation(obs, parsed.cursor);
      }
      if (observed.size > sizeBefore) {
        args.onProgress?.(observed.size);
        reportActivity(observed.size);
      }
      resumeCursor = parsed.cursor;
      rows += parsed.observations.length;
      lastPage = {
        rows: parsed.observations.length,
        hasMore: parsed.hasMore,
        cursorPresent: parsed.cursor !== null,
      };

      const newThisPage = observed.size - sizeBefore;

      // A pending end claim resolves on THIS page (the past-the-end probe):
      // nothing new past the claimed end = the end is verified; anything new
      // means the claim was FALSE and the walk carries on from here.
      if (pendingEndClaim) {
        if (newThisPage === 0) {
          complete = true;
          endConfirmed = true;
          reason = 'no-more-pages';
          logger.info('rim.list-page-walker: end-of-list verified (probe found nothing new)', {
            pk,
            which,
            pages,
            observed: observed.size,
          });
          break;
        }
        logger.warn('rim.list-page-walker: end-of-list claim was FALSE, continuing', {
          pk,
          which,
          pages,
          recovered: newThisPage,
        });
        pendingEndClaim = false;
      }

      // Demand-driven stop (growth acquisition): the caller has all the NEW
      // pks it needs — end here, resume cursor intact, without paging the rest
      // of a list this refill will never use. Newness is caller-level when an
      // `isKnown` predicate was supplied (rows already held don't count).
      const demandMet =
        args.maxNewPks !== undefined &&
        (args.isKnown === undefined ? observed.size : callerNewPks) >= args.maxNewPks;
      if (demandMet) {
        reason = 'target-reached';
        logger.info('rim.list-page-walker: pk target reached, stopping walk', {
          pk,
          which,
          pages,
          observed: observed.size,
          callerNewPks,
          maxNewPks: args.maxNewPks,
        });
        break;
      }

      // Known-density stop (isKnown walks only): consecutive pages of rows the
      // caller already holds mean we are re-reading a fully-walked stretch —
      // stop instead of paging a whole known list hunting for new rows.
      if (args.isKnown !== undefined && !pendingEndClaim) {
        if (callerNewPks === callerNewBefore) {
          knownStagnantPages += 1;
          if (knownStagnantPages >= RIM.LIST_WALK_STAGNANT_STOP) {
            reason = 'no-new-for-caller';
            logger.info('rim.list-page-walker: only already-known rows, stopping walk', {
              pk,
              which,
              pages,
              observed: observed.size,
            });
            break;
          }
        } else {
          knownStagnantPages = 0;
        }
      }

      if (!parsed.hasMore || parsed.cursor === null) {
        // The API claims the list is done. VERIFY before believing it: request
        // one page past the end — via the leftover cursor when one was handed
        // back, else the surface's synthesized offset probe.
        pendingEndClaim = true;
        stagnantPages = 0;
        cursor = parsed.cursor ?? SURFACE.listEndProbeCursor(rows);
        logger.info('rim.list-page-walker: end-of-list claimed, probing one page past it', {
          pk,
          which,
          pages,
          observed: observed.size,
        });
      } else {
        cursor = parsed.cursor;
        // Duplicate-window pages (IG shifts windows on a live list) are
        // tolerated a few in a row; a persistent circle still terminates.
        if (newThisPage === 0) {
          stagnantPages += 1;
          if (stagnantPages >= RIM.LIST_WALK_STAGNANT_STOP) {
            reason = 'stagnant';
            logger.warn('rim.list-page-walker: no new pks across consecutive pages, stopping', {
              pk,
              which,
              pages,
              stagnantPages,
            });
            break;
          }
        } else {
          stagnantPages = 0;
        }
      }

      await this.sleepFn(sample(pacePolicy, this.rng), this.abortSignal?.());
      if (pages % RIM.LIST_WALK_REST_EVERY === 0 && !shouldStop()) {
        const restMs = sample(restPolicy, this.rng);
        logger.info('rim.list-page-walker: long rest between page bursts', {
          pk,
          which,
          pages,
          restMs,
        });
        await this.sleepFn(restMs, this.abortSignal?.());
      }
    }

    // A finished list has no resume point — the next walk starts at the head.
    if (complete) resumeCursor = null;

    this.reporter.clear();

    logger.info('rim.list-page-walker: walk ended', {
      pk,
      which,
      observed: observed.size,
      rows,
      duplicates: rows - observed.size,
      pages,
      complete,
      endConfirmed,
      reason,
      cursor: resumeCursor,
      lastPage,
    });
    return { pks: [...observed], pages, complete, endConfirmed, reason, cursor: resumeCursor };
  }
}
