import { KnowledgeStore } from '../store/knowledge-store';
import { scoreCandidate, type ScorerConfig } from './scorer';

/**
 * Tunable knobs for a single scan/plan pass. Exposed in Settings; this module never
 * reads them from storage — pass a `ScannerConfig`.
 */
export interface ScannerConfig {
  /** Maximum number of candidates to enqueue for one target in a single plan. */
  dailyPlanSize: number;
}

/** Design defaults (v3 §3.5). */
export const SCANNER_DEFAULTS: ScannerConfig = { dailyPlanSize: 25 };

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
  private readonly scorerCfg?: ScorerConfig;
  private readonly cfg: ScannerConfig;

  constructor(deps: { store: KnowledgeStore; scorerCfg?: ScorerConfig; cfg?: ScannerConfig }) {
    this.store = deps.store;
    this.scorerCfg = deps.scorerCfg;
    this.cfg = deps.cfg ?? SCANNER_DEFAULTS;
  }

  /**
   * Rank `targetPk`'s eligible followers and enqueue the top `dailyPlanSize` as
   * `queued` follow-records (role → `candidate`). Returns a summary of the pass.
   */
  planTarget(targetPk: string): ScanPlan {
    const pks = this.store.candidatePksForTarget(targetPk);

    const ranked: RankedCandidate[] = [];
    for (const pk of pks) {
      const acc = this.store.getAccount(pk);
      if (acc === null) continue;
      const s = scoreCandidate(acc, this.scorerCfg);
      if (!s.eligible) continue;
      ranked.push({ pk, score: s.score });
    }

    // Descending by score; ascending pk as a deterministic tie-break.
    ranked.sort((a, b) => (b.score - a.score) || (a.pk < b.pk ? -1 : a.pk > b.pk ? 1 : 0));

    const selected = ranked.slice(0, this.cfg.dailyPlanSize);
    for (const c of selected) {
      this.store.upsertFollowRecord({
        accountPk: c.pk,
        targetPk,
        state: 'queued',
        retryCount: 0,
      });
      this.store.setRole(c.pk, 'candidate');
    }

    return {
      targetPk,
      queued: selected.map((c) => c.pk),
      considered: pks.length,
      eligible: ranked.length,
    };
  }
}
