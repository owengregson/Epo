/**
 * AdapterBackedAcquisition — the live implementation of the `FollowerAcquisition`
 * port (§2/§6). Relocates the old inline `readFollowers` loop behind the port so
 * the Scanner/Engine and the manual IPC handler share ONE scraping implementation.
 *
 * It drives the shared {@link FollowersPageReader} to poach a target's followers,
 * writing each observation into the store and, once the target's pk is known,
 * recording a `follower → target (follows)` edge for every observed follower.
 *
 * Folded review fixes:
 *  - R1: the follower→target edges use the pk `FollowersPageReader` derived from
 *        the followers-list URL — never an optional profile-info request. Because
 *        the edges are written after the scrape completes, followers observed on
 *        pages that arrived BEFORE the pk resolved are back-filled uniformly.
 *  - R4: the final resume cursor is persisted per target via `setScrapeCursor`.
 */

import type { KnowledgeStore } from '@/store/knowledge-store';
import type { RequestBudget } from '@/governors/request-budget';
import type { Sentinel } from '@/adapter/sentinel';
import { SystemClock, type Clock } from '@/governors/clock';
import type { FollowerAcquisition } from '@/rim/types';
import type { FollowersPageReader } from '@/rim/followers-page-reader';
import * as logger from '@/utils/logger';

/** Bounded scrape tuning; a live read is always request- and round-bounded. */
export interface AcquisitionConfig {
  maxRounds: number;
  noNewStop: number;
}

export const ACQUISITION_DEFAULTS: AcquisitionConfig = {
  maxRounds: 5,
  noNewStop: 2,
};

export interface AcquisitionDeps {
  pageReader: FollowersPageReader;
  store: KnowledgeStore;
  budget: RequestBudget;
  sentinel: Sentinel;
  /** Our own account pk (unused for edges here; reserved for symmetry with the rim). */
  ownPk?: string;
  clock?: Clock;
  cfg?: AcquisitionConfig;
}

export class AdapterBackedAcquisition implements FollowerAcquisition {
  private readonly pageReader: FollowersPageReader;
  private readonly store: KnowledgeStore;
  private readonly budget: RequestBudget;
  private readonly sentinel: Sentinel;
  private readonly clock: Clock;
  private readonly cfg: AcquisitionConfig;

  constructor(deps: AcquisitionDeps) {
    this.pageReader = deps.pageReader;
    this.store = deps.store;
    this.budget = deps.budget;
    this.sentinel = deps.sentinel;
    this.clock = deps.clock ?? new SystemClock();
    this.cfg = deps.cfg ?? ACQUISITION_DEFAULTS;
  }

  async acquire(targetUsername: string): Promise<{ observed: number; targetPk: string | null }> {
    // Pre-check: bail before opening anything if the account is already blocked.
    const status = await this.sentinel.check();
    if (status !== 'ok') {
      logger.warn('rim.acquisition: sentinel blocked, skipping', { targetUsername, status });
      return { observed: 0, targetPk: null };
    }

    const result = await this.pageReader.collect({
      targetUsername,
      // Each observed account is written to the store as it arrives.
      onObservation: (obs) => {
        this.store.observe(obs);
      },
      budget: this.budget,
      sentinel: this.sentinel,
      maxRounds: this.cfg.maxRounds,
      noNewStop: this.cfg.noNewStop,
    });

    const now = this.clock.now();

    // R1: back-fill the follower→target edge for every observed follower using the
    // URL-derived pk. Observers seen before the pk resolved are covered uniformly.
    if (result.targetPk !== null) {
      for (const followerPk of result.observedPks) {
        this.store.observeEdge(followerPk, result.targetPk, 'follows', true, now);
      }
      // R4: persist the resume cursor so a later scrape can resume, not re-scroll.
      this.store.setScrapeCursor(result.targetPk, result.cursor, now);
    } else {
      logger.warn('rim.acquisition: target pk never resolved; edges/cursor not written', {
        targetUsername,
        observed: result.observedPks.length,
      });
    }

    logger.info('rim.acquisition: done', {
      targetUsername,
      observed: result.observedPks.length,
      targetPk: result.targetPk,
    });
    return { observed: result.observedPks.length, targetPk: result.targetPk };
  }
}
