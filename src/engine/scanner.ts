import type { PlanDayClock } from '../kernel/plan';
import type { KnowledgeStore } from '../store/knowledge-store';
import * as logger from '../utils/logger';
import { EXPLORATION_POLICY, explorationDayClock, weeklyCycleSince } from './exploration-policy';
import { type ScorerConfig, scoreCandidate } from './scorer';

/**
 * Tunable knobs for a single scan/plan pass. Exposed in Settings; this module never
 * reads them from storage — pass a `ScannerConfig`.
 */
export interface ScannerConfig {
  /** Maximum number of candidates to enqueue for one target in a single plan. */
  dailyPlanSize: number;
  maxQueuedPerSource?: number;
}

/** Outcome of planning one target: what was enqueued and how the pool narrowed. */
export interface ScanPlan {
  /** The poached target whose followers were ranked. */
  targetPk: string;
  /** Selected candidate pks, in enqueue (descending-score) order. */
  queued: string[];
  /** Size of the raw not-yet-acted-on candidate pool that was considered. */
  considered: number;
  /** How many of the considered candidates the Scorer deemed eligible. */
  eligible: number;
}

/** One eligible candidate paired with its composite score, awaiting ranking. */
interface RankedCandidate {
  pk: string;
  score: number;
}

/**
 * The candidate planner (v3 §3.5). Given a poached target whose followers the Reader
 * already harvested into the knowledge graph, the Scanner ranks the not-yet-acted-on
 * followers with the Scorer and enqueues the best as `queued` follow-records for the
 * Churn Scheduler to execute.
 *
 * Pure with respect to I/O except the injected store; fully deterministic (stable
 * tie-break by pk); no browser and no silent catches.
 */
export class Scanner {
  private readonly store: KnowledgeStore;
  private scorerCfg?: ScorerConfig;
  private cfg: ScannerConfig;
  private readonly planDay: Pick<PlanDayClock, 'window'>;

  constructor(deps: { store: KnowledgeStore; scorerCfg?: ScorerConfig; cfg?: ScannerConfig; planDay?: Pick<PlanDayClock, 'window'> }) {
    this.store = deps.store;
    this.planDay = deps.planDay ?? explorationDayClock();
    this.scorerCfg = deps.scorerCfg;
    // Unconfigured, a target yields at most what one source may queue (the cap applied below anyway).
    this.cfg = deps.cfg ?? { dailyPlanSize: EXPLORATION_POLICY.queuedPerSource };
  }

  /** Swap the live config (scanner + scorer) in place when Settings change at runtime. */
  applyConfig(cfg: ScannerConfig, scorerCfg?: ScorerConfig): void {
    this.cfg = cfg;
    if (scorerCfg !== undefined) this.scorerCfg = scorerCfg;
    for (const target of this.store.listTargets()) this.reconsiderTarget(target.accountPk);
    this.rescoreQueued();
  }

  /** A rejection is a decision under a policy, not a permanent fact about a person. */
  reconsiderTarget(targetPk: string, now = 0): void {
    for (const pk of this.store.followersOf(targetPk)) {
      const acc = this.store.getAccount(pk);
      if (acc?.role !== 'skipped') continue;
      const stale = now > 0 && acc.statsObservedAt !== undefined &&
        acc.statsObservedAt < weeklyCycleSince((t) => this.planDay.window(t), now);
      if (stale || scoreCandidate(acc, this.scorerCfg).eligible) this.store.setRole(pk, 'observed');
    }
  }

  /**
   * Rank `targetPk`'s eligible followers and enqueue the top `dailyPlanSize` as
   * `queued` follow-records (role → `candidate`). Returns a summary of the pass.
   */
  planTarget(targetPk: string): ScanPlan {
    this.reconsiderTarget(targetPk);
    const pks = this.store.candidatePksForTarget(targetPk);

    const ranked: RankedCandidate[] = [];
    for (const pk of pks) {
      const acc = this.store.getAccount(pk);
      if (acc === null) continue;
      const s = scoreCandidate(acc, this.scorerCfg);
      if (!s.eligible) {
        // R1.3: counts ARE known but the account is ineligible → mark it 'skipped'
        // so `candidatePksForTarget` drops it and the pool genuinely shrinks.
        // `no-counts` candidates are left alone — they await an enrichment pass.
        if (!s.reasons.includes('no-counts') && acc.role !== 'retained_target') this.store.setRole(pk, 'skipped');
        continue;
      }
      ranked.push({ pk, score: s.score });
    }

    // Descending by score; ascending pk as a deterministic tie-break.
    ranked.sort((a, b) => (b.score - a.score) || (a.pk < b.pk ? -1 : a.pk > b.pk ? 1 : 0));

    const alreadyQueued = this.store.followRecordsByState('queued').filter((r) => r.targetPk === targetPk).length;
    const cap = this.cfg.maxQueuedPerSource ?? EXPLORATION_POLICY.queuedPerSource;
    const selected = ranked.slice(0, Math.max(0, Math.min(this.cfg.dailyPlanSize, cap - alreadyQueued)));
    for (const c of selected) {
      this.store.upsertFollowRecord({
        accountPk: c.pk,
        targetPk,
        state: 'queued',
        retryCount: 0,
        // Persist the composite score so the queue's execution order (nextDue)
        // and display order both follow the ranking — the best candidate first.
        score: c.score,
      });
      if (this.store.getAccount(c.pk)?.role !== 'retained_target') this.store.setRole(c.pk, 'candidate');
    }

    return {
      targetPk,
      queued: selected.map((c) => c.pk),
      considered: pks.length,
      eligible: ranked.length,
    };
  }

  /**
   * Refresh every queued score under current settings. Missing counts stay
   * unscored; ineligible records remain durable and must pass the action gate.
   */
  rescoreQueued(): number {
    let scored = 0;
    for (const rec of this.store.followRecordsByState('queued')) {
      const acc = this.store.getAccount(rec.accountPk);
      if (acc === null) continue;
      const s = scoreCandidate(acc, this.scorerCfg);
      if (s.reasons.includes('no-counts')) continue;
      if (rec.score === s.score) continue;
      this.store.upsertFollowRecord({ ...rec, score: s.score });
      scored += 1;
    }
    if (scored > 0) {
      logger.info('scanner: refreshed queued scores', { scored });
    }
    return scored;
  }
}
