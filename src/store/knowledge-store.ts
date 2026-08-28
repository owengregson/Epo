import type BetterSqlite3 from 'better-sqlite3';
import Database from 'better-sqlite3';
import { MS_PER_DAY, startOfLocalDay } from '../timing/units';
import * as logger from '../utils/logger';
import { runMigrations } from './migrations';
import { projectAccount } from './projections';
import {
  type AccountState,
  type Edge,
  type EdgeType,
  type EnrichmentLevel,
  type FollowRecord,
  type FollowState,
  type GraphAccountRow,
  type GraphCrowdRow,
  type GraphHubRow,
  type GraphRecordRow,
  type GraphSourceRows,
  type Observation,
  type PruneScanSnapshot,
  SOURCE_CONFIDENCE,
  type Source,
  type Target,
} from './types';

interface AccountRow {
  pk: string;
  username: string | null;
  enrichment: string;
  followers: number | null;
  following: number | null;
  ratio: number | null;
  mutuals: number | null;
  is_private: number | null;
  is_verified: number | null;
  activity_signal: number | null;
  bio: string | null;
  role: string | null;
  enrich_failed_at: number | null;
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
  score: number | null;
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

/**
 * Own-follower edges first seen within this window before a census verdict are
 * treated as discoveries of that census's OWN walk: the followers walk streams
 * each row into the graph as it parses (docs/PRINCIPLES.md §1), minutes to
 * hours before `ingestScanCensus` runs, so by census time the walk's rows are
 * indistinguishable from event-observed edges by anything but age. On the
 * FIRST census those discoveries are pre-existing stock, never growth.
 * Generous: no complete walk spans a day; the cost of over-covering is one
 * day of pre-census event gains absorbed as stock, exactly once.
 */
const FIRST_CENSUS_STOCK_WINDOW_MS = MS_PER_DAY;

const rowToState = (row: AccountRow): AccountState => ({
  pk: row.pk,
  username: strOrUndef(row.username),
  enrichment: row.enrichment as EnrichmentLevel,
  followers: numOrUndef(row.followers),
  following: numOrUndef(row.following),
  ratio: numOrUndef(row.ratio),
  mutuals: numOrUndef(row.mutuals),
  isPrivate: boolOrUndef(row.is_private),
  isVerified: boolOrUndef(row.is_verified),
  activitySignal: numOrUndef(row.activity_signal),
  bio: strOrUndef(row.bio),
  role: strOrUndef(row.role),
  enrichFailedAt: numOrUndef(row.enrich_failed_at),
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
  score: numOrUndef(row.score),
});

/**
 * The sole boundary to the SQLite knowledge graph. This is the ONLY module permitted
 * to import `better-sqlite3` or contain SQL. Every write funnels through `observe`/
 * `observeEdge`/`recordAction`; every read through the typed queries.
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
    // Retention: the raw observation log and username history are append-only
    // and nothing reads rows older than the projection they already fed —
    // unbounded, one sweep of a large account adds thousands of rows per day.
    // Keep a 90-day window (real wall-clock: retention is an operational
    // concern of THIS process, not of any injected test clock).
    const cutoff = Date.now() - 90 * 24 * 3600 * 1000;
    this.db.prepare(`DELETE FROM observations WHERE observed_at < ?`).run(cutoff);
    this.db.prepare(`DELETE FROM username_history WHERE seen_at < ?`).run(cutoff);
  }

  /**
   * Set the logged-in account's pk. Used only for the "already-following"
   * candidate exclusion ({@link accountsWeFollow}) and for anchoring the edges
   * that {@link reconcileOwnFollow} writes; keeps the constructor signature stable.
   */
  setOwnPk(pk: string): void {
    this.ownPk = pk;
  }

  // --- Mutation notifications (docs/PRINCIPLES.md §2 — the UI mirrors the graph) ----

  private readonly mutationListeners = new Set<() => void>();

  /**
   * Subscribe to "the graph changed" pulses: fired synchronously after every
   * public write (facts stream in per row, so this fires per row during scans/
   * sweeps — subscribers MUST throttle). This is what lets status projections
   * push while an operation is still running instead of when it ends. Returns
   * a disposer.
   */
  onMutation(listener: () => void): () => void {
    this.mutationListeners.add(listener);
    return () => {
      this.mutationListeners.delete(listener);
    };
  }

  /** Notify subscribers; a throwing listener is logged, never re-thrown into a write. */
  private changed(): void {
    for (const listener of [...this.mutationListeners]) {
      try {
        listener();
      } catch (e) {
        logger.error('store.onMutation listener threw', { error: String(e) });
      }
    }
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
             pk, username, enrichment, followers, following, ratio, mutuals,
             is_private, is_verified, activity_signal, bio,
             stats_observed_at, stats_source, first_seen_at, last_seen_at
           ) VALUES (
             @pk, @username, @enrichment, @followers, @following, @ratio, @mutuals,
             @is_private, @is_verified, @activity_signal, @bio,
             @stats_observed_at, @stats_source, @first_seen_at, @last_seen_at
           )
           ON CONFLICT(pk) DO UPDATE SET
             username = excluded.username,
             enrichment = excluded.enrichment,
             followers = excluded.followers,
             following = excluded.following,
             ratio = excluded.ratio,
             mutuals = excluded.mutuals,
             is_private = excluded.is_private,
             is_verified = excluded.is_verified,
             activity_signal = excluded.activity_signal,
             bio = excluded.bio,
             stats_observed_at = excluded.stats_observed_at,
             stats_source = excluded.stats_source,
             first_seen_at = excluded.first_seen_at,
             last_seen_at = excluded.last_seen_at,
             -- A successful stats read heals the enrichment-failure marker: the
             -- account is demonstrably fetchable again.
             enrich_failed_at = CASE WHEN excluded.followers IS NOT NULL
                                     THEN NULL ELSE accounts.enrich_failed_at END`,
        )
        .run({
          pk: next.pk,
          username: orNull(next.username),
          enrichment: next.enrichment,
          followers: orNull(next.followers),
          following: orNull(next.following),
          ratio: orNull(next.ratio),
          mutuals: orNull(next.mutuals),
          is_private: boolToInt(next.isPrivate),
          is_verified: boolToInt(next.isVerified),
          activity_signal: orNull(next.activitySignal),
          bio: orNull(next.bio),
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
    this.changed();
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
    this.changed();
  }

  getAccount(pk: string): AccountState | null {
    const row = this.db.prepare(`SELECT * FROM accounts WHERE pk = ?`).get(pk) as
      | AccountRow
      | undefined;
    return row ? rowToState(row) : null;
  }

  /**
   * The pk currently projected under `username` (case-insensitive; the
   * most-recently-seen row wins if a rename ever leaves two). Lets acquisition
   * resolve a known target without an Instagram request. `null` when unseen.
   */
  /**
   * Stamp `username`'s account as permanently un-enrichable (deleted/suspended/
   * unparseable profile body): enrichment batch selection skips marked accounts
   * so a dead account can never head-of-line-block the pool. Cleared by any
   * later successful stats observation (see the `observe` upsert).
   */
  markEnrichmentFailed(username: string, at: number): void {
    this.db
      .prepare(
        `UPDATE accounts SET enrich_failed_at = ? WHERE username = ? COLLATE NOCASE`,
      )
      .run(at, username);
    this.changed();
  }

  pkByUsername(username: string): string | null {
    const row = this.db
      .prepare(
        `SELECT pk FROM accounts WHERE username = ? COLLATE NOCASE
         ORDER BY last_seen_at DESC LIMIT 1`,
      )
      .get(username) as { pk: string } | undefined;
    return row?.pk ?? null;
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
    this.changed();
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
    this.changed();
  }

  pruneCountSince(sinceMs: number): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM prune_ledger WHERE at >= ?`)
      .get(sinceMs) as { c: number };
    return row.c;
  }

  /**
   * REAL prune actions since `sinceMs` — `ok`/`fail` rows only, excluding
   * `simulated` (dry-run intent never touched Instagram). This is what the rate
   * governor adds to the growth ledger so the hard ceiling caps the ACCOUNT's
   * total write volume, not just one driver's share.
   */
  realPruneActionCountSince(sinceMs: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM prune_ledger WHERE at >= ? AND result IN ('ok', 'fail')`,
      )
      .get(sinceMs) as { c: number };
    return row.c;
  }

  // --- Prune scan snapshot (Phase 5 persistence) ----------------------------------

  /** Replace the durable prune-scan snapshot (singleton) with this one — one tx. */
  savePruneScan(snap: PruneScanSnapshot): void {
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM prune_scan`).run();
      this.db.prepare(`DELETE FROM prune_scan_remaining`).run();
      this.db
        .prepare(
          `INSERT INTO prune_scan (id, at, following_count, followers_count, candidate_count)
           VALUES (1, ?, ?, ?, ?)`,
        )
        .run(snap.at, snap.following, snap.followers, snap.candidateCount);
      const insert = this.db.prepare(`INSERT INTO prune_scan_remaining (pk, username) VALUES (?, ?)`);
      for (const cand of snap.remaining) insert.run(cand.pk, cand.username);
    });
    tx();
    this.changed();
  }

  /** The persisted prune-scan snapshot, or null when no scan has been saved. */
  getPruneScan(): PruneScanSnapshot | null {
    const meta = this.db
      .prepare(`SELECT at, following_count, followers_count, candidate_count FROM prune_scan WHERE id = 1`)
      .get() as
      | { at: number; following_count: number; followers_count: number; candidate_count: number }
      | undefined;
    if (meta === undefined) return null;
    const rows = this.db
      .prepare(`SELECT pk, username FROM prune_scan_remaining ORDER BY rowid`)
      .all() as Array<{ pk: string; username: string | null }>;
    return {
      at: meta.at,
      following: meta.following_count,
      followers: meta.followers_count,
      candidateCount: meta.candidate_count,
      remaining: rows,
    };
  }

  /** A run visited this candidate — drop it from the durable remaining set. */
  consumePruneScanCandidate(pk: string): void {
    this.db.prepare(`DELETE FROM prune_scan_remaining WHERE pk = ?`).run(pk);
    this.changed();
  }

  /** Forget the snapshot entirely (new scan starting, or whitelist change). */
  clearPruneScan(): void {
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM prune_scan`).run();
      this.db.prepare(`DELETE FROM prune_scan_remaining`).run();
    });
    tx();
    this.changed();
  }

  // --- Churn lifecycle: follow_records (§3.4) ------------------------------------

  /** Insert or fully replace a churn-lifecycle record, keyed on account_pk. */
  upsertFollowRecord(rec: FollowRecord): void {
    const tx = this.db.transaction((r: FollowRecord) => {
      this.db
        .prepare(
          `INSERT INTO follow_records (
             account_pk, target_pk, state, followed_at, followed_back_at,
             hold_until, unfollow_due_at, retry_count, score
           ) VALUES (
             @account_pk, @target_pk, @state, @followed_at, @followed_back_at,
             @hold_until, @unfollow_due_at, @retry_count, @score
           )
           ON CONFLICT(account_pk) DO UPDATE SET
             target_pk = excluded.target_pk,
             state = excluded.state,
             followed_at = excluded.followed_at,
             followed_back_at = excluded.followed_back_at,
             hold_until = excluded.hold_until,
             unfollow_due_at = excluded.unfollow_due_at,
             retry_count = excluded.retry_count,
             -- Preserve a known score through state transitions: a later upsert
             -- that omits the score (undefined → null) must not wipe it.
             score = COALESCE(excluded.score, follow_records.score)`,
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
          score: orNull(r.score),
        });
    });
    tx(rec);
    this.changed();
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

  /** How many followers of `targetPk` we have observed so far (active edges into it). */
  observedFollowerCount(targetPk: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM edges
         WHERE dst_pk = ? AND type = 'follows' AND status = 'active'`,
      )
      .get(targetPk) as { n: number };
    return row.n;
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
   * actor — or we — already own) MINUS the target itself MINUS our OWN account (we
   * appear in the followers list of any target we follow — never a candidate).
   * The Scorer ranks these.
   */
  candidatePksForTarget(targetPk: string): string[] {
    const excluded = this.followRecordPks();
    const skipped = this.skippedPks();
    const followed = this.accountsWeFollow();
    return this.followersOf(targetPk).filter(
      (pk) =>
        pk !== targetPk &&
        pk !== this.ownPk &&
        !excluded.has(pk) &&
        !skipped.has(pk) &&
        !followed.has(pk),
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

  // --- Durable meta (migration 5) -------------------------------------------------

  private getMeta(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  /** Set-once write: an existing value is never overwritten (baseline semantics). */
  private setMetaOnce(key: string, value: string): void {
    this.db.prepare(`INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)`).run(key, value);
  }

  /** Mutable meta write (upsert); `null` deletes the key. */
  private setMeta(key: string, value: string | null): void {
    if (value === null) {
      this.db.prepare(`DELETE FROM meta WHERE key = ?`).run(key);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  /**
   * Persist the inter-action paced-delay deadline (epoch ms) so the pacing
   * survives an app restart: a relaunch resumes the remaining wait instead of
   * acting immediately (same contract as pause/resume, but durable). `null`
   * clears it (the delay fully elapsed).
   */
  setActionDelayDeadline(at: number | null): void {
    this.setMeta('action_delay_deadline_at', at === null ? null : String(at));
  }

  /** The persisted inter-action delay deadline, or `null` when none is owed. */
  getActionDelayDeadline(): number | null {
    const raw = this.getMeta('action_delay_deadline_at');
    if (raw === null) return null;
    const at = Number(raw);
    return Number.isFinite(at) ? at : null;
  }

  /**
   * Persist the SessionPlanner's durable snapshot (raw JSON) so the organic pacing
   * model resumes exactly across a restart (§3): the current day's target, session
   * plan, owed within-session state, and the trailing-hour action ring all survive.
   * `null` clears it. Opaque to the store — the planner owns the shape.
   */
  setPacingState(raw: string | null): void {
    this.setMeta('pacing_state', raw);
  }

  /** The persisted SessionPlanner snapshot JSON, or `null` when none exists. */
  getPacingState(): string | null {
    return this.getMeta('pacing_state');
  }

  /**
   * The moment follower measurement began — the first follow-back sweep or the
   * first complete census, whichever ran first — or `null` before either.
   * Everything first seen AT or BEFORE this moment is pre-existing STOCK — the
   * net-growth series only counts edge events strictly after it.
   */
  followersBaselineAt(): number | null {
    const raw = this.getMeta('followers_baseline_at');
    if (raw === null) return null;
    const at = Number(raw);
    return Number.isFinite(at) ? at : null;
  }

  /**
   * Establish the followers baseline at `at` if none exists yet (set-once; a
   * later call never moves it). Called at the top of every follow-back sweep
   * (`FollowbackWatcher.check`) and by every {@link observeOwnFollowerEvent},
   * so the FIRST moment follower collection begins stamps the stock/growth
   * boundary — without this, weeks of event-observed followers would be
   * erased retroactively by a late first prune scan (whose census would stamp
   * the baseline after the fact and re-classify every prior gain as stock).
   * When a census genuinely IS the first collection, {@link ingestScanCensus}
   * stamps the baseline itself.
   */
  ensureFollowersBaseline(at: number): void {
    if (this.followersBaselineAt() !== null) return;
    this.setMetaOnce('followers_baseline_at', String(at));
    logger.info('store: followers baseline established', { at });
    this.changed();
  }

  /**
   * Record a dated "they follow us" EVENT — a notifications follow entry or an
   * accepted follow request. Ensures the growth baseline exists FIRST: an
   * event stream is measurement, and measurement must be anchored before its
   * facts land, or a late first census would re-classify them as pre-existing
   * stock. The sweep loop also stamps the baseline up front
   * (`FollowbackWatcher.check`), so under normal wiring the ensure here is an
   * idempotent no-op — it exists so any event-recording path is safe by
   * construction. When an event IS the first-ever observation, it becomes the
   * boundary itself: it lands exactly at the baseline and counts as stock.
   *
   * List-walk observations (a followers-list row proves present membership,
   * not when the follow happened) must NOT come through here — they use plain
   * {@link observeEdge} and the census's stock accounting.
   */
  observeOwnFollowerEvent(srcPk: string, ownPk: string, at: number): void {
    this.ensureFollowersBaseline(at);
    this.observeEdge(srcPk, ownPk, 'follows', true, at);
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
   * FACTS STREAM (docs/PRINCIPLES.md §1): the scan SOURCES already write each
   * row's profile + positive edge the moment it is parsed, so by the time this
   * runs the additive half below is an idempotent re-confirmation — it stays
   * because fake/alternate sources may not stream, and re-observing is free.
   * What genuinely BELONGS here is the absence-based half: verdicts drawn from
   * what a COMPLETE census did NOT contain.
   *
   * ADDITIVE by default: it records the positive edges the scan observed and
   * never marks an absent account as removed. When `authoritative` is true —
   * callers pass it ONLY for a census whose walks both reported genuine
   * completion — absence IS evidence, and the census also heals the negative
   * side of the graph:
   *
   *  - an active `pk → own` edge whose pk is NOT in the followers census is a
   *    follower we LOST → marked removed (this is what makes the net-growth
   *    series' loss branch live at all), and
   *  - an active `own → pk` edge whose pk is NOT in the following census is a
   *    follow that no longer exists → reconciled as not-following — EXCEPT
   *    accounts whose follow record is `pending_followback`: an outstanding
   *    request to a private account never appears in the following list, and
   *    treating that as "unfollowed" would destroy the record.
   *
   * One transaction; self is always skipped; a no-op with the standard warn
   * when the own pk is unset.
   */
  ingestScanCensus(
    followingPks: string[],
    followerPks: string[],
    at: number,
    opts?: { authoritative?: boolean },
  ): void {
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

      if (opts?.authoritative === true) {
        const followerSet = new Set(followerPks);
        const followingSet = new Set(followingPks);
        // Followers we lost: active pk→own edges absent from the complete census.
        const lost = this.db
          .prepare(
            `SELECT src_pk FROM edges
             WHERE dst_pk = ? AND type = 'follows' AND status = 'active'`,
          )
          .all(own) as Array<{ src_pk: string }>;
        for (const { src_pk } of lost) {
          if (src_pk === own || followerSet.has(src_pk)) continue;
          this.observeEdge(src_pk, own, 'follows', false, at);
        }
        // Follows that no longer exist: active own→pk edges absent from the
        // complete census — skipping outstanding private-account requests.
        const gone = this.db
          .prepare(
            `SELECT dst_pk FROM edges
             WHERE src_pk = ? AND type = 'follows' AND status = 'active'`,
          )
          .all(own) as Array<{ dst_pk: string }>;
        for (const { dst_pk } of gone) {
          if (dst_pk === own || followingSet.has(dst_pk)) continue;
          if (this.getFollowRecord(dst_pk)?.state === 'pending_followback') continue;
          this.reconcileOwnFollow(dst_pk, false, at);
        }
      }
      // The FIRST complete census draws the stock/growth boundary WITHOUT
      // erasing growth observed before it (follow events stream in from the
      // notifications feed long before a user's first scan — see
      // {@link ensureFollowersBaseline}), same tx, set-once marker:
      //
      //  - The BASELINE, when none exists yet, lands at the census time — but
      //    never above growth already observed: any own-follower edge first
      //    seen BEFORE this census's own walk window pushes the baseline to
      //    just below that edge (defense in depth for a collection path that
      //    forgot ensureFollowersBaseline — pre-census event-time gains
      //    survive instead of being re-classified as stock).
      //  - The census's own discoveries — edges first seen inside the walk
      //    window, whether streamed by the walk or bulk-written above — are
      //    pre-existing STOCK wherever the baseline sits: they are re-dated
      //    onto the baseline so the strictly-after growth filter can never
      //    chart the initial stock as a one-day cliff.
      //
      // Later censuses skip all of this: the baseline is set-once, and a new
      // follower a later census discovers is a genuine (event-less) gain,
      // charted on its census day.
      if (this.getMeta('followers_census_at') === null) {
        const stockWindowStart = at - FIRST_CENSUS_STOCK_WINDOW_MS;
        let baselineAt = this.followersBaselineAt();
        if (baselineAt === null) {
          const earliest = this.db
            .prepare(
              `SELECT MIN(first_seen_at) AS m FROM edges
               WHERE dst_pk = ? AND type = 'follows' AND first_seen_at < ?`,
            )
            .get(own, stockWindowStart) as { m: number | null };
          baselineAt = earliest.m === null ? at : Math.min(at, earliest.m - 1);
          this.setMetaOnce('followers_baseline_at', String(baselineAt));
          logger.info('store: followers baseline established by first census', {
            baselineAt,
            censusAt: at,
            followers: followerPks.length,
          });
        }
        this.db
          .prepare(
            `UPDATE edges SET first_seen_at = ?
             WHERE dst_pk = ? AND type = 'follows' AND status = 'active'
               AND first_seen_at >= ? AND first_seen_at <= ? AND first_seen_at > ?`,
          )
          .run(baselineAt, own, stockWindowStart, at, baselineAt);
        this.setMetaOnce('followers_census_at', String(at));
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
    this.changed();
  }

  getTarget(accountPk: string): Target | null {
    const row = this.db
      .prepare(`SELECT * FROM targets WHERE account_pk = ?`)
      .get(accountPk) as TargetRow | undefined;
    return row ? rowToTarget(row) : null;
  }

  setTargetStatus(accountPk: string, status: Target['status']): void {
    this.db.prepare(`UPDATE targets SET status = ? WHERE account_pk = ?`).run(status, accountPk);
    this.changed();
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
   *
   * Baseline-aware: once a followers baseline exists (measurement start — the
   * first sweep or first census, see {@link followersBaselineAt}), only events
   * STRICTLY AFTER it count. The first census's own discoveries sit AT the
   * baseline (re-dated stock — see {@link ingestScanCensus}), so initializing
   * the app never charts a one-day cliff, while event-time gains observed
   * before that census keep charting on the days they actually happened.
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

    // Events at or before the baseline are stock, not growth (−1 keeps the
    // strict `>` inclusive-of-everything when no baseline exists yet).
    const baselineAt = this.followersBaselineAt() ?? -1;
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
      .all(ownPk, windowStart, baselineAt, ownPk, windowStart, baselineAt) as {
      at: number;
      delta: number;
    }[];

    // Sum deltas into their local-day slot (keyed by that day's local midnight).
    const perDay = new Map<number, number>();
    for (const row of rows) {
      const key = startOfLocalDay(row.at);
      perDay.set(key, (perDay.get(key) ?? 0) + row.delta);
    }

    // Emit one point per day, carrying the running cumulative across empty days.
    let cumulativeNet = 0;
    return dayStarts.map((dayStartMs) => {
      cumulativeNet += perDay.get(dayStartMs) ?? 0;
      return { dayStartMs, cumulativeNet };
    });
  }

  /**
   * TRUE net own-follower delta since `sinceMs`: followers gained (own-follower
   * edges first seen in the window) minus followers lost (own-follower edges
   * marked removed in the window). Baseline-aware like {@link netGrowthSeries},
   * so pre-existing stock never counts as a gain. 0 when the own pk is unset.
   */
  netFollowersSince(sinceMs: number): number {
    if (this.ownPk === null) return 0;
    const baselineAt = this.followersBaselineAt() ?? -1;
    const row = this.db
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
      .get({ own: this.ownPk, since: sinceMs, baseline: baselineAt }) as { n: number };
    return row.n;
  }

  /** account_pks of every chain target (any status) — prune must never touch
   *  the chain's own anchors, followed deliberately and retained. */
  /**
   * LIVE relationship counts from the graph as it stands right now (docs/
   * PRINCIPLES.md §2 — the UI mirrors the graph). Because scan sources stream
   * every row's edge as it parses, these tick DURING a prune scan: `following`
   * / `followers` grow page by page, and `notFollowingBack` moves live as
   * reciprocation knowledge lands. Zeroes until {@link setOwnPk}.
   */
  relationshipCounts(): { following: number; followers: number; notFollowingBack: number } {
    if (this.ownPk === null) return { following: 0, followers: 0, notFollowingBack: 0 };
    const following = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM edges
           WHERE src_pk = ? AND type = 'follows' AND status = 'active'`,
        )
        .get(this.ownPk) as { c: number }
    ).c;
    const followers = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM edges
           WHERE dst_pk = ? AND type = 'follows' AND status = 'active'`,
        )
        .get(this.ownPk) as { c: number }
    ).c;
    const notFollowingBack = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM edges e
           WHERE e.src_pk = ? AND e.type = 'follows' AND e.status = 'active'
             AND NOT EXISTS (
               SELECT 1 FROM edges b
               WHERE b.src_pk = e.dst_pk AND b.dst_pk = e.src_pk
                 AND b.type = 'follows' AND b.status = 'active'
             )`,
        )
        .get(this.ownPk) as { c: number }
    ).c;
    return { following, followers, notFollowingBack };
  }

  /**
   * Everything the Graph view's snapshot shaper reads, in one call: the chain
   * targets (the cluster hubs), every follow_record, every observed follower
   * of a chain target, and both sides of our own relationship edges — each
   * joined to its account row for username/followers. Bulk JOINed reads on
   * purpose: the view holds tens of thousands of nodes, so per-pk lookups
   * would dominate. Row order of `hubs`/`crowd` is CHAIN order, which the
   * shaper relies on ("first hub wins" when an account follows several
   * targets). Null until {@link setOwnPk} (pre-login there is no graph to
   * anchor).
   */
  graphSnapshotRows(): GraphSourceRows | null {
    if (this.ownPk === null) return null;
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
      .all(this.ownPk) as GraphAccountRow[];
    const ownFollowing = this.db
      .prepare(
        `SELECT e.dst_pk AS pk, a.username AS username, a.followers AS followers
         FROM edges e LEFT JOIN accounts a ON a.pk = e.dst_pk
         WHERE e.src_pk = ? AND e.type = 'follows' AND e.status = 'active'`,
      )
      .all(this.ownPk) as GraphAccountRow[];
    return {
      ownPk: this.ownPk,
      ownUsername: this.getAccount(this.ownPk)?.username ?? null,
      hubs,
      records,
      crowd,
      ownFollowers,
      ownFollowing,
    };
  }

  targetPks(): Set<string> {
    const rows = this.db
      .prepare(`SELECT account_pk FROM targets`)
      .all() as Array<{ account_pk: string }>;
    return new Set(rows.map((r) => r.account_pk));
  }

  /** Assign a role to an account (e.g. 'target', 'me'); the accounts row must exist. */
  setRole(pk: string, role: string): void {
    this.db.prepare(`UPDATE accounts SET role = ? WHERE pk = ?`).run(role, pk);
    this.changed();
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
