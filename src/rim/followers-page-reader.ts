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

/** The followers-dialog operations the scraper needs. `Actor` satisfies this. */
export interface FollowersActor {
  openFollowersDialog(targetUsername: string): Promise<void>;
  scrollFollowers(): Promise<void>;
}

/** Construction dependencies. `clock`/`scrollWaitMs` are optional (tests shrink them). */
export interface FollowersPageReaderDeps {
  tab: RimTab;
  reader: Reader;
  actor: FollowersActor;
  clock?: Clock;
  /** Pause after each scroll so the paginated `followers/` response can land. */
  scrollWaitMs?: number;
}

/** One scrape run's parameters. */
export interface CollectArgs {
  targetUsername: string;
  /**
   * Called for every parsed user (followers-list) and for the target's profile
   * (profile-info enrichment). The caller decides store writes / edges; the
   * cursor of the page the observation came from is passed for convenience
   * (`null` for profile-info).
   */
  onObservation: (obs: Observation, cursor: string | null) => void;
  budget: RequestBudget;
  sentinel: Sentinel;
  /** Hard cap on scroll rounds so a scrape is always bounded. */
  maxRounds: number;
  /** Stop after this many consecutive rounds that yield no new pks. */
  noNewStop: number;
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

  constructor(deps: FollowersPageReaderDeps) {
    this.tab = deps.tab;
    this.reader = deps.reader;
    this.actor = deps.actor;
    this.clock = deps.clock ?? new SystemClock();
    this.scrollWaitMs = deps.scrollWaitMs ?? 2000;
  }

  async collect(args: CollectArgs): Promise<CollectResult> {
    const { targetUsername, onObservation, budget, sentinel, maxRounds, noNewStop } = args;

    const observed = new Set<string>();
    let targetPk: string | null = null;
    let cursor: string | null = null;
    // Held on an object so the mutation inside the response closure is visible to
    // the scroll loop below (CFA would otherwise narrow a bare `let` to `true`).
    const page = { hasMore: true };
    // Append-only so R5's drain can detect growth by length; never spliced.
    const pending: Promise<void>[] = [];

    // Register BEFORE navigation so the first profile-info + followers page that
    // fire on `openFollowersDialog` are not missed.
    const unsubscribe = this.tab.onResponse((resp) => {
      const kind = this.reader.matchEndpoint(resp.url);
      if (kind !== 'followers-list' && kind !== 'profile-info') return;

      // R1: the follower→target edge derives from the followers-list URL, the
      // first time a page matches — never from the optional profile-info request.
      if (kind === 'followers-list' && targetPk === null) {
        targetPk = this.reader.extractTargetPkFromFollowersUrl(resp.url);
      }

      pending.push(
        resp
          .getBody()
          .then((body) => {
            const now = this.clock.now();
            if (kind === 'profile-info') {
              const obs = this.reader.parseProfileInfo(body, now);
              if (obs) onObservation(obs, null);
              return;
            }
            const parsed = this.reader.parseFollowersList(body, now);
            cursor = parsed.cursor;
            page.hasMore = parsed.hasMore;
            for (const obs of parsed.observations) {
              observed.add(obs.accountPk);
              onObservation(obs, parsed.cursor);
            }
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
      await this.actor.openFollowersDialog(targetUsername);

      let stagnantRounds = 0;
      for (let round = 0; round < maxRounds; round++) {
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
        await sleep(this.scrollWaitMs);

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
