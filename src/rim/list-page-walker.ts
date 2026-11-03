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
 * Robustness contract (the decision table is `list-walk-end.ts`, spec §10.4):
 *  - Sentinel re-checked at the TOP of every page.
 *  - An end-of-list claim is VERIFIED, never trusted. In an offset cursor space
 *    one more page is requested past the claimed end; only a well-formed page
 *    with nothing new, or the SPECIFIC past-the-limit rejection (an HTTP 400
 *    that is no throttle/auth wall), confirms it. In an OPAQUE space an offset
 *    probe proves nothing, so only the server's own false flags (no veto key)
 *    end the walk. New rows past a claimed end follow the server's cursor or
 *    stop the walk — never a second synthesized offset.
 *  - A drifted page (no cursor yet a more-flag set, a non-final stream) or a
 *    page that no longer PARSES ends the walk `reason: 'shape-mismatch'`,
 *    `complete: false`, with a `stopDetail` — never a fabricated end.
 *  - Rows that do not read are QUARANTINED and counted (`quarantined`); a page
 *    whose readable rows fall below the row majority stops the walk.
 *  - A non-ok envelope / evaluate throw is retried on the same cursor after a
 *    `pause.retry` wait, up to `SURFACE_BOUNDS.listWalkFetchRetries`, before the
 *    walk ends `reason: 'fetch-failed'` — then callers fall back to the dialog.
 *  - Stagnation tolerates a few duplicate-window pages, then stops.
 *  - Cooperative stop + the active driver's abort signal break the walk
 *    mid-sleep, exactly like the page reader's scroll loop.
 */

import { type ActivityReporter, NOOP_ACTIVITY_REPORTER } from '@/adapter/activity-reporter';
import { fetchJson } from '@/adapter/fetch-json';
import { SURFACE } from '@/adapter/ig-surface';
import type { Reader } from '@/adapter/reader';
import { type Clock, SystemClock } from '@/governors/clock';
import type { ReadBudget } from '@/governors/read-budget';
import { SURFACE_BOUNDS } from '@/kernel/surface-policy';
import { type TempoSource, tempoOrReference } from '@/kernel/tempo';
import { decideStep, nextForm, type StopDetail, type WalkCursorState } from '@/rim/list-walk-end';
import type { RimTab } from '@/rim/types';
import { ADAPTER, RIM } from '@/timing/config';
import { sample, sleep, uniform } from '@/timing/primitives';
import { launchStream } from '@/utils/entropy';
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
  /** The tempo every page wait, rest, retry and rest stride resolves from (default: the reference tempo). */
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
    this.rng = deps.rng ?? launchStream('rim/list-page-walker');
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
    // A failed fetch waits a fresh `pause.retry` around the walk's rest before the same cursor.
    const retryPolicy = this.tempo.policy('pause.retry', { baseMs: this.tempo.base('walk.rest'), pollMs: ADAPTER.NAV_SETTLE_MS });
    // The long-rest STRIDE is drawn, not fixed: the next breather lands after a fresh stride.
    let nextRestAtPage = sample(this.tempo.policy('walk.rest-every'), this.rng);
    const form = SURFACE.listForm(which);

    // Live veil readout: an 'api' phase counting rows as they arrive; `maxNewPks` (when set)
    // is a real denominator, so the overlay draws a determinate bar.
    const reportActivity = (count: number): void =>
      this.reporter.report({
        kind: 'api',
        op: { op: 'read-list', list: which, of: args.ofUsername ?? null, done: count, total: args.maxNewPks ?? null },
      });
    reportActivity(0);

    const observed = new Set<string>();
    /** Pks new to the CALLER (per `isKnown`), the real demand-budget metric. */
    let callerNewPks = 0;
    /** Consecutive pages contributing nothing caller-new (isKnown walks only). */
    let knownStagnantPages = 0;
    let cursor: string | null = args.startCursor ?? null;
    // The resume point handed back: always a REAL server cursor (or the untouched
    // startCursor), never the synthesized end-probe value `cursor` holds while probing.
    let resumeCursor: string | null = args.startCursor ?? null;
    // Sticky cursor form: a resumed opaque cursor makes the whole walk opaque.
    let state: WalkCursorState = { lastForm: cursor === null ? 'none' : SURFACE.listCursorForm(cursor), probing: false };
    let plainProbe = false;
    let pages = 0;
    let complete = false;
    let endEvidence: WalkResult['endEvidence'];
    let stopDetail: StopDetail | undefined;
    let reason = 'max-pages';
    let fetchFailures = 0;
    let stagnantPages = 0;
    let quarantined = 0;
    // Diagnostics: rows the API returned (duplicates included) and the final page's shape.
    let rows = 0;
    let lastPage: { rows: number; continuation: string } | null = null;
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
      const res = await fetchJson(this.tab, SURFACE.listPageScript(pk, which, cursor, plainProbe));
      if (!res.ok) {
        // A rejected probe confirms the end ONLY on the SPECIFIC past-the-limit refusal (a 400
        // that is no throttle/wall, auth redirect or network error): "we got throttled" must
        // never read as "the list is complete" and feed absence verdicts a fabricated end.
        const pastTheLimitRejection =
          res.status === 400 && res.kind !== 'rate-limited' && res.kind !== 'auth' && res.kind !== 'network';
        if (state.probing && pastTheLimitRejection) {
          complete = true;
          endEvidence = 'probe-rejected';
          reason = 'no-more-pages';
          logger.info('rim.list-page-walker: past-the-end probe rejected — end confirmed', {
            pk, which, pages, observed: observed.size, ...res.detail,
          });
          break;
        }
        fetchFailures += 1;
        if (fetchFailures > SURFACE_BOUNDS.listWalkFetchRetries) {
          reason = 'fetch-failed';
          logger.warn('rim.list-page-walker: page fetch failed, stopping', { pk, which, pages, ...res.detail });
          break;
        }
        logger.warn('rim.list-page-walker: page fetch failed, retrying the same cursor', { pk, which, pages, ...res.detail });
        await this.sleepFn(sample(retryPolicy, this.rng), this.abortSignal?.());
        continue;
      }
      fetchFailures = 0;
      pages += 1;

      const now = this.clock.now();
      // A stream that is not final reads as drift: its rows count, its end never does.
      const parsed = which === 'following' ? this.reader.parseFollowingListStrict(res.json, now, res.decoded.final)
        : this.reader.parseFollowersListStrict(res.json, now, res.decoded.final);
      if (parsed === null) {
        // SHAPE DRIFT: the page fetched but no longer parses. It ends the walk INCOMPLETE;
        // a drifted page can never originate or confirm an end-of-list claim.
        reason = 'shape-mismatch';
        logger.warn('rim.list-page-walker: page shape unrecognized, stopping walk', {
          pk, which, pages, observed: observed.size,
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
      quarantined += parsed.quarantined;
      lastPage = { rows: parsed.observations.length, continuation: parsed.continuation.kind };
      // The caller's stop, once this page's rows are written and before any pacing sleep.
      if (args.stopAfterPage?.(parsed.observations) === true) { reason = 'caller-stop'; break; }
      // A page that mostly fails to read is drift, not a page with a few odd rows.
      const pageRows = parsed.observations.length + parsed.quarantined;
      if (parsed.observations.length < SURFACE_BOUNDS.rowMajority * pageRows) {
        reason = 'shape-mismatch';
        stopDetail = 'rows-unreadable';
        logger.warn('rim.list-page-walker: most rows unreadable, stopping walk', { pk, which, pages, quarantined });
        break;
      }

      const newThisPage = observed.size - sizeBefore;
      const step = decideStep({ continuation: parsed.continuation, newRows: newThisPage }, state, form, rows,
        (n) => SURFACE.listEndProbeCursor(n));
      if (step.act === 'complete') {
        complete = true;
        endEvidence = step.endEvidence;
        reason = 'no-more-pages';
        logger.info('rim.list-page-walker: end of list', { pk, which, pages, observed: observed.size, endEvidence });
        break;
      }
      if (step.act === 'stop') {
        reason = step.reason;
        stopDetail = step.detail;
        logger.warn('rim.list-page-walker: the list cannot be read to its end, stopping walk', {
          pk, which, pages, observed: observed.size, stopDetail,
        });
        break;
      }
      if (state.probing && step.act === 'continue') {
        logger.warn('rim.list-page-walker: end-of-list claim was FALSE, following the server cursor', {
          pk, which, pages, recovered: newThisPage,
        });
      }

      // Demand-driven stop (growth acquisition): the caller has the NEW pks it needs —
      // end here, resume cursor intact. Newness is caller-level when `isKnown` is given.
      const demandMet =
        args.maxNewPks !== undefined &&
        (args.isKnown === undefined ? observed.size : callerNewPks) >= args.maxNewPks;
      if (demandMet) {
        reason = 'target-reached';
        logger.info('rim.list-page-walker: pk target reached, stopping walk', {
          pk, which, pages, observed: observed.size, callerNewPks, maxNewPks: args.maxNewPks,
        });
        break;
      }

      // Known-density stop (isKnown walks only): consecutive pages of rows the caller
      // already holds mean a fully-walked stretch — stop instead of paging all of it.
      if (args.isKnown !== undefined) {
        knownStagnantPages = callerNewPks === callerNewBefore ? knownStagnantPages + 1 : 0;
        if (knownStagnantPages >= RIM.LIST_WALK_STAGNANT_STOP) {
          reason = 'no-new-for-caller';
          logger.info('rim.list-page-walker: only already-known rows, stopping walk', {
            pk, which, pages, observed: observed.size,
          });
          break;
        }
      }

      if (step.act === 'continue') {
        // Duplicate-window pages (IG shifts windows on a live list) are tolerated a few in a row.
        stagnantPages = newThisPage === 0 ? stagnantPages + 1 : 0;
        if (stagnantPages >= RIM.LIST_WALK_STAGNANT_STOP) {
          reason = 'stagnant';
          logger.warn('rim.list-page-walker: no new pks across consecutive pages, stopping', {
            pk, which, pages, stagnantPages,
          });
          break;
        }
        state = { lastForm: nextForm(state.lastForm, step.form), probing: false };
        plainProbe = false;
      } else {
        state = { lastForm: state.lastForm, probing: true };
        plainProbe = step.plainForm;
        logger.info('rim.list-page-walker: end-of-list claimed, probing one page past it', {
          pk, which, pages, observed: observed.size,
        });
      }
      cursor = step.cursor;

      await this.sleepFn(sample(pacePolicy, this.rng), this.abortSignal?.());
      if (pages >= nextRestAtPage && !shouldStop()) {
        const restMs = sample(restPolicy, this.rng);
        logger.info('rim.list-page-walker: long rest between page bursts', { pk, which, pages, restMs });
        await this.sleepFn(restMs, this.abortSignal?.());
        nextRestAtPage = pages + sample(this.tempo.policy('walk.rest-every'), this.rng);
      }
    }

    // A finished list has no resume point — the next walk starts at the head.
    if (complete) resumeCursor = null;
    const endConfirmed = endEvidence === 'probe' || endEvidence === 'probe-rejected';

    this.reporter.clear();

    logger.info('rim.list-page-walker: walk ended', {
      pk, which, observed: observed.size, rows, duplicates: rows - observed.size, quarantined, pages,
      complete, endConfirmed, endEvidence, stopDetail, reason, cursor: resumeCursor, lastPage,
    });
    return { pks: [...observed], pages, complete, endConfirmed, reason, cursor: resumeCursor, quarantined,
      ...(endEvidence === undefined ? {} : { endEvidence }),
      ...(stopDetail === undefined ? {} : { stopDetail }),
      ...(retryAt === undefined ? {} : { retryAt }) };
  }
}
