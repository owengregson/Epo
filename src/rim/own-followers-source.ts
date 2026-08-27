/**
 * AdapterBackedOwnFollowersSource — the prune scan's whole-followers-list
 * scraper (the {@link PruneOwnFollowers} port).
 *
 * Historical note: this class also used to serve the Follow-back Watcher's
 * paged head-first sweep (`nextPage`). The watcher now reads the NOTIFICATIONS
 * feed instead (`src/rim/follow-notifications.ts` — one click, one request),
 * so only the prune census path remains here.
 */

import type { Sentinel } from '@/adapter/sentinel';
import type { PruneOwnFollowers, PruneScanFetch, PruneScanOpts } from '@/engine/prune-engine';
import type { FollowersPageReader } from '@/rim/followers-page-reader';
import type { ListPageWalker } from '@/rim/list-page-walker';
import type { KnowledgeStore } from '@/store/knowledge-store';
import type { Observation } from '@/store/types';
import { RIM } from '@/timing/config';
import * as logger from '@/utils/logger';

/**
 * Bounds for {@link AdapterBackedOwnFollowersSource.fetchAllPks} — the prune
 * scan's WHOLE-list walk. Deliberately separate from (and more generous than)
 * the watcher's head-first sweep `cfg`, mirroring the own-following source's
 * defaults: prune needs the entire followers list, not just the head.
 */
export const OWN_FOLLOWERS_FETCH_ALL_BOUNDS = {
  // Sized for real accounts: pages carry ~12 accounts, so thousands of
  // followers need hundreds of rounds — `hasMore`/stagnation terminate the
  // walk, `maxRounds` is only the runaway bound (see the own-following source).
  maxRounds: RIM.FETCH_ALL_MAX_ROUNDS,
  noNewStop: RIM.FETCH_ALL_NO_NEW_STOP,
} as const;

export interface OwnFollowersSourceDeps {
  pageReader: FollowersPageReader;
  ownUsername: string;
  sentinel: Sentinel;
  /**
   * When supplied, every parsed follower profile from the scrape is stored (f11):
   * the pages were parsed anyway, so this free data becomes real `accounts` rows
   * the chain's own-followers fallback target-source can rank. Optional so the
   * composition root can wire it without breaking construction; when omitted the
   * scrape still yields pks but discards the observations.
   */
  store?: KnowledgeStore;
  /**
   * The FAST scan path: when both a walker and our own pk are supplied,
   * `fetchAllPks` pages the friendships API directly (full API page size, ~4×
   * the dialog's scroll batches) and only falls back to the dialog-scroll
   * scrape when the direct walk cannot fetch at all.
   */
  walker?: ListPageWalker;
  ownPk?: string;
}

export class AdapterBackedOwnFollowersSource implements PruneOwnFollowers {
  private readonly pageReader: FollowersPageReader;
  private readonly ownUsername: string;
  private readonly sentinel: Sentinel;
  private readonly store?: KnowledgeStore;
  private readonly walker?: ListPageWalker;
  private readonly ownPk?: string;

  constructor(deps: OwnFollowersSourceDeps) {
    this.pageReader = deps.pageReader;
    this.ownUsername = deps.ownUsername;
    this.sentinel = deps.sentinel;
    this.store = deps.store;
    this.walker = deps.walker;
    this.ownPk = deps.ownPk;
  }

  /**
   * Phase 5 — the prune scan's whole-list scrape (the {@link PruneOwnFollowers}
   * port): one bounded walk of our ENTIRE followers list through the shared
   * page reader, with the engine's scan opts (cooperative `shouldStop` +
   * jittered inter-round pacing) threaded straight into the scroll loop.
   * Generous bounds ({@link OWN_FOLLOWERS_FETCH_ALL_BOUNDS}) and interruptible
   * between rounds. A blocked sentinel yields an empty, warned result — never
   * a throw.
   */
  async fetchAllPks(opts?: PruneScanOpts): Promise<PruneScanFetch> {
    const status = await this.sentinel.check();
    if (status !== 'ok') {
      // THE dangerous direction: an empty followers list read as complete
      // would make every account we follow an unfollow candidate. Incomplete.
      logger.warn('rim.own-followers-source: sentinel blocked, incomplete scrape', { status });
      return { pks: [], complete: false, reason: `sentinel:${status}` };
    }
    // Fast path: direct API pagination (full page size); the dialog-scroll
    // scrape below remains the fallback when the direct walk can't fetch.
    if (this.walker !== undefined && this.ownPk !== undefined) {
      const walk = await this.walker.walkAll({
        pk: this.ownPk,
        which: 'followers',
        onObservation: (obs) => this.ingestRow(obs),
        sentinel: this.sentinel,
        pageMinMs: opts?.scrollMinMs,
        pageMaxMs: opts?.scrollMaxMs,
        shouldStop: opts?.shouldStop,
        onProgress: opts?.onProgress,
      });
      if (walk.reason !== 'fetch-failed') {
        return { pks: walk.pks, complete: walk.complete, reason: walk.reason };
      }
      logger.warn('rim.own-followers-source: direct page walk failed, falling back to dialog', {
        pages: walk.pages,
        observed: walk.pks.length,
      });
    }
    const result = await this.pageReader.collect({
      dialog: 'followers',
      targetUsername: this.ownUsername,
      onObservation: (obs) => this.ingestRow(obs),
      sentinel: this.sentinel,
      maxRounds: OWN_FOLLOWERS_FETCH_ALL_BOUNDS.maxRounds,
      noNewStop: OWN_FOLLOWERS_FETCH_ALL_BOUNDS.noNewStop,
      shouldStop: opts?.shouldStop,
      scrollMinMs: opts?.scrollMinMs,
      scrollMaxMs: opts?.scrollMaxMs,
      onProgress: opts?.onProgress,
      // Prune semantics: an unopened dialog must FAIL the scan — an empty
      // followers read would mark every followed account a candidate.
      throwOnOpenFailure: true,
    });
    return {
      pks: result.observedPks,
      complete: result.endReason === 'no-more-pages',
      reason: result.endReason,
    };
  }

  /**
   * FACTS STREAM (docs/PRINCIPLES.md §1): every parsed follower row lands in
   * the store the moment it is observed — the account profile AND its
   * follows-us edge — so an aborted or truncated walk still leaves everything
   * it saw in the graph (follow-back detection's zero-request pass reads these
   * edges). Only absence-based VERDICTS (the census's lost-follower marking,
   * the candidate set) wait for the completeness gate.
   */
  private ingestRow(obs: Observation): void {
    if (this.store === undefined) return;
    this.store.observe(obs);
    if (this.ownPk !== undefined && obs.accountPk !== this.ownPk) {
      this.store.observeEdge(obs.accountPk, this.ownPk, 'follows', true, obs.observedAt);
    }
  }
}
