/** The shared dialog-list reader streams rows, preserves completeness, and enters on the graph activity clock. */

import { type ActivityReporter, NOOP_ACTIVITY_REPORTER } from '@/adapter/activity-reporter';
import type { Reader } from '@/adapter/reader';
import { type Clock, SystemClock } from '@/governors/clock';
import type { ReadBudget } from '@/governors/read-budget';
import { measuredRowsPerPage } from '@/kernel/derive-reentry';
import { HTTP_STATUS } from '@/kernel/surface-policy';
import { type TempoPolicy, type TempoSource, tempoOrReference } from '@/kernel/tempo';
import { createIgActivityClock, type IgActivityClock, underClock } from '@/rim/ig-activity-clock';
import type { RimTab } from '@/rim/types';
import { admits } from '@/surface/read/admission';
import { noisify } from '@/timing/noise';
import { sample, sleep, uniform } from '@/timing/primitives';
import { launchStream } from '@/utils/entropy';
import * as logger from '@/utils/logger';

/** The list-dialog operations the scraper needs. `Actor` satisfies this. */
export interface FollowersActor {
  openFollowersDialog(targetUsername: string): Promise<void>;
  openFollowingDialog(targetUsername: string): Promise<void>;
  /** Scrolls the dialog to load more; returns `false` when there is nothing to scroll. */
  scrollFollowers(): Promise<boolean>;
}

/** Construction dependencies. `clock`/`scrollWaitMs` are optional (tests shrink them). */
export interface FollowersPageReaderDeps {
  onProgress?: (phase: string) => void;
  readBudget?: ReadBudget;
  tab: RimTab;
  reader: Reader;
  actor: FollowersActor;
  clock?: Clock;
  /** Pause after each scroll so the paginated `followers/` response can land (default: `scroll.wait.dialog`). */
  scrollWaitMs?: number;
  /** Injected pause; defaults to a real setTimeout (tests record the ms instead). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injectable randomness for the jittered scan pacing (deterministic tests). */
  rng?: () => number;
  /** The shared driver stop signal. */
  abortSignal?: () => AbortSignal | undefined;
  /** Live activity readout for the veil; defaults to a no-op. */
  reporter?: ActivityReporter;
  /** The tempo the default scroll wait resolves from (default: the reference tempo). */
  tempo?: TempoSource;
  activity?: IgActivityClock;
}

export type { CollectArgs, CollectResult } from './followers-page-types';

import type { CollectArgs, CollectResult } from './followers-page-types';

export class FollowersPageReader {
  private readonly onProgress?: (phase: string) => void;
  private readonly readBudget?: ReadBudget;
  private readonly tab: RimTab;
  private readonly reader: Reader;
  private readonly actor: FollowersActor;
  private readonly clock: Clock;
  private readonly scrollWaitMs: number | undefined;
  private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly rng: () => number;
  private readonly abortSignal?: () => AbortSignal | undefined;
  private readonly reporter: ActivityReporter;
  private readonly tempo: TempoSource;
  private readonly activity: IgActivityClock;

  constructor(deps: FollowersPageReaderDeps) {
    this.onProgress = deps.onProgress;
    this.readBudget = deps.readBudget;
    this.tab = deps.tab;
    this.reader = deps.reader;
    this.actor = deps.actor;
    this.clock = deps.clock ?? new SystemClock();
    this.scrollWaitMs = deps.scrollWaitMs;
    this.sleepFn = deps.sleep ?? sleep;
    this.rng = deps.rng ?? launchStream('rim/followers-page-reader');
    this.abortSignal = deps.abortSignal;
    this.reporter = deps.reporter ?? NOOP_ACTIVITY_REPORTER;
    this.tempo = tempoOrReference(deps.tempo);
    this.activity = deps.activity ?? createIgActivityClock({ tempo: this.tempo, now: () => this.clock.now(), sleep: this.sleepFn });
  }

  /** `scrollWait`: the caller's own wait policy when it sets no explicit bounds (acquisition's `scroll.wait.acquire`). */
  async collect(args: CollectArgs, scrollWait?: TempoPolicy): Promise<CollectResult> {
    if (args.shouldStop?.() || this.abortSignal?.()?.aborted) {
      return { observedPks: [], targetPk: null, cursor: null, endReason: 'stop-requested' };
    }
    const purpose = args.readPurpose ?? 'reconciliation';
    const readyAt = Math.max(this.readBudget?.availability('profile', purpose, 1, args.readUse).resumeAt ?? 0,
      this.readBudget?.availability('list-page', purpose, 1, args.readUse).resumeAt ?? 0);
    if (readyAt > 0) return { observedPks: [], targetPk: null, cursor: null, endReason: 'read-budget', retryAt: readyAt };
    return underClock(this.activity, () => this.clock.now(), this.abortSignal?.(), () => this.collectSpaced(args, scrollWait));
  }

  private async collectSpaced(args: CollectArgs, scrollWait?: TempoPolicy): Promise<CollectResult> {
    const { targetUsername, onObservation, sentinel, maxRounds, noNewStop } = args;
    if (args.shouldStop?.() || this.abortSignal?.()?.aborted) {
      return { observedPks: [], targetPk: null, cursor: null, endReason: 'stop-requested' };
    }
    const purpose = args.readPurpose ?? 'reconciliation';
    for (const kind of ['profile', 'list-page'] as const) {
      const permit = this.readBudget?.consume(kind, purpose, 1, args.readUse);
      if (permit !== undefined && !permit.allowed) return { observedPks: [], targetPk: null, cursor: null,
        endReason: 'read-budget', ...(permit.resumeAt === null ? {} : { retryAt: permit.resumeAt }) };
    }
    const dialog = args.dialog ?? 'followers';
    const externalStop = args.shouldStop ?? ((): boolean => false);
    const shouldStop = (): boolean => externalStop() || this.abortSignal?.()?.aborted === true;
    const waitPolicy = args.scrollMinMs === undefined || args.scrollMaxMs === undefined
      ? scrollWait ?? (this.scrollWaitMs === undefined ? this.tempo.policy('scroll.wait.dialog') : noisify('sub-cadence', this.scrollWaitMs, this.rng))
      : uniform(args.scrollMinMs, args.scrollMaxMs);
    const nextWaitMs = (): number => sample(waitPolicy, this.rng);
    const listKind = dialog === 'following' ? 'following-list' : 'followers-list';

    const reportActivity = (count: number): void =>
      this.reporter.report({
        kind: 'page',
        op: { op: 'browse-list', list: dialog, of: targetUsername, done: count, total: null },
      });
    reportActivity(0);

    const observed = new Set<string>();
    let targetPk: string | null = null;
    let cursor: string | null = null;
    const page = { hasMore: true };
    // Append-only so R5's drain can detect growth by length; never spliced.
    const pending: Promise<void>[] = [];
    let validatedPages = 0;
    const pageSizes: number[] = [];
    let reportedPages = 0;
    const noteReadProgress = (): void => {
      if (validatedPages <= reportedPages) return;
      reportedPages = validatedPages;
      this.onProgress?.('dialog-page-ingested');
    };

    const halted = { hit: false };
    // Any incomplete page poisons absence claims, while its readable rows still stream.
    const drifted = { hit: false };

    // Register BEFORE navigation so the first profile-info + followers page that
    // fire on `openFollowersDialog` are not missed.
    const unsubscribe = this.tab.onResponse((resp) => {
      const kind = this.reader.kindOf(resp);
      const profileKind = this.reader.profileKindOf(resp);
      if (kind !== listKind && profileKind === null) return;

      if (resp.status >= HTTP_STATUS.badRequest || !this.reader.parseableBody(resp.mimeType)) {
        logger.warn('rim.followers-page-reader: non-JSON/error response, halting scrape',
          { url: resp.url, status: resp.status, mimeType: resp.mimeType });
        halted.hit = true;
        return;
      }

      // The target edge derives from the list URL, never optional profile-info.
      if (kind === listKind && targetPk === null) {
        targetPk =
          listKind === 'following-list'
            ? this.reader.extractTargetPkFromFollowingUrl(resp.url)
            : this.reader.extractTargetPkFromFollowersUrl(resp.url);
        if (targetPk !== null) args.onTargetPk?.(targetPk);
      }

      const failed = (e: unknown): void => {
        if (kind === listKind) drifted.hit = true;
        logger.warn('rim.followers-page-reader: body/parse failed', { url: resp.url, error: String(e) });
      };
      // Each body is read once for every consumer (the observer stores a profile too); our own counts stay gated.
      const read = this.reader.observed.read(resp, this.clock.now());
      if (read === null) return;
      pending.push(read.then(({ read: body }) => {
        if (profileKind !== null) {
          const seen = this.reader.profileSeen(body);
          if (seen !== null) onObservation(seen.obs, null);
          return;
        }
        if (!body.ok) {
          if (body.kind === 'wall') halted.hit = true;
          else drifted.hit = true;
          return;
        }
        const parsed = body.projection;
        cursor = parsed.cursor;
        const end = parsed.continuation;
        const trusted = admits('destructive', body) && parsed.rowIssues.length === 0
          && (end?.kind === 'next' || (end?.kind === 'end' && end.evidence === 'flags-false' && end.vetoKey === undefined));
        if (!trusted) drifted.hit = true;
        page.hasMore = !trusted || end?.kind !== 'end';
        const sizeBefore = observed.size;
        for (const obs of parsed.facts) {
          observed.add(obs.accountPk);
          onObservation(obs, parsed.cursor);
        }
        validatedPages += 1;
        pageSizes.push(parsed.facts.length);
        if (observed.size > sizeBefore) {
          args.onProgress?.(observed.size);
          reportActivity(observed.size);
        }
      }).catch(failed));
    });

    let endReason = 'max-rounds';
    let roundsRun = 0;
    let retryAt: number | undefined;
    // An open failure rethrows only after the interceptor drains and unsubscribes.
    let openFailure: unknown = null;

    try {
      // The dialog is opened here (navigation fires profile-info + the first page).
      try {
        if (dialog === 'following') {
          await this.actor.openFollowingDialog(targetUsername);
        } else {
          await this.actor.openFollowersDialog(targetUsername);
        }
      } catch (e) {
        openFailure = e;
        endReason = 'open-failed';
        throw e;
      }
      // Let the initial response parse before scrolling.
      if (!shouldStop()) await this.sleepFn(nextWaitMs(), this.abortSignal?.());
      noteReadProgress();

      let stagnantRounds = 0;
      for (let round = 0; round < maxRounds; round++) {
        roundsRun = round + 1;
        // Cooperative abort (Phase 5 prune scan): the caller asked us to stop.
        if (shouldStop()) {
          endReason = 'stop-requested';
          logger.info('rim.followers-page-reader: stop requested, ending scrape', {
            targetUsername,
          });
          break;
        }
        // A captured response reported an error/HTML wall — stop scrolling.
        if (halted.hit) {
          endReason = 'blocked-response';
          break;
        }
        // A captured page no longer parses (IG shape drift) — stop scrolling;
        // continuing would only fetch more pages the extractor cannot read.
        if (drifted.hit) {
          endReason = 'shape-mismatch';
          break;
        }
        // R3: re-check the Sentinel at the TOP of each round; halt on any block.
        const status = await sentinel.check();
        if (status !== 'ok') {
          endReason = `sentinel:${status}`;
          logger.warn('rim.followers-page-reader: sentinel non-ok, stopping scroll', {
            targetUsername, status,
          });
          break;
        }
        const before = observed.size;
        const permit = this.readBudget?.consume('list-page', purpose, 1, args.readUse);
        if (permit !== undefined && !permit.allowed) {
          endReason = 'read-budget';
          retryAt = permit.resumeAt ?? undefined;
          break;
        }
        await this.actor.scrollFollowers();
        await this.sleepFn(nextWaitMs(), this.abortSignal?.());
        noteReadProgress();

        if (observed.size === before) {
          stagnantRounds += 1;
          if (stagnantRounds >= noNewStop) {
            endReason = 'stagnant';
            break;
          }
        } else {
          stagnantRounds = 0;
        }
        // The last captured page reported no further pages — nothing left to scroll.
        if (page.hasMore === false) {
          endReason = 'no-more-pages';
          break;
        }
      }
    } catch (e) {
      logger.error('rim.followers-page-reader: collect failed', {
        targetUsername,
        error: String(e),
      });
    } finally {
      // R5: unsubscribe FIRST so no new parses are queued, then drain until the
      // in-flight set stops growing (a response can still land during teardown).
      unsubscribe();
      let previousLength = -1;
      while (pending.length !== previousLength) {
        previousLength = pending.length;
        await Promise.allSettled(pending);
      }
      this.reporter.clear();
    }

    // Late parses and walls override a natural end. A final first page also completes a zero-scroll census.
    if (endReason === 'no-more-pages' || endReason === 'stagnant' || endReason === 'max-rounds') {
      if (halted.hit) endReason = 'blocked-response';
      else if (drifted.hit) endReason = 'shape-mismatch';
      else if (!page.hasMore) endReason = 'no-more-pages';
    }

    logger.info('rim.followers-page-reader: scrape ended', {
      targetUsername,
      dialog,
      observed: observed.size,
      rounds: roundsRun,
      reason: endReason,
    });

    // Prune-scan semantics: an unopened dialog is a FAILED scrape, not an empty
    // list — rethrown only after the interceptor is torn down and drained.
    if (openFailure !== null && args.throwOnOpenFailure === true) throw openFailure;

    const full = pageSizes.slice(0, -1);
    return { rowsPerPage: measuredRowsPerPage({ rows: full.reduce((sum, size) => sum + size, 0), fullPages: full.length }, null),
      observedPks: [...observed], targetPk, cursor, endReason, pages: validatedPages,
      ...(retryAt === undefined ? {} : { retryAt }) };
  }
}
