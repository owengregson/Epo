import type { KnowledgeStore } from '../store/knowledge-store';
import { info } from '../utils/logger';

/**
 * A popular hub surfaced within the current target's audience, with its projected
 * yield. Produced by a {@link TargetDiscovery} implementation.
 */
export interface DiscoveredTarget {
  pk: string;
  projectedFollowBackRate: number;
  poolSize: number;
}

/**
 * Finds candidate next-targets ("popular people") emerging from the poached network
 * of `currentTargetPk` (§3.5, step 2).
 *
 * NOTE: The real implementation is a FUTURE ENHANCEMENT. Genuinely discovering a
 * popular hub within a poached network means observing the *followings* of the
 * target's followers and ranking by local in-degree + follower-overlap — a fuzzy,
 * live-data-driven query that needs more design and real network data to build well.
 * It is therefore deliberately left as an INJECTED interface: the Chain Controller's
 * promotion/fallback logic is fully unit-testable with a scripted fake, and the live
 * discoverer can be dropped in later without touching this file.
 */
export interface TargetDiscovery {
  discover(currentTargetPk: string): Promise<DiscoveredTarget[]>;
}

/**
 * The own-followers fallback source (§3.5, step 5): when no discovered candidate
 * clears the minimum-yield bar, pick the next target from OUR OWN follower list so
 * the chain never dead-ends. Injected; the real impl reads via a browser tab + Reader.
 */
export interface OwnFollowersTargetSource {
  pick(): Promise<string | null>;
}

/** Minimum-yield gate for promoting a discovered target (§3.5). Exposed in Settings. */
export interface ChainConfig {
  minFollowBackRate: number;
  minPoolSize: number;
}

/** Design defaults (§3.5): projected follow-back rate ≥ 0.15 AND pool size ≥ 300. */
export const CHAIN_DEFAULTS: ChainConfig = { minFollowBackRate: 0.15, minPoolSize: 300 };

/** The outcome of advancing the chain by one hop. */
export interface AdvanceResult {
  nextTargetPk: string | null;
  source: 'discovered' | 'own_followers' | 'none';
  reason: string;
}

interface ChainDeps {
  store: KnowledgeStore;
  /** Our own account PK — used for own-target yield/overlap queries. */
  ownPk: string;
  discovery: TargetDiscovery;
  ownFollowers: OwnFollowersTargetSource;
  cfg?: ChainConfig;
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
  private cfg: ChainConfig;

  /** Swap the live config in place (used when Settings are updated at runtime). */
  applyConfig(cfg: ChainConfig): void {
    this.cfg = cfg;
  }

  constructor(deps: ChainDeps) {
    this.store = deps.store;
    this.ownPk = deps.ownPk;
    this.discovery = deps.discovery;
    this.ownFollowers = deps.ownFollowers;
    this.cfg = deps.cfg ?? CHAIN_DEFAULTS;
  }

  /**
   * Advance the chain past `currentTargetPk`:
   *  1. Mark the current target `exhausted`.
   *  2. Discover popular people in its audience; promote the highest-projected one
   *     that meets BOTH thresholds (follow-back rate + pool size) → retained target.
   *  3. Otherwise fall back to our own followers.
   *  4. Otherwise report that no target is available.
   */
  async advance(currentTargetPk: string): Promise<AdvanceResult> {
    // 1. The current target is poached out.
    this.store.setTargetStatus(currentTargetPk, 'exhausted');

    // 2. Discover candidate next-targets and pick the best that clears the gate.
    const found = await this.discovery.discover(currentTargetPk);
    const qualifying = found.filter(
      (d) =>
        d.projectedFollowBackRate >= this.cfg.minFollowBackRate &&
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
    const pk = await this.ownFollowers.pick();
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
}
