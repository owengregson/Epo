/**
 * AdapterBackedAcquisition — the live implementation of the `FollowerAcquisition`
 * port (§2/§6). One scraping implementation shared by the Scanner/Engine refill
 * and the manual IPC handler.
 *
 * Request-efficiency design (the polling rework):
 *
 *  1. RESOLVE, don't scrape: the target pk comes from the store when we have
 *     ever seen the username; only a never-seen target (the seed's first
 *     contact) costs ONE profile-info fetch — which doubles as the target's
 *     enrichment (counts, mutuals, privacy) for free.
 *  2. DIRECT API paging: with the pk known, the followers list is paged
 *     straight off the paginated friendships API at full page size (~50/page)
 *     via the shared {@link ListPageWalker} — no profile navigation, no dialog,
 *     no scroll rounds at ~12 users a fetch.
 *  3. CURSOR RESUME: each walk starts from the per-target persisted
 *     `next_max_id` (`getScrapeCursor`) and persists where it stopped, so
 *     successive refills NEVER re-fetch a page already consumed. The old
 *     dialog scrape restarted at the head every cycle and re-downloaded the
 *     same rows each refill.
 *  4. DEMAND-DRIVEN stop: the walk ends as soon as `targetNewPks` accounts
 *     were observed (`maxNewPks`) — a refill fetches the two-or-so pages it
 *     needs, not a census.
 *  5. FALLBACK, not replacement: when the direct walk cannot fetch at all
 *     (`fetch-failed`), the old dialog-scroll scrape
 *     ({@link FollowersPageReader}) runs instead — same degradation contract
 *     as the prune scan's census path. A `shape-mismatch` walk does NOT fall
 *     back (the dialog parses through the same drifted extractor); it — like
 *     every end — surfaces on the result as a typed {@link AcquireEndReason},
 *     so callers can tell a failed read from genuine audience exhaustion.
 *
 * Edges (`follower → target (follows)`) are written as each observation
 * arrives — the pk is known before the first page, so no back-fill pass is
 * needed on the direct path. The dialog fallback keeps the R1 URL-derived-pk
 * back-fill and the R4 cursor persistence.
 */

import { asFetchEnvelope, SURFACE } from '@/adapter/ig-surface';
import type { Reader } from '@/adapter/reader';
import type { Sentinel } from '@/adapter/sentinel';
import { type Clock, SystemClock } from '@/governors/clock';
import type { FollowersPageReader } from '@/rim/followers-page-reader';
import type { ListPageWalker } from '@/rim/list-page-walker';
import type { FollowerAcquisition, RimTab } from '@/rim/types';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { RIM } from '@/timing/config';
import * as logger from '@/utils/logger';

/** Bounded scrape tuning; a live read is always request- and page-bounded. */
export interface AcquisitionConfig {
  /** Demand: the direct walk stops once this many pks were observed this run. */
  targetNewPks: number;
  /** Runaway bound on direct API pages per acquire. */
  maxPages: number;
  /**
   * Never scrape past this fraction of a target's TOTAL follower count
   * (cumulative across all acquires, measured by the follower→target edges
   * already in the store). Exhausting 100% of an account's audience is a
   * quality dead-end — the deep tail of a followers list is
   * old/inactive accounts. Once the cap is reached, acquire yields nothing new
   * and the engine's normal exhaustion path advances the chain. Unknown
   * follower count (target never profiled and the resolve fetch failed) =
   * uncapped, as before.
   */
  maxCoverageFraction: number;
  /** Dialog-scroll FALLBACK bounds (only when the direct walk cannot fetch). */
  maxRounds: number;
  noNewStop: number;
}

export const ACQUISITION_DEFAULTS: AcquisitionConfig = {
  // ~5 API pages at the 50-row page size. Deep on purpose: candidate QUALITY is
  // selection from a big pool — a shallow batch forces the Scanner to queue
  // whatever ratios it got, while ~250 raw prospects let the enrichment+scoring
  // pass keep only the best. Same cursor-paged endpoint the prune census uses;
  // still a fraction of one prune scan's request volume.
  targetNewPks: 250,
  maxPages: 12,
  maxCoverageFraction: 0.5,
  maxRounds: RIM.ACQUIRE_MAX_ROUNDS,
  noNewStop: RIM.ACQUIRE_NO_NEW_STOP,
};

/**
 * Why an acquire ended — split by TRUTH VALUE, not by scrape path.
 *
 * Genuine outcomes (the scrape ran and its result is trustworthy evidence
 * about the target's audience):
 *  - 'no-more-pages':     the walk VERIFIED the end of the target's list.
 *  - 'target-reached':    this refill's new-pk demand was met.
 *  - 'coverage-cap':      the audience coverage cap is already spent (no fetch).
 *  - 'no-new-for-caller': consecutive pages held only rows the store already has.
 *  - 'page-budget':       the per-acquire page/round budget was spent (the
 *                         resume cursor is persisted; the next refill continues).
 *  - 'stagnant':          the list stopped yielding new rows before a verified
 *                         end (the dialog's natural drain; duplicate windows on
 *                         the direct walk).
 *
 * Failures (the scrape could NOT trustworthily read the list — `observed: 0`
 * with one of these is NOT audience-exhaustion evidence and must never feed
 * the irreversible exhaustion cascade):
 *  - 'shape-mismatch':    the list page no longer parses (IG shape drift).
 *  - 'fetch-failed':      repeated fetch failures (throttle/network/walls).
 *  - 'sentinel-blocked':  the account was blocked before or during the scrape.
 *  - 'stopped':           a cooperative stop ended the walk mid-list.
 *  - 'dialog-failed':     the dialog fallback could not open/read the list.
 */
export type AcquireEndReason =
  | 'no-more-pages'
  | 'target-reached'
  | 'coverage-cap'
  | 'no-new-for-caller'
  | 'page-budget'
  | 'stagnant'
  | 'shape-mismatch'
  | 'fetch-failed'
  | 'sentinel-blocked'
  | 'stopped'
  | 'dialog-failed';

/** The failure half of {@link AcquireEndReason} (see the taxonomy above). */
export const ACQUIRE_FAILURE_REASONS: ReadonlySet<AcquireEndReason> = new Set([
  'shape-mismatch',
  'fetch-failed',
  'sentinel-blocked',
  'stopped',
  'dialog-failed',
]);

/** Whether an acquire's end reason means the read FAILED (vs a genuine outcome). */
export function isAcquireFailure(reason: AcquireEndReason): boolean {
  return ACQUIRE_FAILURE_REASONS.has(reason);
}

/**
 * What one acquire yields. Additive over the `FollowerAcquisition` port's
 * `{observed, targetPk}` shape (which this satisfies structurally): the
 * `endReason` says WHY the acquire ended, so callers can tell a genuine
 * completion from a failed read instead of treating every `observed: 0` as
 * exhaustion. Existing port-typed callers are unaffected.
 */
export interface AcquireResult {
  observed: number;
  targetPk: string | null;
  endReason: AcquireEndReason;
}

/** Map a {@link ListPageWalker} end reason into the acquire taxonomy. */
function reasonFromWalk(reason: string): AcquireEndReason {
  switch (reason) {
    case 'no-more-pages':
      return 'no-more-pages';
    case 'target-reached':
      return 'target-reached';
    case 'no-new-for-caller':
      return 'no-new-for-caller';
    case 'max-pages':
      return 'page-budget';
    case 'stagnant':
      return 'stagnant';
    case 'shape-mismatch':
      return 'shape-mismatch';
    case 'stop-requested':
      return 'stopped';
    case 'fetch-failed':
      return 'fetch-failed';
    default:
      // 'sentinel:*' and anything a future walker adds: never let an unmapped
      // reason read as a genuine outcome — default to the failure family.
      return reason.startsWith('sentinel:') ? 'sentinel-blocked' : 'fetch-failed';
  }
}

/** Map a dialog-scrape (`FollowersPageReader.collect`) end reason likewise. */
function reasonFromDialog(endReason: string): AcquireEndReason {
  switch (endReason) {
    case 'no-more-pages':
      return 'no-more-pages';
    case 'stagnant':
      return 'stagnant';
    case 'max-rounds':
      return 'page-budget';
    case 'stop-requested':
      return 'stopped';
    case 'shape-mismatch':
      return 'shape-mismatch';
    case 'blocked-response':
      return 'fetch-failed';
    case 'open-failed':
      return 'dialog-failed';
    default:
      return endReason.startsWith('sentinel:') ? 'sentinel-blocked' : 'dialog-failed';
  }
}

export interface AcquisitionDeps {
  pageReader: FollowersPageReader;
  store: KnowledgeStore;
  sentinel: Sentinel;
  /**
   * The direct-API fast path. When absent (or when a walk cannot fetch), the
   * dialog-scroll `pageReader` carries the scrape as before.
   */
  walker?: ListPageWalker;
  /** Tab + reader for the one-off pk-resolution profile fetch (seed bootstrap). */
  tab?: RimTab;
  reader?: Reader;
  /** Our own account pk (unused for edges here; reserved for symmetry with the rim). */
  ownPk?: string;
  clock?: Clock;
  cfg?: AcquisitionConfig;
}

export class AdapterBackedAcquisition implements FollowerAcquisition {
  private readonly pageReader: FollowersPageReader;
  private readonly store: KnowledgeStore;
  private readonly sentinel: Sentinel;
  private readonly walker?: ListPageWalker;
  private readonly tab?: RimTab;
  private readonly reader?: Reader;
  private readonly clock: Clock;
  private readonly cfg: AcquisitionConfig;

  constructor(deps: AcquisitionDeps) {
    this.pageReader = deps.pageReader;
    this.store = deps.store;
    this.sentinel = deps.sentinel;
    this.walker = deps.walker;
    this.tab = deps.tab;
    this.reader = deps.reader;
    this.clock = deps.clock ?? new SystemClock();
    this.cfg = deps.cfg ?? ACQUISITION_DEFAULTS;
  }

  async acquire(targetUsername: string): Promise<AcquireResult> {
    // Pre-check: bail before issuing anything if the account is already
    // blocked. A FAILURE reason, not a completion — an acquire that never ran
    // must not read as "this audience yielded nothing".
    const status = await this.sentinel.check();
    if (status !== 'ok') {
      logger.warn('rim.acquisition: sentinel blocked, skipping', { targetUsername, status });
      return { observed: 0, targetPk: null, endReason: 'sentinel-blocked' };
    }

    // (1) Resolve the pk without a request when possible; one profile-info
    // fetch (which is also the target's enrichment, giving the follower count
    // the coverage cap needs) only on first contact.
    let targetPk = this.store.pkByUsername(targetUsername);
    if (targetPk === null) targetPk = await this.resolvePkViaProfile(targetUsername);

    // (2)+(3)+(4) The direct cursor-resumed, demand-bounded walk.
    if (targetPk !== null && this.walker !== undefined) {
      const pk = targetPk;

      // Coverage cap: never scrape past `maxCoverageFraction` of the target's
      // audience across all acquires. `budget` is what remains of that cap after
      // the followers we already observed; <= 0 means we have taken our share, so
      // yield nothing and let the engine advance the chain.
      const budget = this.coverageBudget(pk);
      if (budget !== null && budget <= 0) {
        logger.info('rim.acquisition: coverage cap reached, not scraping further', {
          targetUsername,
          targetPk: pk,
          observed: this.store.observedFollowerCount(pk),
        });
        return { observed: 0, targetPk: pk, endReason: 'coverage-cap' };
      }
      // This run's new-pk demand is the smaller of the batch target and whatever
      // remains under the coverage cap.
      const maxNewPks =
        budget === null ? this.cfg.targetNewPks : Math.min(this.cfg.targetNewPks, budget);

      const startCursor = this.store.getScrapeCursor(pk);
      const walk = await this.walker.walkAll({
        pk,
        which: 'followers',
        startCursor,
        maxNewPks,
        maxPages: this.cfg.maxPages,
        // Caller-level newness: a follower whose edge into this target already
        // exists was counted by a PRIOR walk — the demand budget (derived from
        // the store-level coverage cap) must only spend on genuinely new rows,
        // and re-reading a fully-walked head stops after a few known-only pages.
        isKnown: (followerPk) => this.store.getEdge(followerPk, pk, 'follows') !== null,
        onObservation: (obs) => {
          this.store.observe(obs);
          // The pk is known up front — the follower→target edge is written the
          // moment the row arrives (no back-fill pass on this path).
          this.store.observeEdge(obs.accountPk, pk, 'follows', true, this.clock.now());
        },
        sentinel: this.sentinel,
      });
      if (walk.reason !== 'fetch-failed') {
        // Everything except a fetch failure keeps its resume cursor: the rows
        // observed up to the stop point are real, and the next walk resumes
        // exactly there (after a shape-mismatch, once the adapter is updated).
        this.store.setScrapeCursor(pk, walk.cursor, this.clock.now());
        const endReason = reasonFromWalk(walk.reason);
        logger.info('rim.acquisition: direct walk done', {
          targetUsername,
          targetPk: pk,
          observed: walk.pks.length,
          pages: walk.pages,
          reason: walk.reason,
          endReason,
          resumedFrom: startCursor,
          maxNewPks,
        });
        // Only a FETCH failure falls back to the dialog scrape below. A
        // shape-mismatch must not: the dialog path parses through the same
        // drifted extractor, so the fallback would burn a whole dialog scrape
        // to fabricate a second empty read. Sentinel/stop ends return as the
        // failures they are; genuine outcomes return as completions.
        return { observed: walk.pks.length, targetPk: pk, endReason };
      }
      logger.warn('rim.acquisition: direct walk failed, falling back to dialog scrape', {
        targetUsername,
        targetPk: pk,
        pages: walk.pages,
      });
    }

    // (5) Fallback: the dialog-scroll scrape (also the no-walker wiring path).
    return this.acquireViaDialog(targetUsername);
  }

  /**
   * How many MORE of a target's followers we may still observe under the
   * coverage cap: `floor(followers × maxCoverageFraction) − alreadyObserved`.
   * Returns `null` (uncapped) when the target's follower count is unknown — the
   * cap is a fraction of a total that has to exist to mean anything. A negative
   * or zero result means the cap is spent.
   */
  private coverageBudget(pk: string): number | null {
    const followers = this.store.getAccount(pk)?.followers;
    if (followers === undefined) return null;
    const cap = Math.floor(followers * this.cfg.maxCoverageFraction);
    return cap - this.store.observedFollowerCount(pk);
  }

  /**
   * One profile-info fetch to resolve a never-seen username to its pk. The
   * parsed observation is stored, so this doubles as the target's own
   * enrichment (follower/following counts, mutuals, privacy). Returns `null` —
   * with a warn, never a throw — when the fetch/parse fails; the dialog
   * fallback then derives the pk from the followers-list URL as before.
   */
  private async resolvePkViaProfile(targetUsername: string): Promise<string | null> {
    if (this.tab === undefined || this.reader === undefined) return null;
    let raw: unknown;
    try {
      raw = await this.tab.evaluate<unknown>(SURFACE.profileInfoScript(targetUsername));
    } catch (e) {
      logger.warn('rim.acquisition: pk-resolve fetch failed', {
        targetUsername,
        error: String(e),
      });
      return null;
    }
    const env = asFetchEnvelope(raw);
    if (env === null || !env.ok) {
      logger.warn('rim.acquisition: pk-resolve non-ok response', {
        targetUsername,
        status: env?.status ?? null,
      });
      return null;
    }
    const obs = this.reader.parseProfileInfo(env.json, this.clock.now());
    if (obs === null) {
      logger.warn('rim.acquisition: pk-resolve unparseable profile body', { targetUsername });
      return null;
    }
    this.store.observe(obs);
    return obs.accountPk;
  }

  /**
   * The pre-rework dialog-scroll scrape, now the fallback path. Folded review
   * fixes retained:
   *  - R1: follower→target edges use the pk `FollowersPageReader` derived from
   *        the followers-list URL, back-filled uniformly after the scrape.
   *  - R4: the final resume cursor is persisted per target via `setScrapeCursor`.
   *
   * The scrape's own end reason is mapped into the acquire taxonomy and
   * returned — a dialog that failed to open ('open-failed'), hit a wall, or
   * drifted must surface as a FAILURE, never as an `observed: 0` that reads
   * like genuine audience exhaustion.
   */
  private async acquireViaDialog(targetUsername: string): Promise<AcquireResult> {
    const result = await this.pageReader.collect({
      targetUsername,
      // Each observed account is written to the store as it arrives.
      onObservation: (obs) => {
        this.store.observe(obs);
      },
      sentinel: this.sentinel,
      maxRounds: this.cfg.maxRounds,
      noNewStop: this.cfg.noNewStop,
    });

    const now = this.clock.now();

    if (result.targetPk !== null) {
      for (const followerPk of result.observedPks) {
        this.store.observeEdge(followerPk, result.targetPk, 'follows', true, now);
      }
      // The dialog scrape always starts at the HEAD, so its cursor is shallower
      // than any deep resume point a prior direct walk persisted — never let the
      // fallback regress a target's saved position. Write only when none exists.
      if (this.store.getScrapeCursor(result.targetPk) === null) {
        this.store.setScrapeCursor(result.targetPk, result.cursor, now);
      }
    } else {
      logger.warn('rim.acquisition: target pk never resolved; edges/cursor not written', {
        targetUsername,
        observed: result.observedPks.length,
      });
    }

    const endReason = reasonFromDialog(result.endReason);
    logger.info('rim.acquisition: dialog scrape done', {
      targetUsername,
      observed: result.observedPks.length,
      targetPk: result.targetPk,
      reason: result.endReason,
      endReason,
    });
    return { observed: result.observedPks.length, targetPk: result.targetPk, endReason };
  }
}
