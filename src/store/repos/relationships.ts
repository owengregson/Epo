import * as logger from '../../utils/logger';
import type { SqliteDriver } from '../driver/driver';
import type { ChangeSource } from '../folds/growth';
import { type EdgeRow, rowToEdge } from '../rows';
import type { Edge, EdgeType } from '../types';
import type { MetaRepo } from './meta';

/** How an own-follower observation is dated; `feed` and `accept` carry the exact time. */
export interface EdgeDating {
  readonly source: ChangeSource;
  /** The earliest the change can have happened, when the caller knows better than the default. */
  readonly lo?: number;
}

/** What the transition hook needs from the store: the own pk, the change log and the census floor. */
export interface OwnFollowerHook {
  ownPk(): string | null;
  /** The earliest a never-seen follower can have arrived: the last complete census, else the baseline. */
  gainFloor(): number | null;
  transition(pk: string, delta: 1 | -1, lo: number, hi: number, source: ChangeSource, at: number): number | null;
  narrowGain(pk: string, exactAt: number): boolean;
}

const EXACT: ReadonlySet<ChangeSource> = new Set<ChangeSource>(['feed', 'accept']);

/** LIVE relationship counts, straight from the edges as they stand. */
export interface RelationshipCounts {
  following: number;
  followers: number;
  notFollowingBack: number;
}

/**
 * The `edges` table: directed, lifecycled relationships, plus the followers
 * BASELINE that separates pre-existing stock from measured growth.
 *
 * The baseline lives here rather than with the other durable scalars because
 * it is only ever meaningful against these edges: it is the instant follower
 * measurement began, and every growth read filters strictly after it.
 */
export class RelationshipRepo {
  constructor(
    private readonly db: SqliteDriver,
    private readonly changed: () => void,
    private readonly meta: MetaRepo,
    private readonly own: OwnFollowerHook,
  ) {}

  /**
   * Upsert a directed edge, dating first/last seen and its active/removed status. An own-follower
   * transition writes its change row in the same write; an active follow closes an open request.
   */
  observeEdge(srcPk: string, dstPk: string, type: EdgeType, active: boolean, at: number, dating?: EdgeDating): void {
    const ownPk = this.own.ownPk();
    if (type !== 'follows' || ownPk === null || dstPk !== ownPk || srcPk === ownPk) {
      this.upsert(srcPk, dstPk, type, active, at);
      this.changed();
      return;
    }
    this.db.transaction(() => {
      const prior = this.getEdge(srcPk, dstPk, 'follows');
      this.upsert(srcPk, dstPk, type, active, at);
      const was = prior?.status === 'active';
      const is = this.getEdge(srcPk, dstPk, 'follows')?.status === 'active';
      if (is) this.closeRequest(srcPk, ownPk, at);
      const source = dating?.source ?? 'list';
      if (!was && is) {
        const after = prior?.status === 'removed' ? prior.lastConfirmedAt : Number.NEGATIVE_INFINITY;
        const lo = EXACT.has(source) ? at : (dating?.lo ?? Math.max(after, this.own.gainFloor() ?? at));
        this.own.transition(srcPk, 1, lo, at, source, at);
      } else if (was && !is && prior !== null) {
        this.own.transition(srcPk, -1, prior.lastConfirmedAt, at, source, at);
      }
    });
    this.changed();
  }

  private closeRequest(srcPk: string, ownPk: string, at: number): void {
    this.db.prepare(`UPDATE edges SET status = 'removed', last_confirmed_at = MAX(last_confirmed_at, ?)
      WHERE src_pk = ? AND dst_pk = ? AND type = 'requests' AND status = 'active'`).run(at, srcPk, ownPk);
  }

  /** Whether `pk` has an open follow request into our account (spec §9.9: a live predicate, never a state). */
  hasActiveRequest(pk: string, ownPk: string): boolean {
    return this.db.prepare(`SELECT 1 AS hit FROM edges WHERE src_pk = ? AND dst_pk = ? AND type = 'requests'
      AND status = 'active'`).get(pk, ownPk) !== undefined;
  }

  /** Every account with an open follow request into our account. */
  activeRequestPks(ownPk: string): string[] {
    return this.db.prepare(`SELECT src_pk FROM edges WHERE dst_pk = ? AND type = 'requests' AND status = 'active'
      ORDER BY src_pk`).all<{ src_pk: string }>(ownPk).map((r) => r.src_pk);
  }

  private upsert(srcPk: string, dstPk: string, type: EdgeType, active: boolean, at: number): void {
    this.db
      .prepare(
        `INSERT INTO edges (src_pk, dst_pk, type, first_seen_at, last_confirmed_at, status)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(src_pk, dst_pk, type) DO UPDATE SET
           last_confirmed_at = MAX(edges.last_confirmed_at, excluded.last_confirmed_at),
           status = CASE WHEN excluded.last_confirmed_at >= edges.last_confirmed_at
             THEN excluded.status ELSE edges.status END,
           first_seen_at = MIN(edges.first_seen_at, excluded.first_seen_at)`,
      )
      .run(srcPk, dstPk, type, at, at, active ? 'active' : 'removed');
  }

  getEdge(srcPk: string, dstPk: string, type: EdgeType): Edge | null {
    const row = this.db
      .prepare(`SELECT * FROM edges WHERE src_pk = ? AND dst_pk = ? AND type = ?`)
      .get(srcPk, dstPk, type) as EdgeRow | undefined;
    return row ? rowToEdge(row) : null;
  }

  /** src_pk of active `follows` edges into the target (accounts that follow it). */
  followersOf(targetPk: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT src_pk FROM edges
         WHERE dst_pk = ? AND type = 'follows' AND status = 'active'`,
      )
      .all(targetPk) as Array<{ src_pk: string }>;
    return rows.map((r) => r.src_pk);
  }

  /** How many followers of `targetPk` we have observed so far. */
  observedFollowerCount(targetPk: string): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM edges
           WHERE dst_pk = ? AND type = 'follows' AND status = 'active'`,
        )
        .get(targetPk) as { n: number }
    ).n;
  }

  /**
   * dst_pk of our own ACTIVE `follows` edges — every account we (or the user,
   * externally) currently follow.
   */
  accountsWeFollow(ownPk: string): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT dst_pk FROM edges
         WHERE src_pk = ? AND type = 'follows' AND status = 'active'`,
      )
      .all(ownPk) as Array<{ dst_pk: string }>;
    return new Set(rows.map((r) => r.dst_pk));
  }

  /**
   * LIVE counts from the graph as it stands right now (docs/PRINCIPLES.md §2).
   * Because scan sources stream every row's edge as it parses, these tick
   * DURING a scan instead of jumping when it ends.
   */
  counts(ownPk: string): RelationshipCounts {
    const one = (sql: string): number => (this.db.prepare(sql).get(ownPk) as { c: number }).c;
    return {
      following: one(
        `SELECT COUNT(*) AS c FROM edges
         WHERE src_pk = ? AND type = 'follows' AND status = 'active'`,
      ),
      followers: one(
        `SELECT COUNT(*) AS c FROM edges
         WHERE dst_pk = ? AND type = 'follows' AND status = 'active'`,
      ),
      notFollowingBack: one(
        `SELECT COUNT(*) AS c FROM edges e
         WHERE e.src_pk = ? AND e.type = 'follows' AND e.status = 'active'
           AND NOT EXISTS (
             SELECT 1 FROM edges b
             WHERE b.src_pk = e.dst_pk AND b.dst_pk = e.src_pk
               AND b.type = 'follows' AND b.status = 'active'
           )`,
      ),
    };
  }

  // --- The followers baseline (stock vs growth) ------------------------------

  /**
   * The moment follower measurement began — the first follow-back sweep or the
   * first complete census, whichever ran first — or `null` before either.
   * Everything first seen AT or BEFORE it is pre-existing STOCK.
   */
  baselineAt(): number | null {
    return this.meta.number('followersBaselineAt');
  }

  /**
   * Establish the baseline at `at` if none exists (set-once; a later call never
   * moves it). Called at the top of every follow-back sweep and by every
   * {@link observeOwnFollowerEvent}, so the FIRST moment collection begins
   * stamps the stock/growth boundary — without it, weeks of event-observed
   * followers would be erased retroactively by a late first census.
   */
  ensureBaseline(at: number): void {
    if (this.baselineAt() !== null) return;
    this.meta.setOnce('followersBaselineAt', String(at));
    logger.info('store: followers baseline established', { at });
    this.changed();
  }

  /**
   * Record a dated "they follow us" EVENT — a notifications entry or an
   * accepted follow request. Anchors the baseline FIRST: an event stream is
   * measurement, and measurement must be anchored before its facts land, or a
   * late first census would re-classify them as stock. When an event IS the
   * first-ever observation it becomes the boundary itself, landing exactly at
   * the baseline and counting as stock.
   *
   * List-walk observations (membership, not timing) must NOT come through here
   * — they use plain {@link observeEdge} and the census's stock accounting.
   */
  observeOwnFollowerEvent(srcPk: string, ownPk: string, at: number, source: 'feed' | 'accept' = 'feed'): void {
    this.ensureBaseline(at);
    const current = this.getEdge(srcPk, ownPk, 'follows');
    if (current !== null && current.lastConfirmedAt >= at) {
      // A delayed historical event can improve history (and date a counted gain), never current membership.
      this.db.prepare(`UPDATE edges SET first_seen_at = MIN(first_seen_at, ?)
        WHERE src_pk = ? AND dst_pk = ? AND type = 'follows'`).run(at, srcPk, ownPk);
      this.own.narrowGain(srcPk, at);
      this.changed();
      return;
    }
    this.observeEdge(srcPk, ownPk, 'follows', true, at, { source });
  }

  /** Own-follower edges the census verdict must treat as its own walk's rows. */
  edgesFirstSeenBefore(ownPk: string, before: number): number | null {
    return (
      this.db
        .prepare(
          `SELECT MIN(first_seen_at) AS m FROM edges
           WHERE dst_pk = ? AND type = 'follows' AND first_seen_at < ?`,
        )
        .get(ownPk, before) as { m: number | null }
    ).m;
  }

  /**
   * Re-date the first census's own discoveries onto the baseline, so the
   * initial stock can never chart as a one-day cliff; returns their pks.
   */
  redateStockOntoBaseline(
    ownPk: string,
    baselineAt: number,
    windowStart: number,
    windowEnd: number,
  ): string[] {
    const where = `WHERE dst_pk = ? AND type = 'follows' AND status = 'active'
           AND first_seen_at >= ? AND first_seen_at <= ? AND first_seen_at > ?`;
    const pks = this.db.prepare(`SELECT src_pk FROM edges ${where}`)
      .all<{ src_pk: string }>(ownPk, windowStart, windowEnd, baselineAt).map((r) => r.src_pk);
    this.db.prepare(`UPDATE edges SET first_seen_at = ? ${where}`).run(baselineAt, ownPk, windowStart, windowEnd, baselineAt);
    return pks;
  }

  /** src_pk of every active edge INTO `ownPk` — the census's "did we lose them" set. */
  activeFollowerPks(ownPk: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT src_pk FROM edges
         WHERE dst_pk = ? AND type = 'follows' AND status = 'active'`,
      )
      .all(ownPk) as Array<{ src_pk: string }>;
    return rows.map((r) => r.src_pk);
  }

  /** dst_pk of every active edge OUT of `ownPk` — the census's "is it gone" set. */
  activeFollowingPks(ownPk: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT dst_pk FROM edges
         WHERE src_pk = ? AND type = 'follows' AND status = 'active'`,
      )
      .all(ownPk) as Array<{ dst_pk: string }>;
    return rows.map((r) => r.dst_pk);
  }
}
