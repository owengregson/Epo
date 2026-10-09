/**
 * AdapterBackedOwnFollowingSource — the live own-following port used by the
 * auto-prune routine. It scrapes OUR OWN FOLLOWING list — every
 * account we currently follow — in one bounded pass.
 *
 * Mirrors `AdapterBackedOwnFollowersSource` but opens the FOLLOWING dialog
 * (via the shared {@link FollowersPageReader}'s `dialog: 'following'` route),
 * so the paginated `following/` API is what gets parsed. Unlike the follow-back
 * Watcher's head-first paging source, prune needs the WHOLE list at once, so
 * this exposes a single `fetchAllPks()` rather than `nextPage`.
 *
 * Every parsed profile is observed into the store (when injected), so the
 * usernames the PruneEngine needs for `unfollow(username)` are real `accounts`
 * rows by the time candidates are computed.
 */

import type { Sentinel } from '@/adapter/sentinel';
import type { PruneOwnFollowing, PruneScanFetch, PruneScanOpts } from '@/engine/prune-engine';
import type { FollowersPageReader } from '@/rim/followers-page-reader';
import type { ListPageWalker } from '@/rim/list-page-walker';
import { walkOwnList } from '@/rim/walk-own-list';
import type { KnowledgeStore } from '@/store/knowledge-store';
import type { Observation } from '@/store/types';
import { RIM } from '@/timing/config';

/** Bounded-sweep tuning. Prune walks the ENTIRE list, so rounds run generous. */
export interface OwnFollowingSourceConfig {
  maxRounds: number;
  noNewStop: number;
}

// A whole-list walk must be bounded by the LIST, not the round cap: pages carry
// ~12 accounts, so a few thousand followers need hundreds of rounds. The real
// terminators are `hasMore === false` and the stagnant-round stop; `maxRounds`
// is only the runaway bound. `noNewStop` at 5 tolerates a few slow pages
// (throttled responses landing after the round's wait) without reading the lull
// as end-of-list.
export const OWN_FOLLOWING_SOURCE_DEFAULTS: OwnFollowingSourceConfig = {
  maxRounds: RIM.FETCH_ALL_MAX_ROUNDS,
  noNewStop: RIM.FETCH_ALL_NO_NEW_STOP,
};

export interface OwnFollowingSourceDeps {
  pageReader: FollowersPageReader;
  ownUsername: string;
  sentinel: Sentinel;
  /**
   * When supplied, every parsed following profile is stored: the pages were
   * parsed anyway, and the PruneEngine reads candidate usernames back out of
   * these `accounts` rows. Optional so construction never breaks; when omitted
   * the scrape still yields pks but discards the observations.
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
  cfg?: OwnFollowingSourceConfig;
}

export class AdapterBackedOwnFollowingSource implements PruneOwnFollowing {
  private readonly pageReader: FollowersPageReader;
  private readonly ownUsername: string;
  private readonly sentinel: Sentinel;
  private readonly store?: KnowledgeStore;
  private readonly walker?: ListPageWalker;
  private readonly ownPk?: string;
  private readonly cfg: OwnFollowingSourceConfig;

  constructor(deps: OwnFollowingSourceDeps) {
    this.pageReader = deps.pageReader;
    this.ownUsername = deps.ownUsername;
    this.sentinel = deps.sentinel;
    this.store = deps.store;
    this.walker = deps.walker;
    this.ownPk = deps.ownPk;
    this.cfg = deps.cfg ?? OWN_FOLLOWING_SOURCE_DEFAULTS;
  }

  /**
   * One bounded scrape of our own FOLLOWING list. Returns every pk observed
   * (with usernames persisted into the store when one was injected). A blocked
   * sentinel yields an empty, warned result — never a throw. The PruneEngine's
   * scan opts (cooperative `shouldStop` + jittered inter-round pacing) are
   * threaded straight into the scrape so a scan is interruptible and paced.
   *
   * Fast path: a wired {@link ListPageWalker} pages the API directly (full
   * page size); the dialog-scroll scrape below is the fallback when the direct
   * walk can't fetch. Either way the coverage guard in the PruneEngine judges
   * the result against the profile-header count.
   */
  async fetchAllPks(opts?: PruneScanOpts): Promise<PruneScanFetch> {
    return walkOwnList({
      which: 'following',
      label: 'rim.own-following-source',
      ownUsername: this.ownUsername,
      sentinel: this.sentinel,
      pageReader: this.pageReader,
      walker: this.walker,
      ownPk: this.ownPk,
      bounds: this.cfg,
      onRow: (obs) => this.ingestRow(obs),
      opts,
    });
  }

  /**
   * FACTS STREAM (docs/PRINCIPLES.md §1): every parsed following row lands in
   * the store the moment it is observed — the account profile AND the
   * we-follow-them relationship (via the reconciling sink, which also heals
   * drift like a still-queued candidate we already follow). An aborted or
   * truncated walk keeps everything it saw; only absence-based VERDICTS (the
   * census's gone-follow reconciliation, the candidate set) wait for the
   * completeness gate.
   */
  private ingestRow(obs: Observation): void {
    if (this.store === undefined) return;
    this.store.observe(obs);
    if (this.ownPk !== undefined && obs.accountPk !== this.ownPk) {
      this.store.reconcileOwnFollow(obs.accountPk, true, obs.observedAt);
    }
  }
}
