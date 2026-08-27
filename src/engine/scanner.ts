import type { KnowledgeStore } from '../store/knowledge-store';
import * as logger from '../utils/logger';
import { type ScorerConfig, scoreCandidate } from './scorer';

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
  private scorerCfg?: ScorerConfig;
  private cfg: ScannerConfig;

  constructor(deps: { store: KnowledgeStore; scorerCfg?: ScorerConfig; cfg?: ScannerConfig }) {
    this.store = deps.store;
    this.scorerCfg = deps.scorerCfg;
    this.cfg = deps.cfg ?? SCANNER_DEFAULTS;
  }

  /** Swap the live config (scanner + scorer) in place when Settings change at runtime. */
  applyConfig(cfg: ScannerConfig, scorerCfg?: ScorerConfig): void {
    this.cfg = cfg;
    if (scorerCfg !== undefined) this.scorerCfg = scorerCfg;
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
      if (!s.eligible) {
        // R1.3: counts ARE known but the account is ineligible → mark it 'skipped'
        // so `candidatePksForTarget` drops it and the pool genuinely shrinks.
        // `no-counts` candidates are left alone — they await an enrichment pass.
        if (!s.reasons.includes('no-counts')) this.store.setRole(pk, 'skipped');
        continue;
      }
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
        // Persist the composite score so the queue's execution order (nextDue)
        // and display order both follow the ranking — the best candidate first.
        score: c.score,
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

  /**
   * Backfill scores for `queued` records that have none. Records queued before
   * the score column existed (migration 7) carry NULL forever, and a NULL
   * score makes both `nextDue` and the queue display fall back to meaningless
   * pk order — the queue then neither acts nor shows best-first. Idempotent
   * and store-only; a record whose account still lacks counts stays unscored
   * (it sorts last, exactly as an unknown should). Returns how many were
   * scored.
   */
  rescoreQueued(): number {
    let scored = 0;
    for (const rec of this.store.followRecordsByState('queued')) {
      if (rec.score !== undefined) continue;
      const acc = this.store.getAccount(rec.accountPk);
      if (acc === null) continue;
      const s = scoreCandidate(acc, this.scorerCfg);
      if (!s.eligible) continue;
      this.store.upsertFollowRecord({ ...rec, score: s.score });
      scored += 1;
    }
    if (scored > 0) {
      logger.info('scanner: backfilled scores for legacy queued records', { scored });
    }
    return scored;
  }
}
