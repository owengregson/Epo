import * as logger from '../utils/logger';
import { KnowledgeStoreBase } from './knowledge-store-base';
import type { PruneCensusRecord } from './knowledge-types';
import type { TargetYield } from './repos/analytics';
import type { CensusAuthority, ReconcileOutcome } from './repos/census';
import type { HealResult } from './repos/follow-records';
import type { GrowthPoint } from './repos/growth';
import type { EdgeDating, RelationshipCounts } from './repos/relationships';
import type {
  AccountState,
  Edge,
  EdgeType,
  EffectChannel,
  EffectIntent,
  EffectSettlement,
  FollowbackTiming,
  FollowRecord,
  FollowState,
  GraphSourceRows,
  MutationAction,
  Observation,
  PruneScanSnapshot,
  Target,
  TargetFunnelRead,
} from './types';

export type { KnowledgeStoreOptions, PruneCensusRecord } from './knowledge-types';

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
export class KnowledgeStore extends KnowledgeStoreBase {
  /** One-time guard so an unset ownPk warns once, not on every reconciliation. */
  private warnedOwnPkUnset = false;

  protected reportFault(message: string, context: Record<string, unknown>): void { logger.error(message, context); }

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
    this.db.transaction(() => {
      this.accounts.observe(obs);
      this.noteOwnHeader(obs);
    });
  }

  /** Upsert a directed edge; an own-follower transition also writes its dated change row (ADR 0704). */
  observeEdge(srcPk: string, dstPk: string, type: EdgeType, active: boolean, at: number, dating?: EdgeDating): void {
    this.relationships.observeEdge(srcPk, dstPk, type, active, at, dating);
  }

  /** Whether `pk` has an open follow request into our account (the requester predicate, spec §9.9). */
  hasActiveRequest(pk: string): boolean {
    return this.ownPk !== null && this.relationships.hasActiveRequest(pk, this.ownPk);
  }

  activeRequestPks(): string[] { return this.ownPk === null ? [] : this.relationships.activeRequestPks(this.ownPk); }

  getAccount(pk: string): AccountState | null {
    return this.accounts.get(pk);
  }

  /** Stamp `username`'s account permanently un-enrichable (selection skips it) until a later stats read. */
  markEnrichmentFailed(username: string, at: number): void {
    this.accounts.markEnrichmentFailed(username, at);
  }

  /** The pk projected under `username` (case-insensitive): a known target resolves with no request. */
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
   * Replace the durable last-COMPLETE census (separate from the runnable snapshot, whose rows runs
   * consume): only the next complete scan replaces it, and it survives relaunch (PRINCIPLES §3).
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
    this.followRecords.upsert(rec);
  }

  beginEffectIntent(input: {
    accountPk: string; username: string; action: MutationAction; channel: EffectChannel; at: number;
  }): EffectIntent {
    const intent = this.effectIntents.begin(input);
    this.changed();
    return intent;
  }

  getEffectIntent(id: string): EffectIntent | null { return this.effectIntents.get(id); }
  pendingEffectIntents(): EffectIntent[] { return this.effectIntents.pending(); }
  markEffectDispatched(id: string, at: number): void {
    this.effectIntents.mark(id, 'dispatched', at);
    this.changed();
  }
  markEffectUncertain(id: string, at: number): void {
    this.effectIntents.mark(id, 'uncertain', at);
    this.changed();
  }

  /** No observer sees half a committed action; a failed write rolls back every component. */
  settleEffectIntent(id: string, outcome: EffectSettlement): boolean {
    return this.mutationPulse.atomic(() => this.effectIntents.settle(id, outcome));
  }

  additionalMutationCountSince(since: number): number {
    return this.effectIntents.additionalCountSince(since);
  }

  getLifecycleState(): string | null { return this.meta.get('lifecycleState'); }
  setLifecycleState(raw: string | null): void { this.meta.set('lifecycleState', raw); }
  getLifecycleHealthState(): string | null { return this.meta.get('lifecycleHealthState'); }
  setLifecycleHealthState(raw: string | null): void { this.meta.set('lifecycleHealthState', raw); }
  getSourceFrontierState(): string | null { return this.meta.get('sourceFrontierState'); }
  setSourceFrontierState(raw: string | null): void { this.meta.set('sourceFrontierState', raw); }
  getReadBudgetState(): string | null { return this.meta.get('readBudgetState'); }
  setReadBudgetState(raw: string | null): void { this.meta.set('readBudgetState', raw); }

  getFollowRecord(accountPk: string): FollowRecord | null {
    return this.followRecords.get(accountPk);
  }

  followRecordsByState(state: FollowState): FollowRecord[] {
    return this.followRecords.byState(state);
  }

  /** Every follow_record not yet in a terminal state. */
  activeFollowRecords(): FollowRecord[] {
    return this.followRecords.active();
  }

  /** All account_pks that already have a follow_record (for candidate exclusion). */
  followRecordPks(): Set<string> {
    return this.followRecords.pks();
  }

  /**
   * account_pks the growth engine is ACTIVELY managing. The auto-prune routine
   * excludes these so the two systems never fight over the same account.
   */
  activeFollowRecordPks(): Set<string> {
    return this.followRecords.activePks();
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
    return this.followRecords.healAbandonedInWindow(opts);
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
    const excluded = this.followRecords.pks();
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

  /** The SessionPlanner's durable snapshot (raw JSON, PRINCIPLES §3); `null` clears it; the planner owns the shape. */
  setPacingState(raw: string | null): void {
    this.meta.set('pacingState', raw);
  }

  /** The persisted SessionPlanner snapshot JSON, or `null` when none exists. */
  getPacingState(): string | null {
    return this.meta.get('pacingState');
  }

  /**
   * The per-install noise entropy: one 32-bit value drawn on first access and persisted, so every
   * seed derived from it differs per install but holds across relaunches; a corrupt value is redrawn, loudly.
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

  /** The recovery ladder's durable state (raw JSON; a relaunch mid-hold serves the remainder); `null` clears it. */
  setRecoveryState(raw: string | null): void {
    this.meta.set('recoveryState', raw);
  }

  /** The persisted recovery-ladder state JSON, or `null` when none exists. */
  getRecoveryState(): string | null {
    return this.meta.get('recoveryState');
  }

  /** The last CLOSED recovery incident (raw JSON, owned by recovery.ts; the healer amends it); `null` clears it. */
  setRecoveryLastIncident(raw: string | null): void {
    this.meta.set('recoveryLastIncident', raw);
  }

  /** The persisted last-closed-incident JSON, or `null` when none exists. */
  getRecoveryLastIncident(): string | null {
    return this.meta.get('recoveryLastIncident');
  }

  /** The moment follower measurement began (null before it); everything at or before it is stock. */
  followersBaselineAt(): number | null {
    return this.relationships.baselineAt();
  }

  /**
   * Establish the followers baseline at `at` if none exists (set-once): the first moment collection
   * begins stamps the stock/growth boundary, so a late first census never re-classifies earlier gains.
   */
  ensureFollowersBaseline(at: number): void {
    this.relationships.ensureBaseline(at);
  }

  /**
   * Record a dated "they follow us" EVENT — a notifications follow entry or an
   * accepted follow request; anchors the growth baseline first. List-walk
   * observations (membership, not timing) must NOT come through here.
   */
  observeOwnFollowerEvent(srcPk: string, ownPk: string, at: number, source?: 'feed' | 'accept'): void {
    this.relationships.observeOwnFollowerEvent(srcPk, ownPk, at, source);
  }

  /**
   * Ingest a full prune-scan census into the shared graph; `authoritative` (per side) also heals the
   * negative side ({@link CensusRepo.ingest}). One transaction; a warned no-op while the own pk is unset.
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

  /** Yield statistics for a poaching session against `targetPk`, computed on demand (an emergent query). */
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

  /** Cumulative net own-follower growth per local day for the last `days` days (the edge read, baseline-aware). */
  netGrowthSeries(days: number, ownPk: string, now: number = this.now()): GrowthPoint[] {
    return this.growth.netGrowthSeries(days, ownPk, now);
  }

  /** The net own-follower delta since `sinceMs` over the edges, baseline-aware; 0 while the own pk is unset. */
  netFollowersSince(sinceMs: number): number {
    return this.ownPk === null ? 0 : this.growth.netFollowersSince(sinceMs, this.ownPk);
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

  getScrapeCursorState(targetPk: string): { cursor: string | null; updatedAt: number } | null {
    return this.cursors.state(targetPk);
  }

  clearScrapeCursor(targetPk: string): void { this.cursors.clear(targetPk); }
}
