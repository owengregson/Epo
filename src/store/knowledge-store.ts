import * as logger from '../utils/logger';
import { Chronos } from './chronos';
import type { SqliteDriver } from './driver/driver';
import { openDatabase } from './driver/index';
import { runMigrations } from './migrations';
import { AccountRepo } from './repos/accounts';
import { AnalyticsRepo, type GrowthPoint, type TargetYield } from './repos/analytics';
import { type CensusAuthority, CensusRepo, type ReconcileOutcome } from './repos/census';
import { CursorRepo } from './repos/cursors';
import { FollowRecordRepo, type HealResult } from './repos/follow-records';
import { LedgerRepo } from './repos/ledgers';
import { MetaRepo } from './repos/meta';
import { PruneScanRepo } from './repos/prune-scan';
import { type RelationshipCounts, RelationshipRepo } from './repos/relationships';
import { TargetRepo } from './repos/targets';
import { assertSchema } from './schema/manifest';
import { SpanSink } from './spans';
import type {
  AccountState,
  Edge,
  EdgeType,
  FollowbackTiming,
  FollowRecord,
  FollowState,
  GraphSourceRows,
  Observation,
  PruneScanSnapshot,
  Target,
  TargetFunnelRead,
} from './types';

/**
 * The last COMPLETE prune census: the settled counts of the most recent scan
 * that verifiably walked both lists to the end, plus the scraped basis every
 * derived composition figure rests on. Persisted in the meta table (see
 * {@link KnowledgeStore.savePruneCensus}) so it survives relaunch, and only
 * ever replaced by the NEXT complete scan — an aborted or failed scan and a
 * run that consumes the candidate rows all leave it standing.
 */
export interface PruneCensusRecord {
  /** Epoch ms the census-completing scan finished. */
  at: number;
  /** Display counts: scraped list + ghost buffer = the numbers Instagram's
   *  own profile header shows (see the GHOST BUFFER note in prune-engine). */
  following: number;
  followers: number;
  /** The walked lists' true sizes — what the list API actually returned. The
   *  gap to `following`/`followers` is deactivated/unavailable accounts the
   *  header still counts but the list never resolves ("unresolvable"). */
  scrapedFollowing: number;
  scrapedFollowers: number;
  /** Scraped follows of ours with no reciprocal follower row (self excluded). */
  notFollowingBack: number;
  /** Of those, the raw prune census: growth-managed accounts and chain targets
   *  excluded, whitelist NOT applied (the runnable set derives from it live). */
  candidates: number;
}

/** Ambient dependencies a store may take instead of reaching for globals. */
export interface KnowledgeStoreOptions {
  /** Wall clock; defaults to `Date.now`. */
  now?: () => number;
  /** Uniform [0,1) source; defaults to `Math.random`. */
  rng?: () => number;
}

/**
 * The sole boundary to the SQLite knowledge graph — the only place outside
 * `src/store/**` may reach for persistence. The engine underneath is reached
 * only through the `SqliteDriver` port, so no other file names a DB vendor.
 *
 * This class holds almost no SQL of its own. It opens the database, owns the
 * `onMutation` pulse and the own-account anchor, and delegates each table to a
 * repo under `src/store/repos/`. Its whole public surface is kept intact on
 * purpose: 22 consumers across four layers take the class, so the split had to
 * be invisible to every one of them.
 *
 * When you add a method here it should be a delegation. Real SQL belongs in a
 * repo; a write that spans several tables belongs in `CensusRepo`.
 */
export class KnowledgeStore {
  private readonly db: SqliteDriver;
  /** The `meta` key/value table (durable scalars), behind its typed manifest. */
  private readonly meta: MetaRepo;
  /** The two append-only action ledgers (`action_ledger`, `prune_ledger`). */
  private readonly ledgers: LedgerRepo;
  /** The durable prune-scan snapshot and its unvisited candidate set. */
  private readonly pruneScan: PruneScanRepo;
  /** Per-target followers-list resume cursors. */
  private readonly cursors: CursorRepo;
  /** The poaching chain's targets table. */
  private readonly targets: TargetRepo;
  /** The churn lifecycle table (`follow_records`). */
  private readonly records: FollowRecordRepo;
  /** The account projection and its append-only inputs. */
  private readonly accounts: AccountRepo;
  /** The `edges` table plus the followers baseline. */
  private readonly relationships: RelationshipRepo;
  /** Read-only analysis over the whole graph. */
  private readonly analytics: AnalyticsRepo;
  /** The two write paths that span several tables (reconcile, census ingest). */
  private readonly census: CensusRepo;
  /** Durable timers and the span log (migration 12); consumed in wave B. */
  readonly chronos: Chronos;
  readonly spans: SpanSink;
  /** Wall clock for time-derived reads; injectable so those reads are testable. */
  private readonly now: () => number;
  /** Uniform [0,1) source, injectable so a drawn seed can be pinned in tests. */
  private readonly rng: () => number;
  /** Our own account pk, set at build time via {@link setOwnPk}; null until then. */
  private ownPk: string | null = null;
  /** One-time guard so an unset ownPk warns once, not on every reconciliation. */
  private warnedOwnPkUnset = false;

  constructor(dbPath: string, opts: KnowledgeStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.rng = opts.rng ?? Math.random;
    // The driver applies WAL + `synchronous = FULL` + `foreign_keys = ON`, then
    // proves them with a round-trip self-test — it throws rather than hand back
    // a database that quietly lost durability. `assertSchema` then checks every
    // live table against its declaration, so a migration that adds a column
    // without a manifest entry fails HERE, not at the first read.
    this.db = openDatabase(dbPath);
    runMigrations(this.db);
    assertSchema(this.db);
    const changed = () => this.changed();
    this.meta = new MetaRepo(this.db);
    this.ledgers = new LedgerRepo(this.db, changed);
    this.pruneScan = new PruneScanRepo(this.db, changed);
    this.cursors = new CursorRepo(this.db);
    this.targets = new TargetRepo(this.db, changed);
    this.records = new FollowRecordRepo(this.db, changed);
    this.accounts = new AccountRepo(this.db, changed);
    this.accounts.pruneAppendOnlyLogs();
    this.relationships = new RelationshipRepo(this.db, changed, this.meta);
    this.analytics = new AnalyticsRepo(this.db, () => this.relationships.baselineAt());
    this.chronos = new Chronos(this.db, { now: this.now });
    this.spans = new SpanSink(this.db, { now: this.now, rng: this.rng });
    this.census = new CensusRepo(this.db, this.accounts, this.records, this.relationships, this.meta);
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

  // --- Accounts and edges (via AccountRepo / RelationshipRepo) --------------------

  /**
   * Warn ONCE that the own pk is unset, then no-op. Every own-relationship path
   * needs the anchor; a per-call warn would drown a scan's log in one line per
   * row.
   */
  private warnOwnPkUnset(where: string): 'noop' {
    if (!this.warnedOwnPkUnset) {
      this.warnedOwnPkUnset = true;
      logger.warn(`store.${where}: ownPk unset, skipping`);
    }
    return 'noop';
  }

  /**
   * Append an observation and re-project the account row in one transaction —
   * the single write path that keeps the event log and projection consistent.
   */
  observe(obs: Observation): void {
    this.accounts.observe(obs);
  }

  /** Upsert a directed edge, dating first/last seen and its active/removed status. */
  observeEdge(srcPk: string, dstPk: string, type: EdgeType, active: boolean, at: number): void {
    this.relationships.observeEdge(srcPk, dstPk, type, active, at);
  }

  getAccount(pk: string): AccountState | null {
    return this.accounts.get(pk);
  }

  /**
   * Stamp `username`'s account as permanently un-enrichable (deleted, suspended,
   * unparseable profile body) so enrichment selection skips it. Cleared by any
   * later successful stats observation.
   */
  markEnrichmentFailed(username: string, at: number): void {
    this.accounts.markEnrichmentFailed(username, at);
  }

  /**
   * The pk currently projected under `username` (case-insensitive). Lets
   * acquisition resolve a known target without an Instagram request.
   */
  pkByUsername(username: string): string | null {
    return this.accounts.pkByUsername(username);
  }

  /** Assign a role to an account (e.g. 'target', 'me'); the accounts row must exist. */
  setRole(pk: string, role: string): void {
    this.accounts.setRole(pk, role);
  }

  getEdge(srcPk: string, dstPk: string, type: EdgeType): Edge | null {
    return this.relationships.getEdge(srcPk, dstPk, type);
  }

  // --- Action ledgers (via LedgerRepo) --------------------------------------------

  recordAction(
    accountPk: string,
    action: 'follow' | 'unfollow',
    result: 'ok' | 'fail',
    at: number,
  ): void {
    this.ledgers.recordAction(accountPk, action, result, at);
  }

  actionCountSince(sinceMs: number): number {
    return this.ledgers.actionCountSince(sinceMs);
  }

  /**
   * Follows that actually LANDED since `sinceMs` — the realized-pace numerator
   * the Targets console's runway divides by (unfollows and failures excluded).
   */
  followActionCountSince(sinceMs: number): number {
    return this.ledgers.followActionCountSince(sinceMs);
  }

  /** Append one auto-prune attempt to the prune ledger (its own daily cap). */
  recordPruneAction(accountPk: string, result: 'ok' | 'fail' | 'simulated', at: number): void {
    this.ledgers.recordPruneAction(accountPk, result, at);
  }

  pruneCountSince(sinceMs: number): number {
    return this.ledgers.pruneCountSince(sinceMs);
  }

  /**
   * REAL prune actions since `sinceMs` — `ok`/`fail` only, `simulated`
   * excluded. What the rate governor adds to the growth ledger so the hard
   * ceiling caps the ACCOUNT's total write volume, not one driver's share.
   */
  realPruneActionCountSince(sinceMs: number): number {
    return this.ledgers.realPruneActionCountSince(sinceMs);
  }

  // --- Prune scan snapshot (via PruneScanRepo) -----------------------------------

  /** Replace the durable prune-scan snapshot (singleton) with this one. */
  savePruneScan(snap: PruneScanSnapshot): void {
    this.pruneScan.save(snap);
  }

  /** The persisted prune-scan snapshot, or null when no scan has been saved. */
  getPruneScan(): PruneScanSnapshot | null {
    return this.pruneScan.get();
  }

  /** A run visited this candidate — drop it from the durable remaining set. */
  consumePruneScanCandidate(pk: string): void {
    this.pruneScan.consumeCandidate(pk);
  }

  /** Forget the snapshot entirely (new scan starting, or whitelist change). */
  clearPruneScan(): void {
    this.pruneScan.clear();
  }

  /** How many raw census rows a run has not yet visited (0 when no snapshot). */
  pruneScanRemainingCount(): number {
    return this.pruneScan.remainingCount();
  }

  // --- Last complete prune census (meta-backed) ------------------------------------

  /**
   * Replace the durable last-COMPLETE-census record. Kept SEPARATE from the
   * runnable-scan snapshot above on purpose: the snapshot's candidate rows are
   * consumed by runs and replaced by the next scan, while THIS record is the
   * settled whole-list census a finished scan produced — the display truth the
   * prune panel anchors on. It is only ever replaced by the next COMPLETE scan,
   * so an aborted/failed scan and a consumed run all leave it standing, and it
   * survives relaunch (docs/PRINCIPLES.md §3) via the meta table.
   */
  savePruneCensus(census: PruneCensusRecord): void {
    this.meta.setJson('pruneLastCensus', census);
    this.changed();
  }

  /** The persisted last-complete census, or null when no scan ever completed. */
  getPruneCensus(): PruneCensusRecord | null {
    return this.meta.json<PruneCensusRecord>('pruneLastCensus');
  }

  // --- Churn lifecycle: follow_records (via FollowRecordRepo) ---------------------

  /** Insert or fully replace a churn-lifecycle record, keyed on account_pk. */
  upsertFollowRecord(rec: FollowRecord): void {
    this.records.upsert(rec);
  }

  getFollowRecord(accountPk: string): FollowRecord | null {
    return this.records.get(accountPk);
  }

  followRecordsByState(state: FollowState): FollowRecord[] {
    return this.records.byState(state);
  }

  /** Every follow_record not yet in a terminal state. */
  activeFollowRecords(): FollowRecord[] {
    return this.records.active();
  }

  /** All account_pks that already have a follow_record (for candidate exclusion). */
  followRecordPks(): Set<string> {
    return this.records.pks();
  }

  /**
   * account_pks the growth engine is ACTIVELY managing. The auto-prune routine
   * excludes these so the two systems never fight over the same account.
   */
  activeFollowRecordPks(): Set<string> {
    return this.records.activePks();
  }

  /**
   * Requeue `abandoned` records whose abandonment fell inside a CLOSED
   * systemic-incident window — the recovery healer's store half. Each record
   * heals at most once, ever; see {@link FollowRecordRepo.healAbandonedInWindow}.
   */
  healAbandonedInWindow(opts: {
    windowStartMs: number;
    windowEndMs: number;
    cap: number;
    now: number;
  }): HealResult {
    return this.records.healAbandonedInWindow(opts);
  }

  /** src_pk of active `follows` edges pointing at the target (accounts that follow it). */
  followersOf(targetPk: string): string[] {
    return this.relationships.followersOf(targetPk);
  }

  /** How many followers of `targetPk` we have observed so far (active edges into it). */
  observedFollowerCount(targetPk: string): number {
    return this.relationships.observedFollowerCount(targetPk);
  }

  /**
   * dst_pk of our own ACTIVE `follows` edges — every account we (or the user,
   * externally) currently follow. Empty set when the own pk is unset.
   */
  accountsWeFollow(): Set<string> {
    return this.ownPk === null ? new Set() : this.relationships.accountsWeFollow(this.ownPk);
  }

  /**
   * Raw candidate pool for poaching a target: its active followers MINUS accounts
   * already in a follow_record MINUS accounts the Scanner rejected (`role='skipped'`
   * — the pool genuinely shrinks as candidates are evaluated, so the chain can
   * advance) MINUS accounts we already follow (never queue a relationship an
   * external actor — or we — already own) MINUS the target itself MINUS our OWN
   * account (we appear in the followers list of any target we follow). The
   * Scorer ranks these.
   */
  candidatePksForTarget(targetPk: string): string[] {
    const excluded = this.records.pks();
    const skipped = this.accounts.skippedPks();
    const followed = this.accountsWeFollow();
    return this.relationships
      .followersOf(targetPk)
      .filter(
        (pk) =>
          pk !== targetPk &&
          pk !== this.ownPk &&
          !excluded.has(pk) &&
          !skipped.has(pk) &&
          !followed.has(pk),
      );
  }

  /**
   * Reconcile our OWN follow-status toward `pk` against a fresh observation,
   * healing divergence an external actor caused (leave-alone policy). Requires
   * {@link setOwnPk}; no-ops with a one-time warn otherwise.
   */
  reconcileOwnFollow(pk: string, weFollow: boolean, at: number): ReconcileOutcome {
    if (this.ownPk === null) return this.warnOwnPkUnset('reconcileOwnFollow');
    return this.census.reconcileOwnFollow(this.ownPk, pk, weFollow, at);
  }

  // --- Durable meta (migration 5, via MetaRepo) ------------------------------------

  /**
   * Persist the inter-action paced-delay deadline (epoch ms) so the pacing
   * survives an app restart: a relaunch resumes the remaining wait instead of
   * acting immediately (same contract as pause/resume, but durable). `null`
   * clears it (the delay fully elapsed).
   */
  setActionDelayDeadline(at: number | null): void {
    this.meta.setNumber('actionDelayDeadlineAt', at);
  }

  /** The persisted inter-action delay deadline, or `null` when none is owed. */
  getActionDelayDeadline(): number | null {
    return this.meta.number('actionDelayDeadlineAt');
  }

  /**
   * Persist the SessionPlanner's durable snapshot (raw JSON) so the organic pacing
   * model resumes exactly across a restart (docs/PRINCIPLES.md §3): the day's target, session
   * plan, owed within-session state, and the trailing-hour action ring all survive.
   * `null` clears it. Opaque to the store — the planner owns the shape.
   */
  setPacingState(raw: string | null): void {
    this.meta.set('pacingState', raw);
  }

  /** The persisted SessionPlanner snapshot JSON, or `null` when none exists. */
  getPacingState(): string | null {
    return this.meta.get('pacingState');
  }

  /**
   * The per-install noise entropy (meta `install_entropy`): one random 32-bit
   * value drawn ON FIRST ACCESS and persisted, so every timing-noise seed
   * derived from it (daily-boundary wake offsets, the engines' noise rngs) is
   * different per install but stable across relaunches (a mid-park
   * restart re-derives the same jittered wake). Upgraded installs with no
   * stored value draw-and-persist cleanly here; a corrupted value is replaced
   * with a fresh draw, loudly.
   */
  installEntropy(): number {
    const raw = this.meta.get('installEntropy');
    if (raw !== null) {
      const n = Number(raw);
      if (Number.isFinite(n)) return n >>> 0;
      logger.warn('store: install_entropy corrupted, redrawing', { raw });
    }
    const drawn = Math.floor(this.rng() * 0x1_0000_0000) >>> 0;
    this.meta.setNumber('installEntropy', drawn);
    logger.info('store: install entropy established', { value: drawn });
    return drawn;
  }

  /**
   * Persist the recovery ladder's durable state (raw JSON: attempt, holdUntil,
   * enteredAt, kindTally) so a relaunch mid-hold serves the REMAINDER of the
   * absolute deadline instead of forgetting the wall it was backing off from
   * (docs/PRINCIPLES.md §3 — schedules are durable). `null` clears it. Opaque to
   * the store — the RecoverySupervisor owns the shape.
   */
  setRecoveryState(raw: string | null): void {
    this.meta.set('recoveryState', raw);
  }

  /** The persisted recovery-ladder state JSON, or `null` when none exists. */
  getRecoveryState(): string | null {
    return this.meta.get('recoveryState');
  }

  /**
   * Persist the last CLOSED recovery incident (raw JSON: the window
   * [enteredAt, resolvedAt], attempts, kind tally, and — once the engine's
   * requeue-healer has run — the heal outcome). Written by the
   * RecoverySupervisor at ladder reset, the proof moment that the failure
   * window was systemic-and-over; amended by the engine after healing. `null`
   * clears it. Opaque to the store — recovery.ts owns the shape.
   */
  setRecoveryLastIncident(raw: string | null): void {
    this.meta.set('recoveryLastIncident', raw);
  }

  /** The persisted last-closed-incident JSON, or `null` when none exists. */
  getRecoveryLastIncident(): string | null {
    return this.meta.get('recoveryLastIncident');
  }

  /**
   * The moment follower measurement began — the first follow-back sweep or the
   * first complete census, whichever ran first — or `null` before either.
   * Everything first seen AT or BEFORE this moment is pre-existing STOCK — the
   * net-growth series only counts edge events strictly after it.
   */
  followersBaselineAt(): number | null {
    return this.relationships.baselineAt();
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
    this.relationships.ensureBaseline(at);
  }

  /**
   * Record a dated "they follow us" EVENT — a notifications follow entry or an
   * accepted follow request; anchors the growth baseline first. List-walk
   * observations (membership, not timing) must NOT come through here.
   */
  observeOwnFollowerEvent(srcPk: string, ownPk: string, at: number): void {
    this.relationships.observeOwnFollowerEvent(srcPk, ownPk, at);
  }

  /**
   * Ingest a full auto-prune scan census into the shared graph, so a scan also
   * enriches the growth engine. Additive by default; `authoritative` (a census
   * whose walks both reported genuine completion) also heals the negative side
   * — see {@link CensusRepo.ingest}. One transaction; self always skipped; a
   * no-op with the standard warn when the own pk is unset.
   */
  ingestScanCensus(
    followingPks: string[],
    followerPks: string[],
    at: number,
    opts?: { authoritative?: CensusAuthority },
  ): void {
    if (this.ownPk === null) {
      this.warnOwnPkUnset('ingestScanCensus');
      return;
    }
    this.census.ingest(this.ownPk, followingPks, followerPks, at, opts);
  }

  // --- Chain targets (via TargetRepo) --------------------------------------------

  /** Insert or replace a chain target, keyed on account_pk. */
  addTarget(t: Target): void {
    this.targets.add(t);
  }

  getTarget(accountPk: string): Target | null {
    return this.targets.get(accountPk);
  }

  /**
   * Update a target's lifecycle status. 'exhausted' WITH `at` stamps the
   * evidence time, keeping the verdict reversible; WITHOUT `at` it is a
   * deliberate retirement that is never auto-revived.
   */
  setTargetStatus(accountPk: string, status: Target['status'], at?: number): void {
    this.targets.setStatus(accountPk, status, at);
  }

  /** All chain targets ordered by chain_index (nulls last), then account_pk. */
  listTargets(): Target[] {
    return this.targets.list();
  }

  /**
   * Chain targets currently 'exhausted' whose evidence stamp is at/after
   * `cutoff` — the dead-end self-heal's re-verify candidates.
   */
  exhaustedTargetsSince(cutoff: number): Target[] {
    return this.targets.exhaustedSince(cutoff);
  }

  /** The next chain position: `(MAX(chain_index) ?? -1) + 1`. */
  nextChainIndex(): number {
    return this.targets.nextChainIndex();
  }

  // --- Emergent analysis (via AnalyticsRepo) --------------------------------------

  /**
   * Yield statistics for a poaching session against `targetPk`, computed on
   * demand from follow_records + edges — analysis is an emergent query.
   */
  targetYield(targetPk: string, ownPk: string): TargetYield {
    return this.analytics.targetYield(targetPk, ownPk);
  }

  /** The Targets console's funnel read for one chain target, in cheap COUNTs. */
  targetFunnel(targetPk: string): TargetFunnelRead {
    return this.analytics.targetFunnel(targetPk, this.ownPk);
  }

  /** Follow-back latency sample (count + median delta) for one target. */
  followbackTimingFor(targetPk: string): FollowbackTiming {
    return this.analytics.followbackTimingFor(targetPk);
  }

  /**
   * Cumulative net own-follower growth per day for the last `days` days, ending
   * on `now`'s local day. Baseline-aware: only events strictly after the
   * followers baseline count, so initializing the app never charts a cliff.
   */
  netGrowthSeries(days: number, ownPk: string, now: number = this.now()): GrowthPoint[] {
    return this.analytics.netGrowthSeries(days, ownPk, now);
  }

  /**
   * TRUE net own-follower delta since `sinceMs` (gains minus losses),
   * baseline-aware. 0 when the own pk is unset.
   */
  netFollowersSince(sinceMs: number): number {
    return this.ownPk === null ? 0 : this.analytics.netFollowersSince(sinceMs, this.ownPk);
  }

  /**
   * LIVE relationship counts from the graph as it stands right now (docs/
   * PRINCIPLES.md §2): they tick DURING a prune scan because every row's edge
   * streams as it parses. Zeroes until {@link setOwnPk}.
   */
  relationshipCounts(): RelationshipCounts {
    return this.ownPk === null
      ? { following: 0, followers: 0, notFollowingBack: 0 }
      : this.relationships.counts(this.ownPk);
  }

  /**
   * Everything the Graph view's snapshot shaper reads, in one call. Null until
   * {@link setOwnPk} — pre-login there is no graph to anchor.
   */
  graphSnapshotRows(): GraphSourceRows | null {
    if (this.ownPk === null) return null;
    return {
      ownPk: this.ownPk,
      ownUsername: this.accounts.get(this.ownPk)?.username ?? null,
      ...this.analytics.graphSourceRows(this.ownPk),
    };
  }

  targetPks(): Set<string> {
    return this.targets.pks();
  }

  // --- Scrape cursors (via CursorRepo) -------------------------------------------

  /** Upsert a target's followers-list resume cursor; `at` comes from the caller's clock. */
  setScrapeCursor(targetPk: string, cursor: string | null, at: number): void {
    this.cursors.set(targetPk, cursor, at);
  }

  /** The stored resume cursor for a target, or `null` when absent or itself null. */
  getScrapeCursor(targetPk: string): string | null {
    return this.cursors.get(targetPk);
  }

  close(): void {
    this.db.close();
  }
}
