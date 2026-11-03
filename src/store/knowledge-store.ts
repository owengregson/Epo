import * as logger from '../utils/logger';
import { KnowledgeStoreBase } from './knowledge-store-base';
import type { PruneCensusRecord } from './knowledge-types';
import type { TargetYield } from './repos/analytics';
import type { CensusAuthority, ReconcileOutcome } from './repos/census';
import type { HealResult } from './repos/follow-records';
import type { GrowthPoint } from './repos/growth';
import type { RelationshipCounts } from './repos/relationships';
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

  beginEffectIntent(input: {
    accountPk: string; username: string; action: MutationAction; channel: EffectChannel; at: number;
  }): EffectIntent {
    const intent = this.effects.begin(input);
    this.changed();
    return intent;
  }

  getEffectIntent(id: string): EffectIntent | null { return this.effects.get(id); }
  pendingEffectIntents(): EffectIntent[] { return this.effects.pending(); }
  markEffectDispatched(id: string, at: number): void {
    this.effects.mark(id, 'dispatched', at);
    this.changed();
  }
  markEffectUncertain(id: string, at: number): void {
    this.effects.mark(id, 'uncertain', at);
    this.changed();
  }

  /** No observer sees half a committed action; a failed write rolls back every component. */
  settleEffectIntent(id: string, outcome: EffectSettlement): boolean {
    return this.mutationPulse.atomic(() => this.effects.settle(id, outcome));
  }

  additionalMutationCountSince(since: number): number {
    return this.effects.additionalCountSince(since);
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
    return this.growth.netGrowthSeries(days, ownPk, now);
  }

  /**
   * TRUE net own-follower delta since `sinceMs` (gains minus losses),
   * baseline-aware. 0 when the own pk is unset.
   */
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
