import type { SqliteDriver } from '../driver/driver';
import type { EffectChannel, EffectResult, FollowRecord } from '../types';

/** One settled write the feed narrates (`accept-request` reads as `accept`). */
export interface EffectFeedRow {
  readonly id: string;
  readonly pk: string;
  readonly username: string;
  readonly action: 'follow' | 'unfollow' | 'accept';
  readonly channel: EffectChannel;
  readonly result: Extract<EffectResult, 'ok' | 'simulated' | 'fail' | 'expired'>;
  readonly settledAt: number;
  /** Why the lifecycle scheduled the account's unfollow, from its record; null when none says. */
  readonly unfollowReason: NonNullable<FollowRecord['unfollowReason']> | null;
}

/** A follow-back: dated by the event when Instagram gave its time, else by when Epo saw it. */
export interface FollowBackFeedRow {
  readonly pk: string;
  readonly username: string | null;
  readonly at: number;
  readonly dated: boolean;
  readonly followedAt: number | null;
}

/** A follower Epo did not ask for: first seen at `at`; dated when the change log holds its exact time. */
export interface EdgeFeedRow {
  readonly pk: string;
  readonly username: string | null;
  readonly at: number;
  readonly dated: boolean;
}

/** Followers found gone at one detection. */
export interface LostFollowersRow {
  readonly at: number;
  readonly count: number;
}

/**
 * The statements, exported so the query plans can be pinned. External and cancelled settlements are not feed
 * events (Instagram already had that state; nothing was sent), so the limit counts only rows the feed shows.
 */
export const FEED_SQL = {
  settledEffects: `
    SELECT e.id, e.account_pk AS pk, e.username,
      CASE e.action WHEN 'accept-request' THEN 'accept' ELSE e.action END AS action,
      e.channel, e.result, e.settled_at AS settledAt, r.unfollow_reason AS unfollowReason
    FROM effect_intents e LEFT JOIN follow_records r ON r.account_pk = e.account_pk
    WHERE e.state = 'settled' AND e.settled_at >= ? AND e.result IN ('ok', 'simulated', 'fail', 'expired')
    ORDER BY e.settled_at DESC LIMIT ?`,
  followBacks: `
    SELECT r.account_pk AS pk, a.username AS username, COALESCE(r.followed_back_at, r.followback_observed_at) AS at,
      r.followed_back_at IS NOT NULL AS dated, r.followed_at AS followedAt
    FROM follow_records r LEFT JOIN accounts a ON a.pk = r.account_pk
    WHERE COALESCE(r.followed_back_at, r.followback_observed_at) >= ?
      AND (r.followed_back_at IS NULL OR r.followed_at IS NULL OR r.followed_back_at >= r.followed_at)
    ORDER BY at DESC LIMIT ?`,
  newFollowers: `
    SELECT e.src_pk AS pk, a.username AS username, e.first_seen_at AS at,
      COALESCE((SELECT c.lo = c.hi FROM follower_changes c WHERE c.account_pk = e.src_pk AND c.delta > 0
        ORDER BY c.hi DESC LIMIT 1), 0) AS dated
    FROM edges e LEFT JOIN accounts a ON a.pk = e.src_pk
    WHERE e.dst_pk = ? AND e.type = 'follows' AND e.status = 'active' AND e.first_seen_at >= ?
      AND NOT EXISTS (SELECT 1 FROM follow_records r WHERE r.account_pk = e.src_pk
        AND (r.followed_at IS NOT NULL OR r.followed_back_at IS NOT NULL OR r.followback_observed_at IS NOT NULL))
      AND e.src_pk NOT IN (SELECT i.account_pk FROM effect_intents i WHERE i.action = 'accept-request')
    ORDER BY e.first_seen_at DESC LIMIT ?`,
  lostFollowerCount: `
    SELECT e.last_confirmed_at AS at, COUNT(*) AS count FROM edges e
    WHERE e.dst_pk = ? AND e.type = 'follows' AND e.status = 'removed' AND e.last_confirmed_at >= ?
    GROUP BY e.last_confirmed_at ORDER BY e.last_confirmed_at DESC`,
  lastSettledMutationAt: `
    SELECT e.settled_at AS at FROM effect_intents e
    WHERE e.state = 'settled' AND e.settled_at IS NOT NULL AND e.result IN ('ok', 'simulated')
    ORDER BY e.settled_at DESC LIMIT 1`,
} as const;

/** SQLite answers a comparison with 0/1. */
const flag = <R extends { dated: unknown }>(row: R): R & { dated: boolean } => ({ ...row, dated: row.dated === 1 });

/**
 * Read-only SQL behind the live feed (settled writes, follow-backs, new and lost followers) and the last
 * settled write. Every bound arrives as a method argument (the caller's window and row limit), never by import.
 */
export class FeedReadsRepo {
  constructor(protected readonly db: SqliteDriver) {}

  /** Settled writes at or after `since`, newest first, at most `limit`. */
  settledEffects(since: number, limit: number): EffectFeedRow[] {
    return this.db.prepare(FEED_SQL.settledEffects).all<EffectFeedRow>(since, limit);
  }

  /** Follow-backs at or after `since` (event time, else observation), newest first; none predating our follow. */
  followBacks(since: number, limit: number): FollowBackFeedRow[] {
    return this.db.prepare(FEED_SQL.followBacks).all<FollowBackFeedRow & { dated: number }>(since, limit).map(flag);
  }

  /**
   * Active followers of `ownPk` first seen at or after `since` (the caller keeps it past the followers baseline),
   * newest first: never an account Epo followed or saw follow back, nor one whose request Epo accepted.
   */
  newFollowers(ownPk: string, since: number, limit: number): EdgeFeedRow[] {
    return this.db.prepare(FEED_SQL.newFollowers).all<EdgeFeedRow & { dated: number }>(ownPk, since, limit).map(flag);
  }

  /** Followers of `ownPk` found gone at or after `since`, counted per detection, newest first. */
  lostFollowerCount(ownPk: string, since: number): LostFollowersRow[] {
    return this.db.prepare(FEED_SQL.lostFollowerCount).all<LostFollowersRow>(ownPk, since);
  }

  /** When the newest write that landed (or was practised) settled; null before the first. */
  lastSettledMutationAt(): number | null {
    return this.db.prepare(FEED_SQL.lastSettledMutationAt).get<{ at: number }>()?.at ?? null;
  }
}
