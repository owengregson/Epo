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
 *    synthesized offset probe when none was handed back). Only two answers
 *    confirm the end: a well-formed page with nothing new, or the SPECIFIC
 *    past-the-limit rejection (HTTP 400 that is not a recognized throttle/
 *    auth wall). Any other rejection — 429, 5xx, network, a wall — is a fetch
 *    failure: "we got throttled" must never read as "the list is complete".
 *    New rows = the claim was false and the walk CONTINUES.
 *  - A page that fetches but no longer PARSES (SHAPE_MISMATCH from the
 *    versioned extractor) ends the walk `reason: 'shape-mismatch'`,
 *    `complete: false` — a drifted page must never originate or confirm an
 *    end-of-list claim (an "empty" read here would fabricate a census).
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

import { type ActivityReporter, NOOP_ACTIVITY_REPORTER } from '@/adapter/activity-reporter';
import { fetchJson } from '@/adapter/fetch-json';
import { SURFACE } from '@/adapter/ig-surface';
import type { Reader } from '@/adapter/reader';
import { type Clock, SystemClock } from '@/governors/clock';
import type { ReadBudget } from '@/governors/read-budget';
import { type TempoSource, tempoOrReference } from '@/kernel/tempo';
import { decideStep } from '@/rim/list-walk-end';
import type { RimTab } from '@/rim/types';
import { RIM } from '@/timing/config';
import { sample, sleep, uniform } from '@/timing/primitives';
import * as logger from '@/utils/logger';

export interface ListPageWalkerDeps {
  onProgress?: (phase: string) => void;
  readBudget?: ReadBudget;
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
  /** The tempo every page wait, rest and rest stride resolves from (default: the reference tempo). */
  tempo?: TempoSource;
}

export type { WalkArgs, WalkResult } from './list-walk-types';

import type { WalkArgs, WalkResult } from './list-walk-types';

export class ListPageWalker {
  private readonly onProgress?: (phase: string) => void;
  private readonly readBudget?: ReadBudget;
  private readonly tab: RimTab;
  private readonly reader: Reader;
  private readonly clock: Clock;
  private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly rng: () => number;
  private readonly abortSignal?: () => AbortSignal | undefined;
  private readonly reporter: ActivityReporter;
  private readonly tempo: TempoSource;

  constructor(deps: ListPageWalkerDeps) {
    this.onProgress = deps.onProgress;
    this.readBudget = deps.readBudget;
    this.tab = deps.tab;
    this.reader = deps.reader;
    this.clock = deps.clock ?? new SystemClock();
    this.sleepFn = deps.sleep ?? sleep;
    this.rng = deps.rng ?? Math.random;
    this.abortSignal = deps.abortSignal;
    this.reporter = deps.reporter ?? NOOP_ACTIVITY_REPORTER;
    this.tempo = tempoOrReference(deps.tempo);
  }

  async walkAll(args: WalkArgs): Promise<WalkResult> {
    const { pk, which, onObservation, sentinel } = args;
    const maxPages = args.maxPages ?? RIM.LIST_WALK_MAX_PAGES;
    const externalStop = args.shouldStop ?? ((): boolean => false);
    const shouldStop = (): boolean =>
      externalStop() || this.abortSignal?.()?.aborted === true;
    const pacePolicy = args.pageMinMs === undefined || args.pageMaxMs === undefined
      ? this.tempo.policy('walk.page') : uniform(args.pageMinMs, args.pageMaxMs);
    const restPolicy = this.tempo.policy('walk.rest');
    // The long-rest STRIDE is drawn, not fixed (timing-noise layer): the next
    // breather lands after a fresh 5–10 pages, redrawn after each rest, so the
    // walk never rests on an exact every-Nth-page metronome.
    let nextRestAtPage = sample(this.tempo.policy('walk.rest-every'), this.rng);

    // Live veil readout: this walk hits the private JSON API directly (not the
    // page), so it reads as an 'api' phase, counting followers as they arrive.
    // `maxNewPks` (when the caller set one) is a REAL denominator — the number
    // of accounts this run is walking toward — so the overlay can draw a true
    // determinate bar; an unbounded census reports no total (indeterminate).
    const reportActivity = (count: number): void =>
      this.reporter.report({
        kind: 'api',
        op: { op: 'read-list', list: which, of: null, done: count, total: args.maxNewPks ?? null },
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
    let retryAt: number | undefined;

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
      const permit = this.readBudget?.consume('list-page', args.readPurpose ?? 'reconciliation', 1, args.readUse);
      if (permit !== undefined && !permit.allowed) {
        reason = 'read-budget';
        retryAt = permit.resumeAt ?? undefined;
        break;
      }
      const res = await fetchJson(this.tab, SURFACE.listPageScript(pk, which, cursor, pendingEndClaim));
      if (!res.ok) {
        const failureDetail = res.detail;
        // A rejected past-the-end probe confirms the end ONLY when the
        // rejection is the SPECIFIC past-the-limit refusal: IG answers a
        // past-the-limit offset with a 400 (e.g. "unable to fetch followers").
        // The failure families that mean the FETCH broke, not the list ended —
        // a 429/5xx or wall (`rate-limited`), a login/challenge redirect
        // (`auth`), a network error, an evaluate throw — are screened out.
        // Treating those as confirmation would launder a throttle into a
        // verified-complete walk and feed absence-based verdicts (lost
        // followers, exhaustion) a fabricated end.
        const pastTheLimitRejection =
          res.status === 400 &&
          res.kind !== 'rate-limited' &&
          res.kind !== 'auth' &&
          res.kind !== 'network';
        if (pendingEndClaim && pastTheLimitRejection) {
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
          ? this.reader.parseFollowingListStrict(res.json, now)
          : this.reader.parseFollowersListStrict(res.json, now);
      if (parsed === null) {
        // SHAPE DRIFT: the page fetched fine but the versioned extractor no
        // longer recognizes it. The typed empty page is the END-OF-LIST shape,
        // so parsing leniently here would let a drifted page originate or
        // confirm an end-of-list claim — instead the walk ends INCOMPLETE
        // with an honest reason (`complete`/`endConfirmed` stay false, and a
        // pending end claim dies unverified with it). Callers surface this as
        // a failed walk, never a finished empty list.
        reason = 'shape-mismatch';
        logger.warn('rim.list-page-walker: page shape unrecognized, stopping walk', {
          pk,
          which,
          pages,
          observed: observed.size,
        });
        break;
      }
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
      this.onProgress?.('list-page-ingested');
      rows += parsed.observations.length;
      lastPage = { rows: parsed.observations.length, hasMore: parsed.hasMore, cursorPresent: parsed.cursor !== null };
      // The caller's stop, once this page's rows are written and before any pacing sleep.
      if (args.stopAfterPage?.(parsed.observations) === true) { reason = 'caller-stop'; break; }

      const newThisPage = observed.size - sizeBefore;
      // The end-claim decision is pure (`list-walk-end.ts`); it is applied in
      // two halves around the demand and known-density stops, as before.
      const step = decideStep(
        { hasMore: parsed.hasMore, cursor: parsed.cursor, newRows: newThisPage },
        { probing: pendingEndClaim, stagnantPages },
        rows,
        (n) => SURFACE.listEndProbeCursor(n),
        RIM.LIST_WALK_STAGNANT_STOP,
      );
      if (step.act === 'complete') {
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
      if (step.claimWasFalse) {
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

      cursor = step.cursor;
      stagnantPages = step.stagnantPages;
      if (step.act === 'probe') {
        pendingEndClaim = true;
        logger.info('rim.list-page-walker: end-of-list claimed, probing one page past it', {
          pk,
          which,
          pages,
          observed: observed.size,
        });
      } else if (step.act === 'stop') {
        reason = 'stagnant';
        logger.warn('rim.list-page-walker: no new pks across consecutive pages, stopping', {
          pk,
          which,
          pages,
          stagnantPages,
        });
        break;
      }

      await this.sleepFn(sample(pacePolicy, this.rng), this.abortSignal?.());
      if (pages >= nextRestAtPage && !shouldStop()) {
        const restMs = sample(restPolicy, this.rng);
        logger.info('rim.list-page-walker: long rest between page bursts', {
          pk,
          which,
          pages,
          restMs,
        });
        await this.sleepFn(restMs, this.abortSignal?.());
        nextRestAtPage = pages + sample(this.tempo.policy('walk.rest-every'), this.rng);
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
    return { pks: [...observed], pages, complete, endConfirmed, reason, cursor: resumeCursor,
      ...(retryAt === undefined ? {} : { retryAt }) };
  }
}
