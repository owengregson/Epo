/**
 * AdapterBackedOwnFollowingSource — the live own-following port used by the
 * auto-prune routine (Phase 5). It scrapes OUR OWN FOLLOWING list — every
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

import type { RequestBudget } from '@/governors/request-budget';
import type { Sentinel } from '@/adapter/sentinel';
import type { KnowledgeStore } from '@/store/knowledge-store';
import type { PruneOwnFollowing, PruneScanOpts } from '@/engine/prune-engine';
import type { FollowersPageReader } from '@/rim/followers-page-reader';
import * as logger from '@/utils/logger';

/** Bounded-sweep tuning. Prune walks the ENTIRE list, so rounds run generous. */
export interface OwnFollowingSourceConfig {
  maxRounds: number;
  noNewStop: number;
}

export const OWN_FOLLOWING_SOURCE_DEFAULTS: OwnFollowingSourceConfig = {
  maxRounds: 60,
  noNewStop: 3,
};

export interface OwnFollowingSourceDeps {
  pageReader: FollowersPageReader;
  ownUsername: string;
  budget: RequestBudget;
  sentinel: Sentinel;
  /**
   * When supplied, every parsed following profile is stored: the pages were
   * parsed anyway, and the PruneEngine reads candidate usernames back out of
   * these `accounts` rows. Optional so construction never breaks; when omitted
   * the scrape still yields pks but discards the observations.
   */
  store?: KnowledgeStore;
  cfg?: OwnFollowingSourceConfig;
}

export class AdapterBackedOwnFollowingSource implements PruneOwnFollowing {
  private readonly pageReader: FollowersPageReader;
  private readonly ownUsername: string;
  private readonly budget: RequestBudget;
  private readonly sentinel: Sentinel;
  private readonly store?: KnowledgeStore;
  private readonly cfg: OwnFollowingSourceConfig;

  constructor(deps: OwnFollowingSourceDeps) {
    this.pageReader = deps.pageReader;
    this.ownUsername = deps.ownUsername;
    this.budget = deps.budget;
    this.sentinel = deps.sentinel;
    this.store = deps.store;
    this.cfg = deps.cfg ?? OWN_FOLLOWING_SOURCE_DEFAULTS;
  }

  /**
   * One bounded scrape of our own FOLLOWING list. Returns every pk observed
   * (with usernames persisted into the store when one was injected). A blocked
   * sentinel yields an empty, warned result — never a throw. The PruneEngine's
   * scan opts (cooperative `shouldStop` + jittered inter-round pacing) are
   * threaded straight into the scrape so a scan is interruptible and paced.
   */
  async fetchAllPks(opts?: PruneScanOpts): Promise<string[]> {
    const status = await this.sentinel.check();
    if (status !== 'ok') {
      logger.warn('rim.own-following-source: sentinel blocked, empty scrape', { status });
      return [];
    }
    const result = await this.pageReader.collect({
      dialog: 'following',
      targetUsername: this.ownUsername,
      onObservation: (obs) => this.store?.observe(obs),
      budget: this.budget,
      sentinel: this.sentinel,
      maxRounds: this.cfg.maxRounds,
      noNewStop: this.cfg.noNewStop,
      shouldStop: opts?.shouldStop,
      scrollMinMs: opts?.scrollMinMs,
      scrollMaxMs: opts?.scrollMaxMs,
    });
    return result.observedPks;
  }
}
