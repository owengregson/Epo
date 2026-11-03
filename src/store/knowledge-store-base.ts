/**
 * The knowledge store's foundation: opens the database, runs the migrations and the
 * schema check, builds the repos, and owns the mutation pulse and the own-pk anchor.
 */
import { Chronos } from './chronos';
import type { SqliteDriver } from './driver/driver';
import { openDatabase } from './driver/index';
import type { KnowledgeStoreOptions } from './knowledge-types';
import { runMigrations } from './migrations';
import { MutationPulse } from './mutation-pulse';
import { AccountRepo } from './repos/accounts';
import { AnalyticsRepo } from './repos/analytics';
import { CensusRepo } from './repos/census';
import { CursorRepo } from './repos/cursors';
import { EffectIntentRepo } from './repos/effect-intents';
import { FeedReadsRepo } from './repos/feed-reads';
import { FollowRecordRepo } from './repos/follow-records';
import { GrowthRepo } from './repos/growth';
import { LedgerRepo } from './repos/ledgers';
import { MetaRepo } from './repos/meta';
import { ProtectionFactsRepo } from './repos/protection-facts';
import { PruneScanRepo } from './repos/prune-scan';
import { RelationshipRepo } from './repos/relationships';
import { ReopenStateRepo } from './repos/reopen-state';
import { SurfaceDriftRepo } from './repos/surface-drift';
import { TargetRepo } from './repos/targets';
import { assertSchema } from './schema/manifest';
import { SpanSink } from './spans';
import type { MutationTally, StorePolicy } from './types';

/** Opening a store: the ambient options plus the kernel bounds main injects. */
export type StoreOpenOptions = KnowledgeStoreOptions & { readonly policy: StorePolicy };

/** What every store needs before its first delegation; `KnowledgeStore` adds the reads and writes. */
export class KnowledgeStoreBase {
  protected readonly db: SqliteDriver;
  /** The `meta` key/value table (durable scalars), behind its typed manifest. */
  protected readonly meta: MetaRepo;
  /** The two append-only action ledgers (`action_ledger`, `prune_ledger`). */
  protected readonly ledgers: LedgerRepo;
  /** The write-ahead journal (`effect_intents`); public so its owner adds methods without the facade. */
  readonly effectIntents: EffectIntentRepo;
  /** The durable prune-scan snapshot and its unvisited candidate set. */
  protected readonly pruneScan: PruneScanRepo;
  /** Per-target followers-list resume cursors. */
  protected readonly cursors: CursorRepo;
  /** The poaching chain's targets table. */
  protected readonly targets: TargetRepo;
  /** The churn lifecycle table (`follow_records`); public for the same reason. */
  readonly followRecords: FollowRecordRepo;
  /** The account projection and its append-only inputs. */
  protected readonly accounts: AccountRepo;
  /** The `edges` table plus the followers baseline. */
  protected readonly relationships: RelationshipRepo;
  /** Read-only analysis over the whole graph. */
  protected readonly analytics: AnalyticsRepo;
  /** The own-follower growth reads (baseline-aware) and, later, the follower change log. */
  readonly growth: GrowthRepo;
  /** The reopen frontiers (`meta.reopen_state`). */
  readonly reopen: ReopenStateRepo;
  /** The live feed's read-only SQL. */
  readonly feed: FeedReadsRepo;
  /** Drift signatures, surface health and the latency meter. */
  readonly surface: SurfaceDriftRepo;
  /** The protection facts' read-only SQL. */
  readonly protectionFacts: ProtectionFactsRepo;
  /** The two write paths that span several tables (reconcile, census ingest). */
  protected readonly census: CensusRepo;
  /** Durable timers and the span log (migration 12); consumed in wave B. */
  readonly chronos: Chronos;
  readonly spans: SpanSink;
  /** Wall clock for time-derived reads; injectable so those reads are testable. */
  protected readonly now: () => number;
  /** Uniform [0,1) source, injectable so a drawn seed can be pinned in tests. */
  protected readonly rng: () => number;
  /** Our own account pk, set at build time via {@link setOwnPk}; null until then. */
  protected ownPk: string | null = null;
  /** The injected kernel bounds (retention, the span ring). */
  protected readonly policy: StorePolicy;

  constructor(dbPath: string, opts: StoreOpenOptions) {
    this.now = opts.now ?? Date.now;
    this.rng = opts.rng ?? Math.random;
    this.policy = opts.policy;
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
    this.followRecords = new FollowRecordRepo(this.db, changed);
    this.accounts = new AccountRepo(this.db, changed);
    this.relationships = new RelationshipRepo(this.db, changed, this.meta);
    this.effectIntents = new EffectIntentRepo(this.db, {
      records: this.followRecords, relationships: this.relationships, ledgers: this.ledgers, changed,
    });
    this.pruneRetainedLogs();
    this.analytics = new AnalyticsRepo(this.db);
    this.growth = new GrowthRepo(this.db, () => this.relationships.baselineAt());
    this.reopen = new ReopenStateRepo(this.db, this.meta, changed);
    this.feed = new FeedReadsRepo(this.db);
    this.surface = new SurfaceDriftRepo(this.db, this.meta, changed);
    this.protectionFacts = new ProtectionFactsRepo(this.db);
    this.chronos = new Chronos(this.db, { now: this.now });
    this.spans = new SpanSink(this.db, { now: this.now, rng: this.rng, policy: this.policy.spans });
    this.census = new CensusRepo(this.db, this.accounts, this.followRecords, this.relationships, this.meta);
  }

  /**
   * Set the logged-in account's pk. Used only for the "already-following"
   * candidate exclusion ({@link accountsWeFollow}) and for anchoring the edges
   * that {@link reconcileOwnFollow} writes; keeps the constructor signature stable.
   */
  setOwnPk(pk: string): void {
    this.ownPk = pk;
  }

  // --- Plan state and the write-budget union (read by the plan service) ------------

  /** The persisted day plan (`meta.plan_state`), unparsed; the plan service validates it. */
  getPlanState(): string | null { return this.meta.get('planState'); }
  setPlanState(raw: string | null): void { this.meta.set('planState', raw); }

  /** The write budget spent since `since`, over the rate governor's ledger union. */
  tallySince(since: number): MutationTally { return this.effectIntents.tallySince(since); }

  /** When each write in {@link tallySince}'s union happened, oldest first. */
  recentMutationTimes(since: number): readonly number[] { return this.effectIntents.mutationTimesSince(since); }

  /** Whether that union holds any write at all, however old (the plan's upgrade probation). */
  hasAnyMutation(): boolean { return this.effectIntents.hasAnyMutation(); }

  // --- Mutation notifications (docs/PRINCIPLES.md §2 — the UI mirrors the graph) ----

  protected readonly mutationPulse = new MutationPulse();

  /** Subscribe to committed graph changes; listeners must throttle their projections. */
  onMutation(listener: () => void): () => void { return this.mutationPulse.subscribe(listener); }
  protected changed(): void { this.mutationPulse.changed(); }

  pruneRetainedLogs(): void {
    this.accounts.pruneAppendOnlyLogs(this.policy.retentionMs);
    this.effectIntents.pruneSettled(Date.now(), this.policy.retentionMs);
  }

  close(): void {
    this.db.close();
  }
}
