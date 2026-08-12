/**
 * AdapterBackedOwnFollowersSource — the live `OwnFollowersSource` port used by the
 * Follow-back Watcher (§2). It pages over OUR OWN followers, head-first.
 *
 * Implementation note (documented per the task's allowance): the shared
 * {@link FollowersPageReader} performs one ATOMIC bounded scrape (open dialog →
 * scroll rounds → drain), not a resumable single-increment scroll. A truly
 * incremental cross-call scroller is out of scope for this rim. So each SWEEP
 * (signalled by `nextPage(null)`) runs one bounded scrape from the top and caches
 * the head-first pks; successive `nextPage(cursor)` calls return successive slices
 * of that cache. This is correct for the Watcher, which only needs fresh pks per
 * call and stops itself as soon as a slice yields no new followers (its
 * incremental stop) or all pending follows resolve. The cursor is opaque — the
 * Watcher passes back whatever we return; a `null` cursor starts a new sweep.
 */

import type { RequestBudget } from '@/governors/request-budget';
import type { Sentinel } from '@/adapter/sentinel';
import type { KnowledgeStore } from '@/store/knowledge-store';
import type { OwnFollowersSource } from '@/engine/followback-watcher';
import type { FollowersPageReader } from '@/rim/followers-page-reader';
import * as logger from '@/utils/logger';

/** Bounded-sweep tuning. `pageSize` is how many head pks each `nextPage` returns. */
export interface OwnFollowersSourceConfig {
  maxRounds: number;
  noNewStop: number;
  pageSize: number;
}

export const OWN_FOLLOWERS_SOURCE_DEFAULTS: OwnFollowersSourceConfig = {
  maxRounds: 10,
  noNewStop: 2,
  pageSize: 50,
};

export interface OwnFollowersSourceDeps {
  pageReader: FollowersPageReader;
  ownUsername: string;
  budget: RequestBudget;
  sentinel: Sentinel;
  /**
   * When supplied, every parsed follower profile from the sweep is stored (f11):
   * the pages were parsed anyway, so this free data becomes real `accounts` rows
   * the chain's own-followers fallback target-source can rank. Optional so the
   * composition root can wire it without breaking construction; when omitted the
   * sweep still yields pks but discards the observations.
   */
  store?: KnowledgeStore;
  cfg?: OwnFollowersSourceConfig;
}

const chunk = <T>(items: T[], size: number): T[][] => {
  if (size <= 0) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

export class AdapterBackedOwnFollowersSource implements OwnFollowersSource {
  private readonly pageReader: FollowersPageReader;
  private readonly ownUsername: string;
  private readonly budget: RequestBudget;
  private readonly sentinel: Sentinel;
  private readonly store?: KnowledgeStore;
  private readonly cfg: OwnFollowersSourceConfig;

  /** Cached head-first slices of the current sweep; reset on each `nextPage(null)`. */
  private pages: string[][] = [];
  private index = 0;

  constructor(deps: OwnFollowersSourceDeps) {
    this.pageReader = deps.pageReader;
    this.ownUsername = deps.ownUsername;
    this.budget = deps.budget;
    this.sentinel = deps.sentinel;
    this.store = deps.store;
    this.cfg = deps.cfg ?? OWN_FOLLOWERS_SOURCE_DEFAULTS;
  }

  async nextPage(
    cursor: string | null,
  ): Promise<{ pks: string[]; cursor: string | null; hasMore: boolean }> {
    // A null cursor marks the start of a fresh sweep: re-scrape from the top.
    if (cursor === null) {
      this.pages = await this.sweep();
      this.index = 0;
    }

    const pks = this.pages[this.index] ?? [];
    this.index += 1;
    const hasMore = this.index < this.pages.length;
    // Encode our internal position as an opaque cursor the Watcher just echoes back.
    return { pks, cursor: hasMore ? `p${this.index}` : null, hasMore };
  }

  /** Run one bounded scrape of our own followers and slice it head-first. */
  private async sweep(): Promise<string[][]> {
    const status = await this.sentinel.check();
    if (status !== 'ok') {
      logger.warn('rim.own-followers-source: sentinel blocked, empty sweep', { status });
      return [];
    }
    const result = await this.pageReader.collect({
      targetUsername: this.ownUsername,
      // f11: the Watcher records the follows-us edges itself, but the parsed
      // follower profiles are free data — store them so the fallback target-source
      // has real `accounts` rows to rank. No-op when no store was injected.
      onObservation: (obs) => this.store?.observe(obs),
      budget: this.budget,
      sentinel: this.sentinel,
      maxRounds: this.cfg.maxRounds,
      noNewStop: this.cfg.noNewStop,
    });
    return chunk(result.observedPks, this.cfg.pageSize);
  }
}
