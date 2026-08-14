/**
 * FollowersPageReader — the ONE low-level followers scraper.
 *
 * Both follower acquisition (poaching a target's audience) and the own-followers
 * source (follow-back sweeps + fallback target picking) drive Instagram's
 * followers dialog the same way: register a response interceptor, open the dialog,
 * scroll it in bounded rounds to trigger the paginated `followers/` API, and parse
 * each captured page. This class holds that mechanism exactly once; callers differ
 * only in what they do with each observation (via `onObservation`).
 *
 * Folded review fixes:
 *  - R1: derive `targetPk` from the followers-list URL the first time a page
 *        matches; profile-info is enrichment only.
 *  - R2: never `spend()` here (the request-metering pipeline owns that); only
 *        *check* `budget.canSpend()` before each scroll round.
 *  - R3: re-run `sentinel.check()` at the TOP of each scroll round; break non-`ok`.
 *  - R5: drain correctly — `unsubscribe()` first, then loop `allSettled` until the
 *        in-flight parse set stops growing, before returning.
 */

import type { Reader } from '@/adapter/reader';
import type { Sentinel } from '@/adapter/sentinel';
import type { RequestBudget } from '@/governors/request-budget';
import { SystemClock, type Clock } from '@/governors/clock';
import type { Observation } from '@/store/types';
import type { RimTab } from '@/rim/types';
import * as logger from '@/utils/logger';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The list-dialog operations the scraper needs. `Actor` satisfies this. */
export interface FollowersActor {
  openFollowersDialog(targetUsername: string): Promise<void>;
  openFollowingDialog(targetUsername: string): Promise<void>;
  /** Scrolls the dialog to load more; returns `false` when there is nothing to scroll. */
  scrollFollowers(): Promise<boolean>;
}

/** Construction dependencies. `clock`/`scrollWaitMs` are optional (tests shrink them). */
export interface FollowersPageReaderDeps {
  tab: RimTab;
  reader: Reader;
  actor: FollowersActor;
  clock?: Clock;
  /** Pause after each scroll so the paginated `followers/` response can land. */
  scrollWaitMs?: number;
  /** Injected pause; defaults to a real setTimeout (tests record the ms instead). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable randomness for the jittered scan pacing (deterministic tests). */
  rng?: () => number;
}

/** One scrape run's parameters. */
export interface CollectArgs {
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
   */
  onObservation: (obs: Observation, cursor: string | null) => void;
  /**
   * Live-progress callback (optional, additive): invoked with the CUMULATIVE
   * observed-pk count whenever a parsed page GROWS the observed set (per page,
   * not per user — a page is the natural batch). Lets callers surface counts
   * mid-scrape instead of only when `collect` resolves.
   */
  onProgress?: (observedCount: number) => void;
  budget: RequestBudget;
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
}

/** What a scrape yields back to its caller. */
export interface CollectResult {
  observedPks: string[];
  targetPk: string | null;
  cursor: string | null;
}

export class FollowersPageReader {
  private readonly tab: RimTab;
  private readonly reader: Reader;
  private readonly actor: FollowersActor;
  private readonly clock: Clock;
  private readonly scrollWaitMs: number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly rng: () => number;

  constructor(deps: FollowersPageReaderDeps) {
    this.tab = deps.tab;
    this.reader = deps.reader;
    this.actor = deps.actor;
    this.clock = deps.clock ?? new SystemClock();
    this.scrollWaitMs = deps.scrollWaitMs ?? 2000;
    this.sleepFn = deps.sleep ?? sleep;
    this.rng = deps.rng ?? Math.random;
  }

  async collect(args: CollectArgs): Promise<CollectResult> {
    const { targetUsername, onObservation, budget, sentinel, maxRounds, noNewStop } = args;
    const dialog = args.dialog ?? 'followers';
    const shouldStop = args.shouldStop ?? ((): boolean => false);
    // Each call draws a FRESH jittered wait when both bounds are set (the prune
    // scan path); otherwise the fixed scrollWaitMs (growth, unchanged).
    const nextWaitMs = (): number => {
      if (args.scrollMinMs === undefined || args.scrollMaxMs === undefined) {
        return this.scrollWaitMs;
      }
      const min = Math.max(0, args.scrollMinMs);
      const max = Math.max(min, args.scrollMaxMs);
      return Math.round(min + this.rng() * (max - min));
    };
    // The one endpoint kind this scrape parses list pages from — the paginated
    // `following/` API when the FOLLOWING dialog is open, else `followers/`.
    const listKind = dialog === 'following' ? 'following-list' : 'followers-list';

    const observed = new Set<string>();
    let targetPk: string | null = null;
    let cursor: string | null = null;
    // Held on an object so the mutation inside the response closure is visible to
    // the scroll loop below (CFA would otherwise narrow a bare `let` to `true`).
    const page = { hasMore: true };
    // Append-only so R5's drain can detect growth by length; never spliced.
    const pending: Promise<void>[] = [];

    // A blocked/rate-limited page (429, or an HTML wall on an API URL) means the
    // scrape should stop rather than parse blind; the scroll loop checks this.
    const halted = { hit: false };

    // Register BEFORE navigation so the first profile-info + followers page that
    // fire on `openFollowersDialog` are not missed.
    const unsubscribe = this.tab.onResponse((resp) => {
      const kind = this.reader.matchEndpoint(resp.url);
      if (kind !== listKind && kind !== 'web-profile-info') return;

      // Do not parse blind: a non-2xx status or a non-JSON body on an API URL is
      // a rate-limit / block / login wall, not data. Warn and stop the scrape.
      if (resp.status >= 400 || !resp.mimeType.toLowerCase().includes('json')) {
        logger.warn('rim.followers-page-reader: non-JSON/error response, halting scrape', {
          url: resp.url,
          status: resp.status,
          mimeType: resp.mimeType,
        });
        halted.hit = true;
        return;
      }

      // R1: the follower→target edge derives from the list URL, the first time
      // a page matches — never from the optional profile-info request.
      if (kind === listKind && targetPk === null) {
        targetPk =
          listKind === 'following-list'
            ? this.reader.extractTargetPkFromFollowingUrl(resp.url)
            : this.reader.extractTargetPkFromFollowersUrl(resp.url);
      }

      pending.push(
        resp
          .getBody()
          .then((body) => {
            const now = this.clock.now();
            if (kind === 'web-profile-info') {
              const obs = this.reader.parseProfileInfo(body, now);
              if (obs) onObservation(obs, null);
              return;
            }
            const parsed =
              listKind === 'following-list'
                ? this.reader.parseFollowingList(body, now)
                : this.reader.parseFollowersList(body, now);
            cursor = parsed.cursor;
            page.hasMore = parsed.hasMore;
            const sizeBefore = observed.size;
            for (const obs of parsed.observations) {
              observed.add(obs.accountPk);
              onObservation(obs, parsed.cursor);
            }
            // Live progress: report the cumulative count once per page that
            // actually grew the set (a stagnant/duplicate page stays silent).
            if (observed.size > sizeBefore) args.onProgress?.(observed.size);
          })
          .catch((e: unknown) => {
            logger.warn('rim.followers-page-reader: body/parse failed', {
              url: resp.url,
              error: String(e),
            });
          }),
      );
    });

    try {
      // The dialog is opened here (navigation fires profile-info + the first page).
      if (dialog === 'following') {
        await this.actor.openFollowingDialog(targetUsername);
      } else {
        await this.actor.openFollowersDialog(targetUsername);
      }
      // Let the FIRST followers page load + parse before the scroll loop begins —
      // the initial page arrives shortly after the modal opens, and small lists may
      // never need a scroll at all. Skipped when a stop is already requested (the
      // loop's own top-of-round check then breaks immediately).
      if (!shouldStop()) await this.sleepFn(nextWaitMs());

      let stagnantRounds = 0;
      for (let round = 0; round < maxRounds; round++) {
        // Cooperative abort (Phase 5 prune scan): the caller asked us to stop.
        if (shouldStop()) {
          logger.info('rim.followers-page-reader: stop requested, ending scrape', {
            targetUsername,
          });
          break;
        }
        // A captured response reported an error/HTML wall — stop scrolling.
        if (halted.hit) break;
        // R3: re-check the Sentinel at the TOP of each round; halt on any block.
        const status = await sentinel.check();
        if (status !== 'ok') {
          logger.warn('rim.followers-page-reader: sentinel non-ok, stopping scroll', {
            targetUsername,
            status,
          });
          break;
        }
        // R2: the budget is spent by the metering pipeline; here we only respect it.
        if (!budget.canSpend()) {
          logger.warn('rim.followers-page-reader: request budget exhausted, stopping', {
            targetUsername,
          });
          break;
        }

        const before = observed.size;
        await this.actor.scrollFollowers();
        await this.sleepFn(nextWaitMs());

        if (observed.size === before) {
          stagnantRounds += 1;
          if (stagnantRounds >= noNewStop) break;
        } else {
          stagnantRounds = 0;
        }
        // The last captured page reported no further pages — nothing left to scroll.
        if (page.hasMore === false) break;
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
    }

    return { observedPks: [...observed], targetPk, cursor };
  }
}
