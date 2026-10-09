/**
 * AdapterBackedOwnFollowersSource — the prune scan's whole-followers-list
 * scraper (the {@link PruneOwnFollowers} port).
 *
 * A thin binding: {@link walkOwnList} runs the census (sentinel gate → direct
 * API walk → dialog fallback → completeness verdict); this class supplies which
 * list to walk and what each row means to the store.
 */

import type { Sentinel } from '@/adapter/sentinel';
import type { PruneOwnFollowers, PruneScanFetch, PruneScanOpts } from '@/engine/prune-engine';
import type { FollowersPageReader } from '@/rim/followers-page-reader';
import type { ListPageWalker } from '@/rim/list-page-walker';
import { walkOwnList } from '@/rim/walk-own-list';
import type { KnowledgeStore } from '@/store/knowledge-store';
import type { Observation } from '@/store/types';
import { RIM } from '@/timing/config';

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
   * When supplied, every parsed follower profile from the scrape is stored:
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
   * The prune scan's whole-list census (the {@link PruneOwnFollowers} port):
   * one bounded walk of our ENTIRE followers list, with the engine's scan opts
   * (cooperative `shouldStop`, jittered pacing, live progress) threaded through.
   * Generous bounds ({@link OWN_FOLLOWERS_FETCH_ALL_BOUNDS}) and interruptible
   * between rounds. A blocked sentinel yields an INCOMPLETE, warned result —
   * never a throw and never a "complete" empty list.
   */
  async fetchAllPks(opts?: PruneScanOpts): Promise<PruneScanFetch> {
    return walkOwnList({
      which: 'followers',
      label: 'rim.own-followers-source',
      ownUsername: this.ownUsername,
      sentinel: this.sentinel,
      pageReader: this.pageReader,
      walker: this.walker,
      ownPk: this.ownPk,
      bounds: OWN_FOLLOWERS_FETCH_ALL_BOUNDS,
      onRow: (obs) => this.ingestRow(obs),
      opts,
    });
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
