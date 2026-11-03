import { startOfLocalDay } from '../../timing/units';
import type { SqliteDriver } from '../driver/driver';

/** One point of the cumulative net-growth series. */
export interface GrowthPoint {
  dayStartMs: number;
  cumulativeNet: number;
}

/**
 * Own-follower growth reads: the per-day cumulative series and the net delta
 * since a moment, both counting only events strictly after the followers baseline.
 */
export class GrowthRepo {
  constructor(
    private readonly db: SqliteDriver,
    /** The stock/growth boundary; growth reads count only events strictly after it. */
    private readonly baselineAt: () => number | null,
  ) {}

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
}
