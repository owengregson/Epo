import { MS_PER_DAY } from '../../timing/units';
import * as logger from '../../utils/logger';
import type { SqliteDriver } from '../driver/driver';
import type { FollowState } from '../types';
import type { AccountRepo } from './accounts';
import type { FollowRecordRepo } from './follow-records';
import type { MetaRepo } from './meta';
import type { RelationshipRepo } from './relationships';

/** What one {@link CensusRepo.reconcileOwnFollow} call did. */
export type ReconcileOutcome = 'noop' | 'dropped-queued' | 'dropped-held' | 'edge-only';

/**
 * Own-follower edges first seen within this window before a census verdict are
 * treated as discoveries of that census's OWN walk: the followers walk streams
 * each row into the graph as it parses (docs/PRINCIPLES.md §1), minutes to
 * hours before the census runs, so by census time the walk's rows are
 * indistinguishable from event-observed edges by anything but age. On the
 * FIRST census those discoveries are pre-existing stock, never growth.
 * Generous: no complete walk spans a day; the cost of over-covering is one day
 * of pre-census event gains absorbed as stock, exactly once.
 */
const FIRST_CENSUS_STOCK_WINDOW_MS = MS_PER_DAY;

/** States in which we believe WE own the follow relationship. */
/** Which side's ABSENCES a census proves; `true`/`false` speaks for both. */
export type CensusAuthority = boolean | { followers: boolean; following: boolean };

const HELD: readonly FollowState[] = ['pending_followback', 'followed_back', 'unfollow_queued'];

/**
 * The two write paths that span several tables at once: reconciling our own
 * follow-status against a fresh observation, and ingesting a whole prune-scan
 * census. Both are policy over the single-table repos, not SQL of their own.
 */
export class CensusRepo {
  constructor(
    private readonly db: SqliteDriver,
    private readonly accounts: AccountRepo,
    private readonly records: FollowRecordRepo,
    private readonly relationships: RelationshipRepo,
    private readonly meta: MetaRepo,
  ) {}

  /**
   * Reconcile our OWN follow-status toward `pk` against a fresh observation,
   * healing divergence an external actor caused (leave-alone policy). Never
   * writes an action_ledger row — reconciliation is not our action.
   */
  reconcileOwnFollow(ownPk: string, pk: string, weFollow: boolean, at: number): ReconcileOutcome {
    if (pk === ownPk) return 'noop'; // never reconcile self

    // Record the observed truth first — the edge is the ground state either way.
    this.relationships.observeEdge(ownPk, pk, 'follows', weFollow, at);

    const rec = this.records.get(pk);
    if (rec === null) return 'edge-only';

    if (HELD.includes(rec.state) && !weFollow) {
      // We believed we followed them and no longer do: an external actor
      // reverted the follow — back off rather than phantom-unfollow later.
      this.records.upsert({ ...rec, state: 'external' });
      this.accounts.setRole(pk, 'skipped');
      logger.info('store.reconcileOwnFollow: external unfollow detected, dropping held record', {
        pk,
        priorState: rec.state,
      });
      return 'dropped-held';
    }
    if (rec.state === 'queued' && weFollow) {
      // A queued candidate is already followed: the relationship belongs to an
      // external actor — never claim it (we would later unfollow THEIR follow).
      this.records.upsert({ ...rec, state: 'external' });
      this.accounts.setRole(pk, 'skipped');
      logger.info('store.reconcileOwnFollow: external follow detected, dropping queued candidate', {
        pk,
      });
      return 'dropped-queued';
    }
    return 'edge-only';
  }

  /**
   * Ingest a full auto-prune scan census into the shared graph, so a scan also
   * ENRICHES the growth engine (the two systems share one graph):
   *
   *  - every FOLLOWING pk is reconciled as one we currently follow, through the
   *    same leave-alone sink as {@link reconcileOwnFollow}, and
   *  - every FOLLOWER pk gets a fresh `follows-us` edge, so follow-back
   *    detection and net-growth see the whole census the scan already paid for.
   *
   * FACTS STREAM (docs/PRINCIPLES.md §1): the scan SOURCES already write each
   * row's profile and positive edge the moment it parses, so the additive half
   * below is an idempotent re-confirmation — it stays because alternate sources
   * may not stream, and re-observing is free. What genuinely BELONGS here is
   * the absence-based half: verdicts drawn from what a COMPLETE census did NOT
   * contain.
   *
   * ADDITIVE by default. When `authoritative` — passed ONLY for a census whose
   * walks both reported genuine completion — absence IS evidence, and the
   * census also heals the negative side:
   *
   *  - an active `pk → own` edge whose pk is NOT in the followers census is a
   *    follower we LOST → marked removed (this is what makes the net-growth
   *    series' loss branch live at all), and
   *  - an active `own → pk` edge whose pk is NOT in the following census is a
   *    follow that no longer exists → reconciled as not-following, EXCEPT
   *    records growth still HOLDS: an outstanding request to a private account
   *    never appears in the following list in any held state, and calling that
   *    "unfollowed" destroys the record and strands the request. Churn's own
   *    unfollow visit reads the true state instead.
   *
   * Authority is PER SIDE ({@link CensusAuthority}): a walk reports completion
   * and still misses rows (2,928 of 3,329 following, live 2026-08-31 — 361
   * follows declared gone and re-offered as candidates), so the caller grants
   * each side's absence verdict only on that side's own coverage.
   *
   * One transaction; self is always skipped.
   */
  ingest(
    ownPk: string,
    followingPks: string[],
    followerPks: string[],
    at: number,
    opts?: { authoritative?: CensusAuthority },
  ): void {
    const authority = opts?.authoritative ?? false;
    const proves =
      typeof authority === 'boolean' ? { followers: authority, following: authority } : authority;
    this.db.transaction(() => {
      for (const pk of followingPks) {
        if (pk === ownPk) continue;
        this.reconcileOwnFollow(ownPk, pk, true, at);
      }
      for (const pk of followerPks) {
        if (pk === ownPk) continue;
        this.relationships.observeEdge(pk, ownPk, 'follows', true, at);
      }

      if (proves.followers) {
        // Followers we lost: active pk→own edges absent from the complete census.
        const followerSet = new Set(followerPks);
        for (const pk of this.relationships.activeFollowerPks(ownPk)) {
          if (pk === ownPk || followerSet.has(pk)) continue;
          this.relationships.observeEdge(pk, ownPk, 'follows', false, at);
        }
      }
      if (proves.following) {
        // Follows that no longer exist: active own→pk edges absent from the
        // complete census — records growth still holds excepted.
        const followingSet = new Set(followingPks);
        for (const pk of this.relationships.activeFollowingPks(ownPk)) {
          if (pk === ownPk || followingSet.has(pk)) continue;
          const state = this.records.get(pk)?.state;
          if (state !== undefined && HELD.includes(state)) continue;
          this.reconcileOwnFollow(ownPk, pk, false, at);
        }
      }

      this.drawStockBoundary(ownPk, followerPks.length, at);
    });
  }

  /**
   * The FIRST complete census draws the stock/growth boundary WITHOUT erasing
   * growth observed before it (follow events stream from the notifications feed
   * long before a user's first scan). Same transaction, set-once marker:
   *
   *  - The BASELINE, when none exists yet, lands at the census time — but never
   *    above growth already observed: an own-follower edge first seen BEFORE
   *    this census's walk window pushes the baseline to just below that edge
   *    (defense in depth for a collection path that forgot to anchor one).
   *  - The census's own discoveries — edges first seen inside the walk window,
   *    whether streamed by the walk or bulk-written above — are pre-existing
   *    STOCK wherever the baseline sits, so they are re-dated onto it and the
   *    strictly-after growth filter can never chart initial stock as a cliff.
   *
   * Later censuses skip all of this: the baseline is set-once, and a follower a
   * later census discovers is a genuine (event-less) gain on its census day.
   */
  private drawStockBoundary(ownPk: string, followerCount: number, at: number): void {
    if (this.meta.get('followersCensusAt') !== null) return;
    const stockWindowStart = at - FIRST_CENSUS_STOCK_WINDOW_MS;
    let baselineAt = this.relationships.baselineAt();
    if (baselineAt === null) {
      const earliest = this.relationships.edgesFirstSeenBefore(ownPk, stockWindowStart);
      baselineAt = earliest === null ? at : Math.min(at, earliest - 1);
      this.meta.setOnce('followersBaselineAt', String(baselineAt));
      logger.info('store: followers baseline established by first census', {
        baselineAt,
        censusAt: at,
        followers: followerCount,
      });
    }
    this.relationships.redateStockOntoBaseline(ownPk, baselineAt, stockWindowStart, at);
    this.meta.setOnce('followersCensusAt', String(at));
  }
}
