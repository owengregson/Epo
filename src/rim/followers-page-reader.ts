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
 *  - R3: re-run `sentinel.check()` at the TOP of each scroll round; break non-`ok`.
 *  - R5: drain correctly — `unsubscribe()` first, then loop `allSettled` until the
 *        in-flight parse set stops growing, before returning.
 */

import type { Reader } from '@/adapter/reader';
import type { Sentinel } from '@/adapter/sentinel';
import { SystemClock, type Clock } from '@/governors/clock';
import type { Observation } from '@/store/types';
import type { RimTab } from '@/rim/types';
import {
  type ActivityReporter,
  NOOP_ACTIVITY_REPORTER,
} from '@/adapter/activity-reporter';
import * as logger from '@/utils/logger';
import { fixed, sample, sleep, uniform } from '@/timing/primitives';
import { RIM } from '@/timing/config';

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
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injectable randomness for the jittered scan pacing (deterministic tests). */
  rng?: () => number;
  /**
   * Provider of the ACTIVE driver's abort signal — folded into the cooperative
   * `shouldStop` check AND passed into the inter-round sleeps, so a `stop()`
   * breaks a scrape mid-wait, not just between rounds.
   */
  abortSignal?: () => AbortSignal | undefined;
  /** Live activity readout for the veil; defaults to a no-op. */
  reporter?: ActivityReporter;
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
   *
   * CONTRACT (docs/PRINCIPLES.md §1 — facts stream): implementations MUST
   * write each observation through to the store as it arrives, never collect
   * it for an end-of-walk flush — a truncated/aborted collect must keep every
   * row it saw. The returned `observedPks` array exists for completeness
   * verdicts and counts, not as the carrier of facts.
   */
  onObservation: (obs: Observation, cursor: string | null) => void;
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
  observedPks: string[];
  targetPk: string | null;
  cursor: string | null;
  /**
   * Why the scroll loop ended ('no-more-pages', 'stagnant', 'max-rounds',
   * 'stop-requested', 'sentinel:*', 'blocked-response', 'open-failed').
   * Callers that need a FULL census (prune) must treat anything but a natural
   * drain as an incomplete list, never as "this is everything".
   */
  endReason: string;
}

export class FollowersPageReader {
  private readonly tab: RimTab;
  private readonly reader: Reader;
  private readonly actor: FollowersActor;
  private readonly clock: Clock;
  private readonly scrollWaitMs: number;
  private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly rng: () => number;
  private readonly abortSignal?: () => AbortSignal | undefined;
  private readonly reporter: ActivityReporter;

  constructor(deps: FollowersPageReaderDeps) {
    this.tab = deps.tab;
    this.reader = deps.reader;
    this.actor = deps.actor;
    this.clock = deps.clock ?? new SystemClock();
    this.scrollWaitMs = deps.scrollWaitMs ?? RIM.SCROLL_WAIT_MS;
    this.sleepFn = deps.sleep ?? sleep;
    this.rng = deps.rng ?? Math.random;
    this.abortSignal = deps.abortSignal;
    this.reporter = deps.reporter ?? NOOP_ACTIVITY_REPORTER;
  }

  async collect(args: CollectArgs): Promise<CollectResult> {
    const { targetUsername, onObservation, sentinel, maxRounds, noNewStop } = args;
    const dialog = args.dialog ?? 'followers';
    // The caller's cooperative stop, folded with the ACTIVE driver's abort
    // signal — either ends the scrape at the next check.
    const externalStop = args.shouldStop ?? ((): boolean => false);
    const shouldStop = (): boolean =>
      externalStop() || this.abortSignal?.()?.aborted === true;
    // Each call draws a FRESH jittered wait when both bounds are set (the prune
    // scan path); otherwise the fixed scrollWaitMs (growth, unchanged). The
    // `uniform` policy carries the min ≥ 0 / max ≥ min clamps.
    const waitPolicy =
      args.scrollMinMs === undefined || args.scrollMaxMs === undefined
        ? fixed(this.scrollWaitMs)
        : uniform(args.scrollMinMs, args.scrollMaxMs);
    const nextWaitMs = (): number => sample(waitPolicy, this.rng);
    // The one endpoint kind this scrape parses list pages from — the paginated
    // `following/` API when the FOLLOWING dialog is open, else `followers/`.
    const listKind = dialog === 'following' ? 'following-list' : 'followers-list';

    // Live veil readout: unlike the direct API walk, this scrape DRIVES the page
    // (opens the modal and scrolls it), so it reads as a 'page' phase.
    const activityLabel =
      dialog === 'following' ? 'Scrolling following list' : 'Scrolling follower list';
    // No honest denominator here: the scroll scrape stops on stagnation/rounds,
    // not at a known count, so it reports NO total and the overlay shows an
    // indeterminate sweep rather than a fabricated percentage.
    const reportActivity = (count: number): void =>
      this.reporter.report({
        kind: 'page',
        label: activityLabel,
        count,
        detail: `@${targetUsername}`,
      });
    reportActivity(0);

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
            if (observed.size > sizeBefore) {
              args.onProgress?.(observed.size);
              reportActivity(observed.size);
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

    // Why the scroll loop ended — logged at the end so a truncated scrape is
    // diagnosable from a normal (info-level) log instead of silent.
    let endReason = 'max-rounds';
    let roundsRun = 0;
    // An open-dialog failure captured for the (opt-in) rethrow AFTER teardown:
    // the interceptor must unsubscribe and the pending parses drain first.
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
      // Let the FIRST followers page load + parse before the scroll loop begins —
      // the initial page arrives shortly after the modal opens, and small lists may
      // never need a scroll at all. Skipped when a stop is already requested (the
      // loop's own top-of-round check then breaks immediately).
      if (!shouldStop()) await this.sleepFn(nextWaitMs(), this.abortSignal?.());

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
        // R3: re-check the Sentinel at the TOP of each round; halt on any block.
        const status = await sentinel.check();
        if (status !== 'ok') {
          endReason = `sentinel:${status}`;
          logger.warn('rim.followers-page-reader: sentinel non-ok, stopping scroll', {
            targetUsername,
            status,
          });
          break;
        }
        const before = observed.size;
        await this.actor.scrollFollowers();
        await this.sleepFn(nextWaitMs(), this.abortSignal?.());

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

    return { observedPks: [...observed], targetPk, cursor, endReason };
  }
}
