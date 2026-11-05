import { type Clock, SystemClock } from '../governors/clock';
import type { PlanDayClock } from '../kernel/plan';
import { SETTINGS_POLICY } from '../kernel/settings-policy';
import type { KnowledgeStore } from '../store/knowledge-store';
import { info } from '../utils/logger';
import { EXPLORATION_POLICY, explorationDayClock } from './exploration-policy';
import type { SourceFrontier, SourceVisitEndReason } from './source-frontier';

/**
 * A popular hub surfaced within the current target's audience, with its projected
 * yield. Produced by a {@link TargetDiscovery} implementation.
 */
export interface DiscoveredTarget {
  pk: string;
  projectedFollowBackRate: number;
  poolSize: number;
  /** Zero means unknown, not demonstrated poor quality. */
  matureSamples?: number;
  overlap?: number | null;
}

/**
 * Finds candidate next-targets ("popular people") emerging from the poached network
 * of `currentTargetPk` (§3.5, step 2).
 *
 * The live implementation ranks already observed sources using mature outcomes
 * and audience overlap; the interface keeps selection independently testable.
 */
export interface TargetDiscovery {
  discover(currentTargetPk: string, gates?: ChainConfig): Promise<DiscoveredTarget[]>;
}

/**
 * The own-followers fallback source (§3.5, step 5): when no discovered candidate
 * clears the minimum-yield bar, pick the next target from OUR OWN follower list so
 * the chain never dead-ends. Injected; the real impl reads via a browser tab + Reader.
 */
export interface OwnFollowersTargetSource {
  pick(minPoolSize?: number, options?: SourcePreparationOptions): Promise<string | null>;
  candidates?(minPoolSize?: number, options?: SourcePreparationOptions): Promise<string[]>;
  preparationState?(): { pending: boolean; retryAt: number | null };
}

export interface SourcePreparationOptions { profileLimit?: number; }
export interface AdvanceOptions extends SourcePreparationOptions { preparingReserve?: boolean; }

/** Minimum-yield gate for promoting a discovered target (§3.5). Exposed in Settings. */
export interface ChainConfig {
  minFollowBackRate: number;
  minPoolSize: number;
}

/** The one declaration of the chain gates' defaults: the settings policy's recommendations (spec §17.8). */
export const CHAIN_DEFAULTS: ChainConfig = {
  minFollowBackRate: SETTINGS_POLICY.RECOMMENDED.minFollowBackRate, minPoolSize: SETTINGS_POLICY.RECOMMENDED.minPoolSize,
};

/** The outcome of advancing the chain by one hop. */
export interface AdvanceResult {
  nextTargetPk: string | null;
  source: 'discovered' | 'own_followers' | 'none';
  reason: string;
  retryAt?: number;
  /** A durable read refusal also blocks refill; lack of another source does not. */
  readRetryAt?: number;
}

interface ChainDeps {
  store: KnowledgeStore;
  /** Our own account PK — used for own-target yield/overlap queries. */
  ownPk: string;
  discovery: TargetDiscovery;
  ownFollowers: OwnFollowersTargetSource;
  /** Time source for the exhaustion evidence stamp; defaults to wall-clock. */
  clock?: Clock;
  planDay?: Pick<PlanDayClock, 'window'>;
  cfg?: ChainConfig;
  frontier?: SourceFrontier;
}

/**
 * Self-chaining controller (§3.5). After a target is poached out, it selects the #1
 * next target: promote the best DISCOVERED popular person that clears the minimum-yield
 * gate, else fall back to our OWN followers, else stop. The genuinely-fuzzy discovery
 * step is injected (see {@link TargetDiscovery}); everything here is deterministic.
 */
export class ChainController {
  private readonly store: KnowledgeStore;
  private readonly ownPk: string;
  private readonly discovery: TargetDiscovery;
  private readonly ownFollowers: OwnFollowersTargetSource;
  private readonly clock: Clock;
  private readonly planDay: Pick<PlanDayClock, 'window'>;
  private cfg: ChainConfig;
  private readonly frontier?: SourceFrontier;

  /** Swap the live config in place (used when Settings are updated at runtime). */
  applyConfig(cfg: ChainConfig): void {
    this.cfg = cfg;
  }

  constructor(deps: ChainDeps) {
    this.store = deps.store;
    this.ownPk = deps.ownPk;
    this.discovery = deps.discovery;
    this.ownFollowers = deps.ownFollowers;
    this.clock = deps.clock ?? new SystemClock();
    this.planDay = deps.planDay ?? explorationDayClock();
    this.cfg = deps.cfg ?? CHAIN_DEFAULTS;
    this.frontier = deps.frontier;
  }

  /**
   * Advance the chain past `currentTargetPk`:
   *  1. Mark the current target `exhausted`.
   *  2. Discover popular people in its audience; promote the highest-projected one
   *     that meets BOTH thresholds (follow-back rate + pool size) → retained target.
   *  3. Otherwise fall back to our own followers.
   *  4. Otherwise report that no target is available.
   */
  async advance(currentTargetPk: string, reason: SourceVisitEndReason = 'verified-ended', options?: AdvanceOptions): Promise<AdvanceResult> {
    if (this.frontier !== undefined) return this.advanceFrontier(this.frontier, currentTargetPk, reason, options);
    // 1. The current target is poached out — EVIDENCE-stamped (`exhaustedAt`),
    //    so the verdict stays reversible: the engine's chain dead-end self-heal
    //    re-verifies recently stamped targets instead of halting terminally.
    this.store.setTargetStatus(currentTargetPk, 'exhausted', this.clock.now());

    // 2. Discover candidate next-targets and pick the best that clears the gate.
    const found = await this.discovery.discover(currentTargetPk, this.cfg);
    const qualifying = found.filter(
      (d) =>
        (d.matureSamples === 0 || d.projectedFollowBackRate >= this.cfg.minFollowBackRate) &&
        d.poolSize >= this.cfg.minPoolSize,
    );
    const best = qualifying.reduce<DiscoveredTarget | null>(
      (acc, d) =>
        acc === null || d.projectedFollowBackRate > acc.projectedFollowBackRate ? d : acc,
      null,
    );

    if (best) {
      const chainIndex = this.store.nextChainIndex();
      this.store.addTarget({
        accountPk: best.pk,
        source: 'discovered',
        status: 'active',
        chainIndex,
      });
      // Promoted candidate → retained target: followed and NEVER churned (§3.5, step 3).
      this.store.setRole(best.pk, 'retained_target');
      info('chain: promoted discovered target', {
        from: currentTargetPk,
        to: best.pk,
        chainIndex,
        projectedFollowBackRate: best.projectedFollowBackRate,
        poolSize: best.poolSize,
      });
      return { nextTargetPk: best.pk, source: 'discovered', reason: 'meets-min-yield' };
    }

    // 3. Fallback: pick the next target from our own followers so the chain never dead-ends.
    const pk = await this.ownFollowers.pick(this.cfg.minPoolSize);
    if (pk) {
      const chainIndex = this.store.nextChainIndex();
      this.store.addTarget({
        accountPk: pk,
        source: 'own_followers',
        status: 'active',
        chainIndex,
      });
      info('chain: fell back to own-followers target', {
        from: currentTargetPk,
        to: pk,
        chainIndex,
        discovered: found.length,
      });
      return {
        nextTargetPk: pk,
        source: 'own_followers',
        reason: 'no-discovered-target-met-min-yield',
      };
    }

    // 4. Nothing to advance to.
    info('chain: no next target available', {
      from: currentTargetPk,
      discovered: found.length,
    });
    return { nextTargetPk: null, source: 'none', reason: 'no-target-available' };
  }

  private async advanceFrontier(frontier: SourceFrontier, currentPk: string, reason: SourceVisitEndReason, options?: AdvanceOptions): Promise<AdvanceResult> {
    if (!options?.preparingReserve) frontier.endVisit(currentPk, reason);
    // A spent visit is not an exhausted source. Keep all queued/pending obligations.
    if (reason === 'verified-ended' && this.store.getTarget(currentPk)?.status !== 'exhausted') {
      this.store.setTargetStatus(currentPk, 'exhausted', this.clock.now());
    }

    const found = await this.discovery.discover(currentPk, this.cfg);
    for (const candidate of found) {
      if (candidate.poolSize < this.cfg.minPoolSize) continue;
      if (candidate.matureSamples !== 0 && candidate.projectedFollowBackRate < this.cfg.minFollowBackRate) continue;
      frontier.offer(candidate.pk, 'discovered');
    }
    // A fallback is a second source of alternatives, not a choice made only once a chain dies.
    let preparation: { pending: boolean; retryAt: number | null } | undefined;
    if ((!options?.profileLimit || frontier.next(currentPk) === null) &&
      frontier.snapshot().sources.filter((s) => s.status === 'ready' || s.status === 'working').length < EXPLORATION_POLICY.refillBelowLiveSources) {
      const own = this.ownFollowers.candidates ? await this.ownFollowers.candidates(this.cfg.minPoolSize, options)
        : [await this.ownFollowers.pick(this.cfg.minPoolSize, options)];
      preparation = this.ownFollowers.preparationState?.();
      for (const pk of own) if (pk !== null) frontier.offer(pk, 'own_followers');
    }
    const next = frontier.next(currentPk) ?? (options?.preparingReserve ? null : frontier.next());
    if (next === null) {
      return { nextTargetPk: null, source: 'none', reason: 'sources-deferred',
        ...(preparation?.retryAt === null || preparation?.retryAt === undefined ? {} : { readRetryAt: preparation.retryAt }),
        retryAt: preparation?.retryAt ?? (preparation?.pending ? this.clock.now() :
          frontier.nextResumeAt() ?? this.planDay.window(this.clock.now()).endsAt) };
    }
    if (options?.preparingReserve) frontier.endVisit(currentPk, reason);
    const previous = this.store.getTarget(next.pk);
    this.store.addTarget({ accountPk: next.pk, source: next.source, status: 'active',
      chainIndex: previous?.chainIndex ?? this.store.nextChainIndex() });
    if (next.source === 'discovered') this.store.setRole(next.pk, 'retained_target');
    // Acquisition reads the cursor's age and validates stale visits from the head.
    frontier.beginVisit(next.pk, next.source);
    info('chain: selected source visit', { from: currentPk, to: next.pk, reason, source: next.source });
    return { nextTargetPk: next.pk, source: next.source === 'seed' ? 'discovered' : next.source,
      reason: next.pk === currentPk ? 'only-viable-source' : reason };
  }
}
