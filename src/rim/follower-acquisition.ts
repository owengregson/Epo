/**
 * AdapterBackedAcquisition — the live implementation of the `FollowerAcquisition`
 * port (§2/§6). One scraping implementation shared by the Scanner/Engine refill
 * and the manual IPC handler.
 *
 * Request-efficiency design (the polling rework):
 *
 *  1. RESOLVE, don't scrape: the target pk comes from the store when we have
 *     ever seen the username; only a never-seen target (the seed's first
 *     contact) costs ONE profile visit — which doubles as the target's
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
 *     (`fetch-failed`), the dialog-scroll scrape
 *     ({@link FollowersPageReader}) runs instead — same degradation contract
 *     as the prune scan's census path. A `shape-mismatch` walk does NOT fall
 *     back (the dialog parses through the same drifted extractor); it — like
 *     every end — surfaces on the result as a typed {@link AcquireEndReason},
 *     so callers can tell a failed read from genuine audience exhaustion.
 *
 * Edges (`follower → target (follows)`) are written as each observation
 * arrives on BOTH paths (docs/PRINCIPLES.md §1): the direct walk knows the pk
 * before the first page, and the dialog fallback is handed it the moment the
 * first list URL names it. Each path persists its own resume cursor.
 */

import type { Sentinel } from '@/adapter/sentinel';
import { EXPLORATION_POLICY } from '@/engine/exploration-policy';
import { type Clock, SystemClock } from '@/governors/clock';
import type { ReadBudget } from '@/governors/read-budget';
import type { FollowersPageReader } from '@/rim/followers-page-reader';
import type { ListPageWalker } from '@/rim/list-page-walker';
import type { ProfileVisitor } from '@/rim/profile-visit-port';
import type { FollowerAcquisition } from '@/rim/types';
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
  /**
   * Dialog-scroll FALLBACK pacing band (uniform per-round draw). Optional so
   * existing config literals keep compiling; absent falls back to
   * `RIM.ACQUIRE_SCROLL_{MIN,MAX}_MS` — never to the page reader's fixed
   * metronome (the timing-noise layer removed that path's only bound-less
   * call site).
   */
  scrollMinMs?: number;
  scrollMaxMs?: number;
}

export const ACQUISITION_DEFAULTS: AcquisitionConfig = {
  // A source visit starts with two pages; durable read and visit budgets bound
  // repeated slices. Stored unscored candidates are reused before further reads.
  targetNewPks: EXPLORATION_POLICY.rowsPerSlice,
  maxPages: EXPLORATION_POLICY.pagesPerSlice,
  maxCoverageFraction: 0.5,
  maxRounds: EXPLORATION_POLICY.pagesPerSlice,
  noNewStop: RIM.ACQUIRE_NO_NEW_STOP,
  scrollMinMs: RIM.ACQUIRE_SCROLL_MIN_MS,
  scrollMaxMs: RIM.ACQUIRE_SCROLL_MAX_MS,
};

export type { AcquireEndReason, AcquireResult } from './acquisition-result';
export { ACQUIRE_FAILURE_REASONS, isAcquireFailure } from './acquisition-result';

import { type AcquireResult, reasonFromDialog, reasonFromWalk } from './acquisition-result';

export interface AcquisitionDeps {
  onProgress?: (phase: string) => void;
  readBudget?: ReadBudget;
  pageReader: FollowersPageReader;
  store: KnowledgeStore;
  sentinel: Sentinel;
  /**
   * The direct-API fast path. When absent (or when a walk cannot fetch), the
   * dialog-scroll `pageReader` carries the scrape as before.
   */
  walker?: ListPageWalker;
  /** The one-off pk-resolution profile VISIT on first contact (seed bootstrap). */
  visitor?: ProfileVisitor;
  /** Our own account pk (unused for edges here; reserved for symmetry with the rim). */
  ownPk?: string;
  clock?: Clock;
  cfg?: AcquisitionConfig;
}

export class AdapterBackedAcquisition implements FollowerAcquisition {
  private readonly onProgress?: (phase: string) => void;
  private readonly readBudget?: ReadBudget;
  private readResumeAt: number | null = null;
  private readonly pageReader: FollowersPageReader;
  private readonly store: KnowledgeStore;
  private readonly sentinel: Sentinel;
  private readonly walker?: ListPageWalker;
  private readonly visitor?: ProfileVisitor;
  private readonly clock: Clock;
  private readonly cfg: AcquisitionConfig;

  constructor(deps: AcquisitionDeps) {
    this.onProgress = deps.onProgress;
    this.readBudget = deps.readBudget;
    this.pageReader = deps.pageReader;
    this.store = deps.store;
    this.sentinel = deps.sentinel;
    this.walker = deps.walker;
    this.visitor = deps.visitor;
    this.clock = deps.clock ?? new SystemClock();
    this.cfg = deps.cfg ?? ACQUISITION_DEFAULTS;
  }

  async acquire(targetUsername: string): Promise<AcquireResult> {
    this.readResumeAt = null;
    // Pre-check: bail before issuing anything if the account is already
    // blocked. A FAILURE reason, not a completion — an acquire that never ran
    // must not read as "this audience yielded nothing".
    const status = await this.sentinel.check();
    if (status !== 'ok') {
      logger.warn('rim.acquisition: sentinel blocked, skipping', { targetUsername, status });
      return { observed: 0, targetPk: null, endReason: 'sentinel-blocked' };
    }

    // (1) Resolve the pk without a request when possible; one profile visit
    // (which is also the target's enrichment, giving the follower count the
    // coverage cap needs) only on first contact.
    let targetPk = this.store.pkByUsername(targetUsername);
    if (targetPk === null) targetPk = await this.resolvePkViaProfile(targetUsername);
    if (this.readResumeAt !== null) return { observed: 0, targetPk, endReason: 'read-budget', retryAt: this.readResumeAt };
    // Counts/privacy used for source decisions must not remain frozen across absences.
    if (targetPk !== null && this.visitor !== undefined) {
      const account = this.store.getAccount(targetPk);
      const observedAt = account?.statsObservedAt;
      if (observedAt !== undefined && this.clock.now() - observedAt >= EXPLORATION_POLICY.profileFreshMs) {
        const permit = this.readBudget?.consume('profile');
        if (permit !== undefined && !permit.allowed) return { observed: 0, targetPk, endReason: 'read-budget', retryAt: permit.resumeAt ?? undefined };
        const visit = await this.visitor.visit(targetUsername);
        if (!visit.ok) return { observed: 0, targetPk, endReason: 'fetch-failed' };
        this.onProgress?.('source-profile-refreshed');
      }
    }

    // (2)+(3)+(4) The direct cursor-resumed, demand-bounded walk.
    if (targetPk !== null && this.walker !== undefined) {
      const pk = targetPk;
      const cursorState = this.store.getScrapeCursorState(pk);
      const refreshDue = cursorState !== null && this.clock.now() - cursorState.updatedAt >= EXPLORATION_POLICY.endedRevisitMs;

      // Coverage cap: never scrape past `maxCoverageFraction` of the target's
      // audience across all acquires. `budget` is what remains of that cap after
      // the followers we already observed; <= 0 means we have taken our share, so
      // yield nothing and let the engine advance the chain.
      const budget = refreshDue ? null : this.coverageBudget(pk);
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

      const startCursor = refreshDue ? null : this.store.getScrapeCursor(pk);
      let globallyNew = 0;
      const walk = await this.walker.walkAll({
        pk,
        which: 'followers',
        readPurpose: 'exploration',
        startCursor,
        maxNewPks,
        maxPages: this.cfg.maxPages,
        // Caller-level newness: a follower whose edge into this target already
        // exists was counted by a PRIOR walk — the demand budget (derived from
        // the store-level coverage cap) must only spend on genuinely new rows,
        // and re-reading a fully-walked head stops after a few known-only pages.
        isKnown: (followerPk) => this.store.getEdge(followerPk, pk, 'follows') !== null,
        onObservation: (obs) => {
          if (this.store.getAccount(obs.accountPk) === null) globallyNew += 1;
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
        if (walk.pages > 0) this.store.setScrapeCursor(pk, walk.cursor, this.clock.now());
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
        return { observed: walk.pks.length, targetPk: pk, endReason, globallyNew,
          ...(walk.retryAt === undefined ? {} : { retryAt: walk.retryAt }) };
      }
      logger.warn('rim.acquisition: direct walk failed, falling back to dialog scrape', {
        targetUsername,
        targetPk: pk,
        pages: walk.pages,
      });
    }

    // (5) Fallback: the dialog-scroll scrape (also the no-walker wiring path).
    return this.acquireViaDialog(targetUsername, targetPk);
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
   * One profile VISIT to resolve a never-seen username to its pk. The page's
   * own profile body is written to the store by the ProfileObserver before the
   * visit resolves, so this doubles as the target's enrichment (counts,
   * mutuals, privacy) and the coverage cap reads it next. Returns `null` — with
   * a warn, never a throw — when the visit fails; the dialog fallback then
   * derives the pk from the followers-list URL as before.
   */
  private async resolvePkViaProfile(targetUsername: string): Promise<string | null> {
    if (this.visitor === undefined) return null;
    const permit = this.readBudget?.consume('profile');
    if (permit !== undefined && !permit.allowed) {
      this.readResumeAt = permit.resumeAt;
      return null;
    }
    const visit = await this.visitor.visit(targetUsername);
    if (!visit.ok) {
      logger.warn('rim.acquisition: pk-resolve visit failed', { kind: visit.kind, ...visit.detail });
      return null;
    }
    this.onProgress?.('source-profile-resolved');
    return visit.obs.accountPk;
  }

  /**
   * The dialog-scroll scrape — the fallback path when the direct walk cannot
   * fetch. `knownPk` is the target's pk when `acquire` already resolved it.
   *
   * Facts stream (§1): both the account row AND its follower→target edge are
   * written the moment the row arrives. When the pk was not known up front the
   * reader hands it over as soon as the first list URL names it — before that
   * page's rows parse — so an aborted scrape never loses an edge it paid for.
   * The final resume cursor is persisted per target via `setScrapeCursor`.
   *
   * The scrape's own end reason is mapped into the acquire taxonomy and
   * returned — a dialog that failed to open ('open-failed'), hit a wall, or
   * drifted must surface as a FAILURE, never as an `observed: 0` that reads
   * like genuine audience exhaustion.
   */
  private async acquireViaDialog(
    targetUsername: string,
    knownPk: string | null,
  ): Promise<AcquireResult> {
    let edgePk = knownPk;
    const result = await this.pageReader.collect({
      targetUsername,
      readPurpose: 'exploration',
      onTargetPk: (pk) => {
        edgePk = pk;
      },
      onObservation: (obs) => {
        this.store.observe(obs);
        // The target's OWN profile-info observation carries no edge.
        if (edgePk !== null && obs.accountPk !== edgePk) {
          this.store.observeEdge(obs.accountPk, edgePk, 'follows', true, this.clock.now());
        }
      },
      sentinel: this.sentinel,
      maxRounds: this.cfg.maxRounds,
      noNewStop: this.cfg.noNewStop,
      // Jittered per-round pacing (timing-noise layer): passing the band routes
      // the reader onto its uniform branch — without it this was the one call
      // site pacing every scroll at the fixed 2 s metronome.
      scrollMinMs: this.cfg.scrollMinMs ?? RIM.ACQUIRE_SCROLL_MIN_MS,
      scrollMaxMs: this.cfg.scrollMaxMs ?? RIM.ACQUIRE_SCROLL_MAX_MS,
    });

    const now = this.clock.now();
    const pk = result.targetPk ?? edgePk;

    if (pk !== null) {
      // The dialog scrape always starts at the HEAD, so its cursor is shallower
      // than any deep resume point a prior direct walk persisted — never let the
      // fallback regress a target's saved position. Write only when none exists.
      if (this.store.getScrapeCursor(pk) === null) {
        this.store.setScrapeCursor(pk, result.cursor, now);
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
      targetPk: pk,
      reason: result.endReason,
      endReason,
    });
    return { observed: result.observedPks.length, targetPk: pk, endReason,
      ...(result.retryAt === undefined ? {} : { retryAt: result.retryAt }) };
  }
}
