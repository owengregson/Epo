import type { GrowthPointV2, TodayCounts } from '../../shared/reopen-view';
import { startOfLocalDay } from '../../timing/units';
import type { SqliteDriver } from '../driver/driver';
import {
  type ChangeSource, type DayWindow, type EpoWrite, type FollowerAccounting, type FollowerChange, followerAccounting,
  type OwnHeader, outsideCharges, type WindowOf,
} from '../folds/growth';
import type { MetaRepo } from './meta';

export type { ChangeSource, FollowerChange, OwnHeader } from '../folds/growth';

/** One point of the cumulative net-growth series. */
export interface GrowthPoint {
  dayStartMs: number;
  cumulativeNet: number;
}

export interface GrowthDeps {
  readonly meta: MetaRepo;
  /** The stock/growth boundary; nothing at or before it is growth. */
  readonly baselineAt: () => number | null;
  readonly now: () => number;
  readonly changed: () => void;
  /** How far back the outside charge looks for Epo's outstanding requests (the store's retention). */
  readonly lookbackMs: number;
}

interface ChangeRow { id: number; account_pk: string; delta: 1 | -1; lo: number; hi: number; source: ChangeSource; found_at: number }
const decode = (r: ChangeRow): FollowerChange =>
  ({ id: r.id, accountPk: r.account_pk, delta: r.delta, lo: r.lo, hi: r.hi, source: r.source, foundAt: r.found_at });

/** Epo's writes that landed (ledger rows and ledger-less intents), with the account's privacy. */
const EPO_WRITES = `
  SELECT w.at AS at, w.action AS action, COALESCE(a.is_private, 0) AS private FROM (
    SELECT at, action, account_pk FROM action_ledger WHERE result = 'ok' AND at >= @since
    UNION ALL SELECT at, 'unfollow', account_pk FROM prune_ledger WHERE result = 'ok' AND at >= @since
    UNION ALL SELECT dispatched_at, action, account_pk FROM effect_intents
      WHERE state = 'settled' AND result IN ('ok', 'external') AND action IN ('follow', 'unfollow')
        AND COALESCE(ledger, 'none') = 'none' AND dispatched_at >= @since
  ) w LEFT JOIN accounts a ON a.pk = w.account_pk`;

/**
 * The follower change log and the own header series (migration 15, ADR 0704), and the legacy
 * edge reads the backfill reproduces (law L8). Windows arrive as arguments, never computed here.
 */
export class GrowthRepo {
  private outsideMemo: { since: number; value: number } | null = null;

  constructor(private readonly db: SqliteDriver, private readonly d: GrowthDeps) {}

  /** Forget memoized reads; the store calls it on every committed write. */
  invalidate(): void { this.outsideMemo = null; }

  noteOwnHeader(h: OwnHeader): void {
    this.db.prepare(`INSERT OR REPLACE INTO own_counts (at, followers, following) VALUES (?, ?, ?)`)
      .run(h.at, h.followers, h.following);
  }

  latestOwnHeader(): OwnHeader | null {
    return this.db.prepare(`SELECT at, followers, following FROM own_counts ORDER BY at DESC LIMIT 1`)
      .get<OwnHeader>() ?? null;
  }

  headersSince(t: number): OwnHeader[] {
    return this.db.prepare(`SELECT at, followers, following FROM own_counts WHERE at >= ? ORDER BY at`).all<OwnHeader>(t);
  }

  /** One transition row, in the caller's edge write; at or before the baseline it is stock and writes nothing. */
  onTransition(pk: string, delta: 1 | -1, lo: number, hi: number, source: ChangeSource, at: number): number | null {
    const baseline = this.d.baselineAt();
    if (baseline === null || hi <= baseline) return null;
    return this.db.prepare(`INSERT INTO follower_changes (account_pk, delta, lo, hi, source, found_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(pk, delta, Math.min(lo, hi), hi, source, at).lastInsertRowid;
  }

  /** Tighten a row's interval; a bound that would widen it, or invert it, is ignored. */
  narrow(id: number, lo: number, hi: number): void {
    const r = this.db.prepare(`UPDATE follower_changes SET lo = MAX(lo, @lo), hi = MIN(hi, @hi)
      WHERE id = @id AND MAX(lo, @lo) <= MIN(hi, @hi) AND (@lo > lo OR @hi < hi)`).run({ id, lo, hi });
    if (r.changes > 0) this.d.changed();
  }

  /** A dated event for a follower already counted: narrow the latest gain that holds it. */
  narrowLatestGainContaining(pk: string, exactAt: number): boolean {
    const g = this.latestGain(pk);
    if (g === null || exactAt < g.lo || exactAt > g.hi) return false;
    this.narrow(g.id, exactAt, exactAt);
    return true;
  }

  latestGain(pk: string): FollowerChange | null {
    const r = this.db.prepare(`SELECT * FROM follower_changes WHERE account_pk = ? AND delta = 1
      ORDER BY hi DESC, id DESC LIMIT 1`).get<ChangeRow>(pk);
    return r === undefined ? null : decode(r);
  }

  /** Every row whose interval ends at or after `t`, oldest first. */
  changesSince(t: number): FollowerChange[] {
    return this.db.prepare(`SELECT * FROM follower_changes WHERE hi >= ? ORDER BY hi, id`).all<ChangeRow>(t).map(decode);
  }

  /** The first census's own discoveries are stock: drop their gains (exact event rows stay). */
  dropStock(pks: readonly string[], from: number, to: number): void {
    const del = this.db.prepare(`DELETE FROM follower_changes WHERE account_pk = ? AND delta = 1
      AND hi >= ? AND hi <= ? AND source NOT IN ('feed', 'accept')`);
    for (const pk of pks) del.run(pk, from, to);
  }

  /**
   * Set-once: the legacy edges become point rows (`+1` at first seen, `−1` at removal, after the
   * baseline) and the own account's header seeds `own_counts`, so every chart reads the same.
   */
  ensureBackfilled(ownPk: string, baselineAt: number | null): { inserted: number } | null {
    return this.db.transaction(() => {
      if (this.d.meta.get('followerChangesBackfilledAt') !== null) return null;
      const now = this.d.now();
      const floor = baselineAt ?? Number.NEGATIVE_INFINITY;
      const insert = this.db.prepare(`INSERT INTO follower_changes (account_pk, delta, lo, hi, source, found_at)
        VALUES (?, ?, ?, ?, 'migrated', ?)`);
      let inserted = 0;
      for (const e of this.db.prepare(`SELECT src_pk, first_seen_at, last_confirmed_at, status FROM edges
        WHERE dst_pk = ? AND type = 'follows' ORDER BY first_seen_at, src_pk`).all<{ src_pk: string;
        first_seen_at: number; last_confirmed_at: number; status: string }>(ownPk)) {
        if (e.first_seen_at > floor) { insert.run(e.src_pk, 1, e.first_seen_at, e.first_seen_at, now); inserted += 1; }
        if (e.status === 'removed' && e.last_confirmed_at > floor) {
          insert.run(e.src_pk, -1, e.last_confirmed_at, e.last_confirmed_at, now);
        }
      }
      const own = this.db.prepare(`SELECT followers, following, stats_observed_at AS at FROM accounts WHERE pk = ?`)
        .get<{ followers: number | null; following: number | null; at: number | null }>(ownPk);
      if (own?.at != null && own.followers != null && own.following != null) {
        this.noteOwnHeader({ at: own.at, followers: own.followers, following: own.following });
      }
      this.d.meta.setOnce('followerChangesBackfilledAt', String(now));
      return { inserted };
    });
  }

  /** The accounting over the rows from the last header at or before `fromAt` onward. */
  accounting(fromAt: number, windowOf: WindowOf): FollowerAccounting {
    const anchor = this.db.prepare(`SELECT MAX(at) AS at FROM own_counts WHERE at <= ?`).get<{ at: number | null }>(fromAt);
    const start = anchor?.at ?? fromAt;
    return followerAccounting(this.headersSince(start), this.changesSince(start), windowOf);
  }

  /** Today's tallies for one plan-day window (from the `PlanDayClock`). */
  today(window: DayWindow): TodayCounts {
    const placed = this.accounting(window.startsAt, () => window).placed(window);
    return {
      startsAt: window.startsAt, endsAt: window.endsAt, net: placed.gained - placed.lost + placed.residual,
      gained: placed.gained, lost: placed.lost, unattributed: placed.residual,
      followBacks: this.followBacksIn(window), outside: this.outsideIn(window.startsAt, window.endsAt),
    };
  }

  /** Managed records whose follow-back interval lies inside the window. */
  private followBacksIn(w: DayWindow): number {
    return this.db.prepare(`SELECT COALESCE(followback_after, followed_back_at, followed_at) AS lo FROM follow_records
      WHERE COALESCE(followed_back_at, followback_observed_at) >= @s AND COALESCE(followed_back_at, followback_observed_at) < @e`)
      .all<{ lo: number | null }>({ s: w.startsAt, e: w.endsAt }).filter((r) => r.lo !== null && r.lo >= w.startsAt).length;
  }

  /** Cumulative growth per day window: changes by `hi`, closed residuals by their end; late arrivals annotated. */
  series(days: readonly DayWindow[], baselineAt: number | null): GrowthPointV2[] {
    if (days.length === 0) return [];
    const floor = baselineAt ?? Number.NEGATIVE_INFINITY;
    const first = days[0].startsAt;
    const a = this.accounting(first, (t) => days.find((d) => t >= d.startsAt && t < d.endsAt) ?? { startsAt: t, endsAt: t });
    const items = [
      ...this.changesSince(first).map((c) => ({ lo: c.lo, hi: c.hi, delta: c.delta })),
      ...a.components.filter((c) => c.to !== Number.POSITIVE_INFINITY).map((c) => ({ lo: c.from, hi: c.to, delta: c.residual })),
    ].filter((i) => i.hi > floor && i.delta !== 0);
    let cumulativeNet = 0;
    return days.map((d) => {
      const inDay = items.filter((i) => i.hi >= d.startsAt && i.hi < d.endsAt);
      cumulativeNet += inDay.reduce((s, i) => s + i.delta, 0);
      const late = inDay.filter((i) => i.lo < d.startsAt);
      if (late.length === 0) return { dayStartMs: d.startsAt, cumulativeNet };
      const gained = late.filter((i) => i.delta > 0).reduce((s, i) => s + i.delta, 0);
      const lost = late.filter((i) => i.delta < 0).reduce((s, i) => s - i.delta, 0);
      return { dayStartMs: d.startsAt, cumulativeNet, arrived: { gained, lost, fromMs: Math.min(...late.map((i) => i.lo)) } };
    });
  }

  /** The identified net change since `since` (the legacy `netFollowersSince`, identical at migration). */
  netSince(since: number): number {
    const floor = this.d.baselineAt() ?? Number.NEGATIVE_INFINITY;
    return this.changesSince(since).filter((c) => c.hi > floor).reduce((s, c) => s + c.delta, 0);
  }

  /** Outside following actions in the header windows that start at or after `since` (increases only). */
  outsideSince(since: number): number {
    if (this.outsideMemo?.since === since) return this.outsideMemo.value;
    const value = this.outsideIn(since, Number.POSITIVE_INFINITY);
    this.outsideMemo = { since, value };
    return value;
  }

  private outsideIn(from: number, to: number): number {
    const lookback = from - this.d.lookbackMs;
    const writes = this.db.prepare(EPO_WRITES).all<{ at: number; action: EpoWrite['action']; private: number }>({ since: lookback })
      .map((w): EpoWrite => ({ at: w.at, action: w.action, private: w.private === 1 }));
    return outsideCharges(this.headersSince(lookback), writes)
      .filter((w) => w.from >= from && w.to < to).reduce((s, w) => s + w.charge, 0);
  }

  // --- The legacy edge reads (the current UI; the backfill reproduces them) -------------

  /** Cumulative net own-follower growth per local day for the last `days` days, baseline-aware. */
  netGrowthSeries(days: number, ownPk: string, now: number): GrowthPoint[] {
    if (days <= 0 || ownPk.length === 0) return [];
    const dayStarts: number[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - i);
      d.setHours(0, 0, 0, 0);
      dayStarts.push(d.getTime());
    }
    const windowStart = dayStarts[0];
    const baselineAt = this.d.baselineAt() ?? -1;
    const rows = this.db.prepare(
      `SELECT first_seen_at AS at, 1 AS delta FROM edges
         WHERE dst_pk = ? AND type = 'follows' AND first_seen_at >= ? AND first_seen_at > ?
       UNION ALL
       SELECT last_confirmed_at AS at, -1 AS delta FROM edges
         WHERE dst_pk = ? AND type = 'follows' AND status = 'removed'
           AND last_confirmed_at >= ? AND last_confirmed_at > ?`,
    ).all<{ at: number; delta: number }>(ownPk, windowStart, baselineAt, ownPk, windowStart, baselineAt);
    const perDay = new Map<number, number>();
    for (const row of rows) {
      const key = startOfLocalDay(row.at);
      perDay.set(key, (perDay.get(key) ?? 0) + row.delta);
    }
    let cumulativeNet = 0;
    return dayStarts.map((dayStartMs) => {
      cumulativeNet += perDay.get(dayStartMs) ?? 0;
      return { dayStartMs, cumulativeNet };
    });
  }

  /** The net own-follower delta since `sinceMs` over the edges, baseline-aware. */
  netFollowersSince(sinceMs: number, ownPk: string): number {
    return this.db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM edges WHERE dst_pk = @own AND type = 'follows'
            AND first_seen_at >= @since AND first_seen_at > @baseline)
         -
         (SELECT COUNT(*) FROM edges WHERE dst_pk = @own AND type = 'follows' AND status = 'removed'
            AND last_confirmed_at >= @since AND last_confirmed_at > @baseline)
         AS n`,
    ).get<{ n: number }>({ own: ownPk, since: sinceMs, baseline: this.d.baselineAt() ?? -1 })?.n ?? 0;
  }
}
