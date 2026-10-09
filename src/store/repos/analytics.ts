import { startOfLocalDay } from '../../timing/units';
import * as logger from '../../utils/logger';
import type { SqliteDriver } from '../driver/driver';
import {
  FOLLOW_STATES,
  type FollowbackTiming,
  type FollowState,
  type GraphAccountRow,
  type GraphCrowdRow,
  type GraphHubRow,
  type GraphRecordRow,
  type TargetFunnelRead,
} from '../types';

/** Yield statistics for one poaching session. */
export interface TargetYield {
  total: number;
  followedBack: number;
  followBackRate: number;
  poolSize: number;
  mutualOverlap: number;
}

/** One point of the cumulative net-growth series. */
export interface GrowthPoint {
  dayStartMs: number;
  cumulativeNet: number;
}

/**
 * Read-only analysis over the graph: yields, funnels, follow-back latency, the
 * growth series, and the Graph view's bulk source rows.
 *
 * Nothing here writes, and nothing here is a stored aggregate — "analysis is
 * an emergent query" is the whole point, so a new derived number is a SELECT,
 * never a column that can go stale.
 */
export class AnalyticsRepo {
  constructor(
    private readonly db: SqliteDriver,
    /** The stock/growth boundary; growth reads count only events strictly after it. */
    private readonly baselineAt: () => number | null,
  ) {}

  /**
   * Yield for a poaching session against `targetPk`, from follow_records + edges.
   *
   * - `total`: records aimed at the target that reached at least the
   *   pending-followback stage (i.e. we actually followed the candidate).
   * - `followedBack`: of those, the ones that reciprocated.
   * - `poolSize`: active followers of the target (the raw poaching pool).
   * - `mutualOverlap`: target-followers we ALREADY actively follow.
   */
  targetYield(targetPk: string, ownPk: string): TargetYield {
    const counts = this.db
      .prepare(
        `SELECT COUNT(*) AS total, COUNT(followed_back_at) AS followed_back
         FROM follow_records
         WHERE target_pk = ?
           AND state IN ('pending_followback', 'followed_back', 'unfollow_queued', 'unfollowed')`,
      )
      .get(targetPk) as { total: number; followed_back: number };

    const pool = this.db
      .prepare(
        `SELECT
           COUNT(*) AS pool_size,
           SUM(CASE WHEN EXISTS (
             SELECT 1 FROM edges w
             WHERE w.src_pk = @own AND w.dst_pk = e.src_pk
               AND w.type = 'follows' AND w.status = 'active'
           ) THEN 1 ELSE 0 END) AS mutual_overlap
         FROM edges e
         WHERE e.dst_pk = @target AND e.type = 'follows' AND e.status = 'active'`,
      )
      .get({ target: targetPk, own: ownPk }) as {
      pool_size: number;
      mutual_overlap: number | null;
    };

    return {
      total: counts.total,
      followedBack: counts.followed_back,
      followBackRate: counts.total === 0 ? 0 : counts.followed_back / counts.total,
      poolSize: pool.pool_size,
      mutualOverlap: pool.mutual_overlap ?? 0,
    };
  }

  /**
   * The Targets console's funnel read, in cheap COUNT queries (safe in
   * projection position — no Sets or per-pk loops):
   *
   *  - `states`: records aimed at the target, grouped by lifecycle state and
   *    zero-filled across the WHOLE {@link FOLLOW_STATES} union, so a state can
   *    never be silently absent from the funnel.
   *  - `observed`: followers of the target seen so far (never the audience size).
   *  - `candidates`: the COUNT twin of `candidatePksForTarget` — the same
   *    exclusions expressed in SQL instead of materialized Sets.
   */
  targetFunnel(targetPk: string, ownPk: string | null): TargetFunnelRead {
    const rows = this.db
      .prepare(
        `SELECT state, COUNT(*) AS c FROM follow_records WHERE target_pk = ? GROUP BY state`,
      )
      .all(targetPk) as Array<{ state: string; c: number }>;
    const states = Object.fromEntries(FOLLOW_STATES.map((s) => [s, 0])) as Record<
      FollowState,
      number
    >;
    for (const row of rows) {
      if ((FOLLOW_STATES as readonly string[]).includes(row.state)) {
        states[row.state as FollowState] = row.c;
      } else {
        // Shape drift, loudly — never silently fold an unknown state away.
        logger.warn('store.targetFunnel: unknown follow state', { state: row.state });
      }
    }

    const candidates = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM edges e
           WHERE e.dst_pk = @target AND e.type = 'follows' AND e.status = 'active'
             AND e.src_pk <> @target
             AND (@own IS NULL OR e.src_pk <> @own)
             AND NOT EXISTS (SELECT 1 FROM follow_records fr WHERE fr.account_pk = e.src_pk)
             AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.pk = e.src_pk AND a.role = 'skipped')
             AND (@own IS NULL OR NOT EXISTS (
               SELECT 1 FROM edges w
               WHERE w.src_pk = @own AND w.dst_pk = e.src_pk
                 AND w.type = 'follows' AND w.status = 'active'))`,
        )
        .get({ target: targetPk, own: ownPk }) as { c: number }
    ).c;

    const observed = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM edges
           WHERE dst_pk = ? AND type = 'follows' AND status = 'active'`,
        )
        .get(targetPk) as { n: number }
    ).n;

    return { states, observed, candidates };
  }

  /**
   * Follow-back latency for one target: how many records carry BOTH stamps and
   * the median of their deltas — computed with ORDER BY/LIMIT/OFFSET (averaging
   * the two middle rows on an even count), so no row set is materialized in JS.
   */
  followbackTimingFor(targetPk: string): FollowbackTiming {
    const resolved = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM follow_records
           WHERE target_pk = ? AND followed_back_at IS NOT NULL AND followed_at IS NOT NULL`,
        )
        .get(targetPk) as { c: number }
    ).c;
    if (resolved === 0) return { resolved: 0, medianMs: null };
    // LIMIT/OFFSET bound as plain integers: SQLite refuses arithmetic ON a
    // parameter in the OFFSET clause with a datatype mismatch.
    const limit = 2 - (resolved % 2);
    const offset = Math.floor((resolved - 1) / 2);
    const row = this.db
      .prepare(
        `SELECT AVG(d) AS m FROM (
           SELECT followed_back_at - followed_at AS d FROM follow_records
           WHERE target_pk = @t AND followed_back_at IS NOT NULL AND followed_at IS NOT NULL
           ORDER BY d LIMIT @limit OFFSET @offset
         )`,
      )
      .get({ t: targetPk, limit, offset }) as { m: number | null };
    return { resolved, medianMs: row.m };
  }

  /**
   * Cumulative net own-follower growth per day for the last `days` days, from
   * `now` backwards. gained = own-follower edges bucketed by first_seen_at;
   * lost = removed own-follower edges bucketed by last_confirmed_at.
   * Epo-visible (from sweeps), not Instagram's ground-truth total.
   *
   * Baseline-aware: once a baseline exists, only events STRICTLY AFTER it
   * count. The first census's discoveries sit AT the baseline (re-dated
   * stock), so initializing the app never charts a one-day cliff, while
   * event-time gains observed before that census keep charting on their days.
   */
  netGrowthSeries(days: number, ownPk: string, now: number): GrowthPoint[] {
    if (days <= 0 || ownPk.length === 0) return [];

    // Local-midnight boundary of each day, oldest→newest, with `now`'s day
    // last. Date arithmetic, not fixed ms steps, so a DST day-length change
    // never skews a bucket.
    const dayStarts: number[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - i);
      d.setHours(0, 0, 0, 0);
      dayStarts.push(d.getTime());
    }
    const windowStart = dayStarts[0];

    // Events at or before the baseline are stock, not growth (−1 keeps the
    // strict `>` inclusive-of-everything when no baseline exists yet).
    const baselineAt = this.baselineAt() ?? -1;
    const rows = this.db
      .prepare(
        `SELECT first_seen_at AS at, 1 AS delta FROM edges
           WHERE dst_pk = ? AND type = 'follows' AND first_seen_at >= ?
             AND first_seen_at > ?
         UNION ALL
         SELECT last_confirmed_at AS at, -1 AS delta FROM edges
           WHERE dst_pk = ? AND type = 'follows' AND status = 'removed'
             AND last_confirmed_at >= ? AND last_confirmed_at > ?`,
      )
      .all(ownPk, windowStart, baselineAt, ownPk, windowStart, baselineAt) as Array<{
      at: number;
      delta: number;
    }>;

    const perDay = new Map<number, number>();
    for (const row of rows) {
      const key = startOfLocalDay(row.at);
      perDay.set(key, (perDay.get(key) ?? 0) + row.delta);
    }

    // One point per day, carrying the running cumulative across empty days.
    let cumulativeNet = 0;
    return dayStarts.map((dayStartMs) => {
      cumulativeNet += perDay.get(dayStartMs) ?? 0;
      return { dayStartMs, cumulativeNet };
    });
  }

  /**
   * TRUE net own-follower delta since `sinceMs`: gains minus losses in the
   * window. Baseline-aware like {@link netGrowthSeries}, so pre-existing stock
   * never counts as a gain.
   */
  netFollowersSince(sinceMs: number, ownPk: string): number {
    const baselineAt = this.baselineAt() ?? -1;
    return (
      this.db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM edges
                WHERE dst_pk = @own AND type = 'follows'
                  AND first_seen_at >= @since AND first_seen_at > @baseline)
             -
             (SELECT COUNT(*) FROM edges
                WHERE dst_pk = @own AND type = 'follows' AND status = 'removed'
                  AND last_confirmed_at >= @since AND last_confirmed_at > @baseline)
             AS n`,
        )
        .get({ own: ownPk, since: sinceMs, baseline: baselineAt }) as { n: number }
    ).n;
  }

  /**
   * Everything the Graph view's shaper reads, in one call. Bulk JOINed reads on
   * purpose: the view holds tens of thousands of nodes, so per-pk lookups would
   * dominate. Row order of `hubs`/`crowd` is CHAIN order, which the shaper
   * relies on ("first hub wins" when an account follows several targets).
   */
  graphSourceRows(ownPk: string): {
    hubs: GraphHubRow[];
    records: GraphRecordRow[];
    crowd: GraphCrowdRow[];
    ownFollowers: GraphAccountRow[];
    ownFollowing: GraphAccountRow[];
  } {
    const hubs = this.db
      .prepare(
        `SELECT t.account_pk AS pk, a.username AS username, t.status AS status,
                t.chain_index AS chainIndex
         FROM targets t LEFT JOIN accounts a ON a.pk = t.account_pk
         ORDER BY t.chain_index IS NULL, t.chain_index ASC, t.account_pk ASC`,
      )
      .all() as GraphHubRow[];
    const records = this.db
      .prepare(
        `SELECT fr.account_pk AS pk, fr.state AS state, fr.followed_at AS followedAt,
                fr.followed_back_at AS followedBackAt, fr.hold_until AS holdUntil,
                fr.target_pk AS targetPk, a.username AS username, a.followers AS followers
         FROM follow_records fr LEFT JOIN accounts a ON a.pk = fr.account_pk`,
      )
      .all() as GraphRecordRow[];
    const crowd = this.db
      .prepare(
        `SELECT e.src_pk AS pk, e.dst_pk AS hubPk, a.username AS username,
                a.followers AS followers
         FROM edges e
         JOIN targets t ON t.account_pk = e.dst_pk
         LEFT JOIN accounts a ON a.pk = e.src_pk
         WHERE e.type = 'follows' AND e.status = 'active'
         ORDER BY t.chain_index IS NULL, t.chain_index ASC, t.account_pk ASC`,
      )
      .all() as GraphCrowdRow[];
    const ownFollowers = this.db
      .prepare(
        `SELECT e.src_pk AS pk, a.username AS username, a.followers AS followers
         FROM edges e LEFT JOIN accounts a ON a.pk = e.src_pk
         WHERE e.dst_pk = ? AND e.type = 'follows' AND e.status = 'active'`,
      )
      .all(ownPk) as GraphAccountRow[];
    const ownFollowing = this.db
      .prepare(
        `SELECT e.dst_pk AS pk, a.username AS username, a.followers AS followers
         FROM edges e LEFT JOIN accounts a ON a.pk = e.dst_pk
         WHERE e.src_pk = ? AND e.type = 'follows' AND e.status = 'active'`,
      )
      .all(ownPk) as GraphAccountRow[];
    return { hubs, records, crowd, ownFollowers, ownFollowing };
  }
}
