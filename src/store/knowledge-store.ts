import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import {
  AccountState,
  Edge,
  EdgeType,
  EnrichmentLevel,
  FollowRecord,
  FollowState,
  Observation,
  Source,
  SOURCE_CONFIDENCE,
  Target,
} from './types';
import { projectAccount } from './projections';
import { runMigrations } from './migrations';
import * as logger from '../utils/logger';

interface AccountRow {
  pk: string;
  username: string | null;
  enrichment: string;
  followers: number | null;
  following: number | null;
  ratio: number | null;
  is_private: number | null;
  is_verified: number | null;
  activity_signal: number | null;
  role: string | null;
  stats_observed_at: number | null;
  stats_source: string | null;
  first_seen_at: number;
  last_seen_at: number;
}

interface EdgeRow {
  src_pk: string;
  dst_pk: string;
  type: string;
  first_seen_at: number;
  last_confirmed_at: number;
  status: string;
}

interface FollowRecordRow {
  account_pk: string;
  target_pk: string | null;
  state: string;
  followed_at: number | null;
  followed_back_at: number | null;
  hold_until: number | null;
  unfollow_due_at: number | null;
  retry_count: number;
}

interface TargetRow {
  account_pk: string;
  source: string;
  status: string;
  chain_index: number | null;
}

const boolOrUndef = (v: number | null): boolean | undefined =>
  v === null ? undefined : v !== 0;
const numOrUndef = (v: number | null): number | undefined => (v === null ? undefined : v);
const strOrUndef = (v: string | null): string | undefined => (v === null ? undefined : v);
const boolToInt = (v: boolean | undefined): number | null =>
  v === undefined ? null : v ? 1 : 0;
const orNull = <T>(v: T | undefined): T | null => (v === undefined ? null : v);

const rowToState = (row: AccountRow): AccountState => ({
  pk: row.pk,
  username: strOrUndef(row.username),
  enrichment: row.enrichment as EnrichmentLevel,
  followers: numOrUndef(row.followers),
  following: numOrUndef(row.following),
  ratio: numOrUndef(row.ratio),
  isPrivate: boolOrUndef(row.is_private),
  isVerified: boolOrUndef(row.is_verified),
  activitySignal: numOrUndef(row.activity_signal),
  role: strOrUndef(row.role),
  statsObservedAt: numOrUndef(row.stats_observed_at),
  statsSource: strOrUndef(row.stats_source) as Source | undefined,
  firstSeenAt: row.first_seen_at,
  lastSeenAt: row.last_seen_at,
});

const rowToEdge = (row: EdgeRow): Edge => ({
  srcPk: row.src_pk,
  dstPk: row.dst_pk,
  type: row.type as EdgeType,
  firstSeenAt: row.first_seen_at,
  lastConfirmedAt: row.last_confirmed_at,
  status: row.status as 'active' | 'removed',
});

const rowToTarget = (row: TargetRow): Target => ({
  accountPk: row.account_pk,
  source: row.source as Target['source'],
  status: row.status as Target['status'],
  chainIndex: row.chain_index,
});

const rowToFollowRecord = (row: FollowRecordRow): FollowRecord => ({
  accountPk: row.account_pk,
  targetPk: row.target_pk,
  state: row.state as FollowState,
  followedAt: numOrUndef(row.followed_at),
  followedBackAt: numOrUndef(row.followed_back_at),
  holdUntil: numOrUndef(row.hold_until),
  unfollowDueAt: numOrUndef(row.unfollow_due_at),
  retryCount: row.retry_count,
});

/**
 * The sole boundary to the SQLite knowledge graph. This is the ONLY module permitted
 * to import `better-sqlite3` or contain SQL. Every write funnels through `observe`/
 * `observeEdge`/`recordAction`/`recordRequest`; every read through the typed queries.
 */
export class KnowledgeStore {
  private readonly db: BetterSqlite3.Database;
  /** Our own account pk, set at build time via {@link setOwnPk}; null until then. */
  private ownPk: string | null = null;
  /** One-time guard so an unset ownPk warns once, not on every reconciliation. */
  private warnedOwnPkUnset = false;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    // In WAL mode this fsyncs the WAL on every commit, so a committed action /
    // observation survives an OS power loss (WAL already guarantees no corruption;
    // FULL adds per-commit durability on top).
    this.db.pragma('synchronous = FULL');
    this.db.pragma('foreign_keys = ON');
    runMigrations(this.db);
  }

  /**
   * Set the logged-in account's pk. Used only for the "already-following"
   * candidate exclusion ({@link accountsWeFollow}) and for anchoring the edges
   * that {@link reconcileOwnFollow} writes; keeps the constructor signature stable.
   */
  setOwnPk(pk: string): void {
    this.ownPk = pk;
  }

  /**
   * Append an observation and re-project the account row in the same transaction —
   * the single write path that keeps the event log and projection consistent.
   */
  observe(obs: Observation): void {
    const tx = this.db.transaction((o: Observation) => {
      this.db
        .prepare(
          `INSERT INTO observations (account_pk, observed_at, source, confidence, field_set)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(o.accountPk, o.observedAt, o.source, SOURCE_CONFIDENCE[o.source], JSON.stringify(o.fields));

      const existing = this.getAccount(o.accountPk);
      const next = projectAccount(existing, o);

      this.db
        .prepare(
          `INSERT INTO accounts (
             pk, username, enrichment, followers, following, ratio,
             is_private, is_verified, activity_signal,
             stats_observed_at, stats_source, first_seen_at, last_seen_at
           ) VALUES (
             @pk, @username, @enrichment, @followers, @following, @ratio,
             @is_private, @is_verified, @activity_signal,
             @stats_observed_at, @stats_source, @first_seen_at, @last_seen_at
           )
           ON CONFLICT(pk) DO UPDATE SET
             username = excluded.username,
             enrichment = excluded.enrichment,
             followers = excluded.followers,
             following = excluded.following,
             ratio = excluded.ratio,
             is_private = excluded.is_private,
             is_verified = excluded.is_verified,
             activity_signal = excluded.activity_signal,
             stats_observed_at = excluded.stats_observed_at,
             stats_source = excluded.stats_source,
             first_seen_at = excluded.first_seen_at,
             last_seen_at = excluded.last_seen_at`,
        )
        .run({
          pk: next.pk,
          username: orNull(next.username),
          enrichment: next.enrichment,
          followers: orNull(next.followers),
          following: orNull(next.following),
          ratio: orNull(next.ratio),
          is_private: boolToInt(next.isPrivate),
          is_verified: boolToInt(next.isVerified),
          activity_signal: orNull(next.activitySignal),
          stats_observed_at: orNull(next.statsObservedAt),
          stats_source: orNull(next.statsSource),
          first_seen_at: next.firstSeenAt,
          last_seen_at: next.lastSeenAt,
        });

      if (o.fields.username !== undefined) {
        this.db
          .prepare(`INSERT INTO username_history (pk, username, seen_at) VALUES (?, ?, ?)`)
          .run(o.accountPk, o.fields.username, o.observedAt);
      }
    });
    tx(obs);
  }

  /** Upsert a directed edge, dating first/last seen and its active/removed status. */
  observeEdge(srcPk: string, dstPk: string, type: EdgeType, active: boolean, at: number): void {
    const status = active ? 'active' : 'removed';
    this.db
      .prepare(
        `INSERT INTO edges (src_pk, dst_pk, type, first_seen_at, last_confirmed_at, status)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(src_pk, dst_pk, type) DO UPDATE SET
           last_confirmed_at = excluded.last_confirmed_at,
           status = excluded.status,
           first_seen_at = MIN(edges.first_seen_at, excluded.first_seen_at)`,
      )
      .run(srcPk, dstPk, type, at, at, status);
  }

  getAccount(pk: string): AccountState | null {
    const row = this.db.prepare(`SELECT * FROM accounts WHERE pk = ?`).get(pk) as
      | AccountRow
      | undefined;
    return row ? rowToState(row) : null;
  }

  getEdge(srcPk: string, dstPk: string, type: EdgeType): Edge | null {
    const row = this.db
      .prepare(`SELECT * FROM edges WHERE src_pk = ? AND dst_pk = ? AND type = ?`)
      .get(srcPk, dstPk, type) as EdgeRow | undefined;
    return row ? rowToEdge(row) : null;
  }

  recordAction(
    accountPk: string,
    action: 'follow' | 'unfollow',
    result: 'ok' | 'fail',
    at: number,
  ): void {
    this.db
      .prepare(`INSERT INTO action_ledger (account_pk, action, at, result) VALUES (?, ?, ?, ?)`)
      .run(accountPk, action, at, result);
  }

  actionCountSince(sinceMs: number): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM action_ledger WHERE at >= ?`)
      .get(sinceMs) as { c: number };
    return row.c;
  }

  /** Append one auto-prune attempt to the prune ledger (its own daily cap — §Phase 5). */
  recordPruneAction(accountPk: string, result: 'ok' | 'fail' | 'simulated', at: number): void {
    this.db
      .prepare(`INSERT INTO prune_ledger (account_pk, at, result) VALUES (?, ?, ?)`)
      .run(accountPk, at, result);
  }

  pruneCountSince(sinceMs: number): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM prune_ledger WHERE at >= ?`)
      .get(sinceMs) as { c: number };
    return row.c;
  }

  recordRequest(at: number): void {
    this.db.prepare(`INSERT INTO request_log (at) VALUES (?)`).run(at);
  }

  requestCountSince(sinceMs: number): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM request_log WHERE at >= ?`)
      .get(sinceMs) as { c: number };
    return row.c;
  }

  // --- Churn lifecycle: follow_records (§3.4) ------------------------------------

  /** Insert or fully replace a churn-lifecycle record, keyed on account_pk. */
  upsertFollowRecord(rec: FollowRecord): void {
    const tx = this.db.transaction((r: FollowRecord) => {
      this.db
        .prepare(
          `INSERT INTO follow_records (
             account_pk, target_pk, state, followed_at, followed_back_at,
             hold_until, unfollow_due_at, retry_count
           ) VALUES (
             @account_pk, @target_pk, @state, @followed_at, @followed_back_at,
             @hold_until, @unfollow_due_at, @retry_count
           )
           ON CONFLICT(account_pk) DO UPDATE SET
             target_pk = excluded.target_pk,
             state = excluded.state,
             followed_at = excluded.followed_at,
             followed_back_at = excluded.followed_back_at,
             hold_until = excluded.hold_until,
             unfollow_due_at = excluded.unfollow_due_at,
             retry_count = excluded.retry_count`,
        )
        .run({
          account_pk: r.accountPk,
          target_pk: orNull(r.targetPk),
          state: r.state,
          followed_at: orNull(r.followedAt),
          followed_back_at: orNull(r.followedBackAt),
          hold_until: orNull(r.holdUntil),
          unfollow_due_at: orNull(r.unfollowDueAt),
          retry_count: r.retryCount,
        });
    });
    tx(rec);
  }

  getFollowRecord(accountPk: string): FollowRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM follow_records WHERE account_pk = ?`)
      .get(accountPk) as FollowRecordRow | undefined;
    return row ? rowToFollowRecord(row) : null;
  }

  followRecordsByState(state: FollowState): FollowRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM follow_records WHERE state = ?`)
      .all(state) as FollowRecordRow[];
    return rows.map(rowToFollowRecord);
  }

  /** Every follow_record not yet in a terminal state. */
  activeFollowRecords(): FollowRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM follow_records WHERE state NOT IN ('unfollowed', 'abandoned', 'external')`,
      )
      .all() as FollowRecordRow[];
    return rows.map(rowToFollowRecord);
  }

  /** All account_pks that already have a follow_record (for candidate exclusion). */
  followRecordPks(): Set<string> {
    const rows = this.db
      .prepare(`SELECT account_pk FROM follow_records`)
      .all() as Array<{ account_pk: string }>;
    return new Set(rows.map((r) => r.account_pk));
  }

  /**
   * account_pks with a follow_record still in a NON-TERMINAL state — i.e. an
   * account the growth engine is actively managing (queued, awaiting a
   * follow-back, held after one, or already queued for its own unfollow). The
   * auto-prune routine excludes these from its candidate set so the two systems
   * never fight over the same account: growth owns its lifecycle end-to-end, and
   * prune only ever touches follows growth is NOT tracking (manual/external/legacy
   * follows). Terminal rows (`unfollowed`/`abandoned`/`external`) are NOT
   * included, so an account the user later re-follows by hand is fair game again.
   */
  activeFollowRecordPks(): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT account_pk FROM follow_records
         WHERE state NOT IN ('unfollowed', 'abandoned', 'external')`,
      )
      .all() as Array<{ account_pk: string }>;
    return new Set(rows.map((r) => r.account_pk));
  }

  /** src_pk of active `follows` edges pointing at the target (accounts that follow it). */
  followersOf(targetPk: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT src_pk FROM edges
         WHERE dst_pk = ? AND type = 'follows' AND status = 'active'`,
      )
      .all(targetPk) as Array<{ src_pk: string }>;
    return rows.map((r) => r.src_pk);
  }

  /** All account_pks the Scanner has rejected (`role = 'skipped'`) — pool exclusion. */
  private skippedPks(): Set<string> {
    const rows = this.db
      .prepare(`SELECT pk FROM accounts WHERE role = 'skipped'`)
      .all() as Array<{ pk: string }>;
    return new Set(rows.map((r) => r.pk));
  }

  /**
   * dst_pk of our own ACTIVE `follows` edges — every account we (or the user,
   * externally) currently follow. Empty set when the own pk is unset.
   */
  accountsWeFollow(): Set<string> {
    if (this.ownPk === null) return new Set();
    const rows = this.db
      .prepare(
        `SELECT dst_pk FROM edges
         WHERE src_pk = ? AND type = 'follows' AND status = 'active'`,
      )
      .all(this.ownPk) as Array<{ dst_pk: string }>;
    return new Set(rows.map((r) => r.dst_pk));
  }

  /**
   * Raw candidate pool for poaching a target: its active followers MINUS accounts
   * already in a follow_record MINUS accounts the Scanner rejected (`role='skipped'`,
   * R1.4 — the pool genuinely shrinks as candidates are evaluated, so the chain can
   * advance) MINUS accounts we already follow (never queue a relationship an external
   * actor — or we — already own) MINUS the target itself. The Scorer ranks these.
   */
  candidatePksForTarget(targetPk: string): string[] {
    const excluded = this.followRecordPks();
    const skipped = this.skippedPks();
    const followed = this.accountsWeFollow();
    return this.followersOf(targetPk).filter(
      (pk) => pk !== targetPk && !excluded.has(pk) && !skipped.has(pk) && !followed.has(pk),
    );
  }

  /**
   * Reconcile our OWN follow-status toward `pk` against a fresh observation, healing
   * divergence caused by an external actor (leave-alone policy). Never writes an
   * action_ledger row (reconciliation is not our action). Requires {@link setOwnPk};
   * no-ops with a one-time warn otherwise. Returns what it did (for logging/tests).
   */
  reconcileOwnFollow(
    pk: string,
    weFollow: boolean,
    at: number,
  ): 'noop' | 'dropped-queued' | 'dropped-held' | 'edge-only' {
    if (this.ownPk === null) {
      if (!this.warnedOwnPkUnset) {
        this.warnedOwnPkUnset = true;
        logger.warn('store.reconcileOwnFollow: ownPk unset, skipping');
      }
      return 'noop';
    }
    if (pk === this.ownPk) return 'noop'; // never reconcile self

    // Record the observed truth first — the edge is the ground state either way.
    this.observeEdge(this.ownPk, pk, 'follows', weFollow, at);

    const rec = this.getFollowRecord(pk);
    const held: readonly FollowState[] = ['pending_followback', 'followed_back', 'unfollow_queued'];
    if (rec !== null && held.includes(rec.state) && !weFollow) {
      // We believed we followed them, but we no longer do: an external actor
      // reverted the follow — back off rather than phantom-unfollow later.
      this.upsertFollowRecord({ ...rec, state: 'external' });
      this.setRole(pk, 'skipped');
      logger.info('store.reconcileOwnFollow: external unfollow detected, dropping held record', {
        pk,
        priorState: rec.state,
      });
      return 'dropped-held';
    }
    if (rec !== null && rec.state === 'queued' && weFollow) {
      // A queued candidate is already followed: the relationship belongs to an
      // external actor — never claim it (we would later unfollow THEIR follow).
      this.upsertFollowRecord({ ...rec, state: 'external' });
      this.setRole(pk, 'skipped');
      logger.info('store.reconcileOwnFollow: external follow detected, dropping queued candidate', {
        pk,
      });
      return 'dropped-queued';
    }
    return 'edge-only';
  }

  /**
   * Ingest a full auto-prune scan census into the shared graph so a scan also
   * ENRICHES the growth engine (Phase 5 — the two systems share one graph):
   *
   *  - every FOLLOWING pk is reconciled as one we currently follow, through the
   *    same leave-alone sink as {@link reconcileOwnFollow} (records the us→them
   *    edge and heals drift — e.g. drops a queued candidate an external actor
   *    already followed), and
   *  - every FOLLOWER pk gets a fresh `follows-us` edge, so follow-back detection
   *    (`getEdge(pk, ownPk, 'follows')`) and net-growth see the whole census the
   *    scan already paid to fetch.
   *
   * Purely ADDITIVE: it records the positive edges the scan observed and never
   * marks an absent account as removed (a bounded/interrupted scrape must not be
   * read as proof an account is gone). One transaction; self is always skipped;
   * a no-op with the standard warn when the own pk is unset.
   */
  ingestScanCensus(followingPks: string[], followerPks: string[], at: number): void {
    if (this.ownPk === null) {
      if (!this.warnedOwnPkUnset) {
        this.warnedOwnPkUnset = true;
        logger.warn('store.ingestScanCensus: ownPk unset, skipping');
      }
      return;
    }
    const own = this.ownPk;
    const tx = this.db.transaction(() => {
      for (const pk of followingPks) {
        if (pk === own) continue;
        this.reconcileOwnFollow(pk, true, at);
      }
      for (const pk of followerPks) {
        if (pk === own) continue;
        this.observeEdge(pk, own, 'follows', true, at);
      }
    });
    tx();
  }

  // --- Chain targets: targets table (§3.5) ---------------------------------------

  /** Insert or replace a chain target, keyed on account_pk. */
  addTarget(t: Target): void {
    this.db
      .prepare(
        `INSERT INTO targets (account_pk, source, status, chain_index)
         VALUES (@account_pk, @source, @status, @chain_index)
         ON CONFLICT(account_pk) DO UPDATE SET
           source = excluded.source,
           status = excluded.status,
           chain_index = excluded.chain_index`,
      )
      .run({
        account_pk: t.accountPk,
        source: t.source,
        status: t.status,
        chain_index: orNull(t.chainIndex ?? undefined),
      });
  }

  getTarget(accountPk: string): Target | null {
    const row = this.db
      .prepare(`SELECT * FROM targets WHERE account_pk = ?`)
      .get(accountPk) as TargetRow | undefined;
    return row ? rowToTarget(row) : null;
  }

  setTargetStatus(accountPk: string, status: Target['status']): void {
    this.db.prepare(`UPDATE targets SET status = ? WHERE account_pk = ?`).run(status, accountPk);
  }

  /** All chain targets ordered by chain_index (nulls last), then account_pk. */
  listTargets(): Target[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM targets
         ORDER BY chain_index IS NULL, chain_index ASC, account_pk ASC`,
      )
      .all() as TargetRow[];
    return rows.map(rowToTarget);
  }

  /** The next chain position: `(MAX(chain_index) ?? -1) + 1`. */
  nextChainIndex(): number {
    const row = this.db
      .prepare(`SELECT MAX(chain_index) AS m FROM targets`)
      .get() as { m: number | null };
    return (row.m ?? -1) + 1;
  }

  /**
   * Yield statistics for a poaching session against `targetPk` (§3.5), computed on
   * demand from follow_records + edges — the "analysis is an emergent query" principle.
   *
   * - `total`: follow_records aimed at the target that reached at least the
   *   pending-followback stage (i.e. we actually followed the candidate).
   * - `followedBack`: of those, the ones that reciprocated (non-null followed_back_at).
   * - `followBackRate`: followedBack / total (0 when total is 0).
   * - `poolSize`: active followers of the target (the raw poaching pool).
   * - `mutualOverlap`: target-followers we ALREADY actively follow (ownPk -> pk edge).
   */
  targetYield(
    targetPk: string,
    ownPk: string,
  ): {
    total: number;
    followedBack: number;
    followBackRate: number;
    poolSize: number;
    mutualOverlap: number;
  } {
    const counts = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           COUNT(followed_back_at) AS followed_back
         FROM follow_records
         WHERE target_pk = ?
           AND state IN ('pending_followback', 'followed_back', 'unfollow_queued', 'unfollowed')`,
      )
      .get(targetPk) as { total: number; followed_back: number };

    const total = counts.total;
    const followedBack = counts.followed_back;
    const followBackRate = total === 0 ? 0 : followedBack / total;

    const followers = this.followersOf(targetPk);
    const poolSize = followers.length;
    const mutualOverlap = followers.filter((pk) => {
      const edge = this.getEdge(ownPk, pk, 'follows');
      return edge !== null && edge.status === 'active';
    }).length;

    return { total, followedBack, followBackRate, poolSize, mutualOverlap };
  }

  /**
   * Cumulative net own-follower growth per day for the last `days` days.
   * gained = own-follower edges bucketed by first_seen_at; lost = removed
   * own-follower edges bucketed by last_confirmed_at. One entry per day,
   * oldest→newest, cumulativeNet running from 0. Epo-visible (from sweeps),
   * not Instagram's ground-truth total.
   */
  netGrowthSeries(days: number, ownPk: string): { dayStartMs: number; cumulativeNet: number }[] {
    if (days <= 0) return [];
    if (ownPk.length === 0) return [];

    // Local-midnight boundary of each day in the window, oldest→newest, with
    // today's local midnight last. Generated via Date arithmetic (not fixed ms
    // steps) so DST day-length changes never skew a bucket.
    const dayStarts: number[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - i);
      d.setHours(0, 0, 0, 0);
      dayStarts.push(d.getTime());
    }
    const windowStart = dayStarts[0];

    const rows = this.db
      .prepare(
        `SELECT first_seen_at AS at, 1 AS delta FROM edges
           WHERE dst_pk = ? AND type = 'follows' AND first_seen_at >= ?
         UNION ALL
         SELECT last_confirmed_at AS at, -1 AS delta FROM edges
           WHERE dst_pk = ? AND type = 'follows' AND status = 'removed'
             AND last_confirmed_at >= ?`,
      )
      .all(ownPk, windowStart, ownPk, windowStart) as { at: number; delta: number }[];

    // Sum deltas into their local-day slot (keyed by that day's local midnight).
    const perDay = new Map<number, number>();
    for (const row of rows) {
      const d = new Date(row.at);
      d.setHours(0, 0, 0, 0);
      const key = d.getTime();
      perDay.set(key, (perDay.get(key) ?? 0) + row.delta);
    }

    // Emit one point per day, carrying the running cumulative across empty days.
    let cumulativeNet = 0;
    return dayStarts.map((dayStartMs) => {
      cumulativeNet += perDay.get(dayStartMs) ?? 0;
      return { dayStartMs, cumulativeNet };
    });
  }

  /** Count of own-followers gained (candidates that reciprocated) since `sinceMs`,
   *  from follow_records.followed_back_at. Gain-only (no churn timestamp exists). */
  netFollowersSince(sinceMs: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM follow_records
           WHERE followed_back_at IS NOT NULL AND followed_back_at >= ?`,
      )
      .get(sinceMs) as { n: number };
    return row.n;
  }

  /** Assign a role to an account (e.g. 'target', 'me'); the accounts row must exist. */
  setRole(pk: string, role: string): void {
    this.db.prepare(`UPDATE accounts SET role = ? WHERE pk = ?`).run(role, pk);
  }

  // --- Scrape cursors: per-target pagination resume (R4) -------------------------

  /**
   * Upsert the followers-list resume cursor (`next_max_id`) for a target. A `null`
   * cursor is stored verbatim (the last page had no next cursor), so a later read
   * distinguishes "exhausted" from "never scraped" only by row presence.
   *
   * `at` is required (f8): callers pass their injected clock's time, so this write
   * can never silently bypass a FakeClock via a `Date.now()` default.
   */
  setScrapeCursor(targetPk: string, cursor: string | null, at: number): void {
    this.db
      .prepare(
        `INSERT INTO scrape_cursors (target_pk, cursor, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(target_pk) DO UPDATE SET
           cursor = excluded.cursor,
           updated_at = excluded.updated_at`,
      )
      .run(targetPk, cursor, at);
  }

  /** The stored resume cursor for a target, or `null` when absent or itself null. */
  getScrapeCursor(targetPk: string): string | null {
    const row = this.db
      .prepare(`SELECT cursor FROM scrape_cursors WHERE target_pk = ?`)
      .get(targetPk) as { cursor: string | null } | undefined;
    return row ? row.cursor : null;
  }

  close(): void {
    this.db.close();
  }
}
