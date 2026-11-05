import type { Clock } from '../governors/clock';
import type { PlanDayClock } from '../kernel/plan';
import type { KnowledgeStore } from '../store/knowledge-store';
import { compareByScoreDesc, type FollowRecord, type Target } from '../store/types';
import * as log from '../utils/logger';
import { anchoredQuality, type CandidateQualityConfig, type CandidateQualitySnapshot, type CandidateQualityView,
  evaluateQuality, type QualityStore, scoreQueue, validQuality } from './candidate-quality';
import { explorationDayClock, EXPLORATION_POLICY as POLICY, planDayStartAfter } from './exploration-policy';
import { scoreCandidate } from './scorer';
import { matureYields, observedOverlap, priorYield } from './source-quality';

export type SourceVisitEndReason = 'visit-budget' | 'low-yield' | 'verified-ended' | 'coverage-policy';
export interface SourceVisit {
  startedAt: number;
  follows: number;
  slices: number;
  emptySlices: number;
  rows: number;
  globallyNew: number;
  profiles: number;
  eligible: number;
}
export interface FrontierSource {
  pk: string;
  source: Target['source'];
  status: 'ready' | 'working' | 'deferred' | 'verified-ended';
  resumeAt: number;
  lastVisitedAt: number;
  totalFollows: number;
  visit: SourceVisit | null;
  lastReason: SourceVisitEndReason | null;
}
export interface SourceFrontierSnapshot {
  version: 1;
  currentTargetPk: string | null;
  sources: FrontierSource[];
  recentFollowSources: string[];
  totalFollows: number;
  quality?: CandidateQualitySnapshot | null;
}

type FrontierStore = Pick<KnowledgeStore,
  'getSourceFrontierState' | 'setSourceFrontierState' | 'listTargets' | 'getAccount' |
  'followRecordsByState' | 'followersOf' | 'followRecords'> & QualityStore;

/** Durable source visits. Rotation is a scheduling decision, never a claim of absence. */
export class SourceFrontier {
  private readonly planDay: Pick<PlanDayClock, 'window'>;
  constructor(private readonly deps: { store: FrontierStore; clock: Clock; outcomeWindowMs?: () => number;
    planDay?: Pick<PlanDayClock, 'window'>; quality?: CandidateQualityConfig }) { this.planDay = deps.planDay ?? explorationDayClock(); }

  snapshot(): SourceFrontierSnapshot {
    const raw = this.deps.store.getSourceFrontierState();
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (!this.valid(parsed)) throw new Error('Invalid persisted source frontier');
      return parsed;
    }
    const now = this.deps.clock.now();
    return {
      version: 1,
      currentTargetPk: null,
      recentFollowSources: [],
      totalFollows: 0,
      sources: this.deps.store.listTargets()
        .filter((target) => target.status !== 'retired' && (target.status !== 'exhausted' || target.exhaustedAt !== undefined))
        .map((target) => ({
          pk: target.accountPk,
          source: target.source,
          status: target.status === 'exhausted' ? 'verified-ended' : 'ready',
          resumeAt: target.exhaustedAt === undefined ? now : planDayStartAfter((t) => this.planDay.window(t), target.exhaustedAt),
          lastVisitedAt: target.exhaustedAt ?? 0,
          totalFollows: 0,
          visit: null,
          lastReason: target.status === 'exhausted' ? 'verified-ended' : null,
        })),
    };
  }

  private valid(value: unknown): value is SourceFrontierSnapshot {
    if (value === null || typeof value !== 'object') return false;
    const s = value as Partial<SourceFrontierSnapshot>;
    return s.version === 1 && Array.isArray(s.sources) && Array.isArray(s.recentFollowSources) &&
      (s.quality === undefined || s.quality === null || validQuality(s.quality)) &&
      typeof s.totalFollows === 'number' && Number.isFinite(s.totalFollows) &&
      (s.currentTargetPk === null || typeof s.currentTargetPk === 'string') &&
      s.sources.every((source) => typeof source.pk === 'string' && Number.isFinite(source.resumeAt) &&
        Number.isFinite(source.totalFollows) && ['ready', 'working', 'deferred', 'verified-ended'].includes(source.status));
  }

  private save(state: SourceFrontierSnapshot): void {
    this.deps.store.setSourceFrontierState(JSON.stringify(state));
  }

  qualityEnabled(): boolean { return this.deps.quality !== undefined; }

  /** Explicit store-only preparation; neither status reads nor picking silently change the quality bar. */
  refreshQuality(): void {
    if (this.deps.quality === undefined) return;
    const state = this.snapshot();
    const { next } = evaluateQuality(this.deps.store, state.quality ?? null, this.deps.quality, this.deps.clock.now());
    if (JSON.stringify(next) !== JSON.stringify(state.quality ?? null)) this.save({ ...state, quality: next });
  }

  qualityView(): CandidateQualityView {
    const state = this.snapshot();
    if (this.deps.quality === undefined) return { floor: null, readyCount: 0, qualifiedSources: [], counts: new Map(), needsReset: false };
    const { view } = evaluateQuality(this.deps.store, state.quality ?? null, this.deps.quality, this.deps.clock.now());
    return { ...view, qualifiedSources: state.quality?.qualifiedSources ?? [] };
  }

  goodQueuedCount(pk: string): number {
    if (this.deps.quality !== undefined) return this.qualityView().counts.get(pk) ?? 0;
    return this.deps.store.followRecordsByState('queued').filter((r) => r.targetPk === pk && r.score !== 0).length;
  }

  /** Rechecked at the fresh profile and physical click; journal admission is owned by its existing guard. */
  allowsFollow(record: FollowRecord): boolean {
    if (this.deps.quality === undefined) return true;
    const target = record.targetPk === null ? null : this.deps.store.getTarget(record.targetPk);
    if (record.targetPk === null || target === null || target.status === 'retired') return false;
    const state = this.snapshot().quality;
    if (!state?.qualifiedSources.includes(record.targetPk)) return false;
    const cfg = this.deps.quality.scorer();
    const { floor } = anchoredQuality(state, cfg);
    const account = this.deps.store.getAccount(record.accountPk);
    if (floor === null || this.deps.quality.readyCount() === 0 || account === null || !account.username?.trim()) return false;
    const s = scoreCandidate(account, cfg);
    return s.eligible && s.score >= floor;
  }

  /** Overlapping evidence is a lower bound on lifetime use, never three additive counts. */
  private followTotals(state: SourceFrontierSnapshot): Map<string, number> {
    const totals = this.deps.store.followRecords.successfulFollowsBySource();
    const recent = new Map<string, number>();
    for (const pk of state.recentFollowSources) recent.set(pk, (recent.get(pk) ?? 0) + 1);
    for (const source of state.sources) totals.set(source.pk, Math.max(totals.get(source.pk) ?? 0, source.totalFollows));
    for (const [pk, count] of recent) totals.set(pk, Math.max(totals.get(pk) ?? 0, count));
    return totals;
  }

  offer(pk: string, source: Target['source']): void {
    const state = this.snapshot();
    if (state.sources.some((s) => s.pk === pk)) return;
    // Keep the live frontier small; historic visited sources remain resumable.
    if (state.sources.filter((s) => s.status === 'ready' || s.status === 'working').length >= POLICY.maxSources) return;
    state.sources.push({ pk, source, status: 'ready', resumeAt: 0, lastVisitedAt: 0,
      totalFollows: 0, visit: null, lastReason: null });
    this.save(state);
  }

  beginVisit(pk: string, source: Target['source'] = 'discovered'): void {
    const state = this.snapshot();
    let entry = state.sources.find((s) => s.pk === pk);
    if (entry === undefined) {
      entry = { pk, source, status: 'ready', resumeAt: 0, lastVisitedAt: 0,
        totalFollows: 0, visit: null, lastReason: null };
      state.sources.push(entry);
    }
    // A restart resumes the same visit and its spent allowance.
    if (state.currentTargetPk === pk && entry.status === 'working' && entry.visit !== null) return;
    const now = this.deps.clock.now();
    state.currentTargetPk = pk;
    entry.status = 'working';
    entry.lastVisitedAt = now;
    entry.resumeAt = now;
    entry.visit = { startedAt: now, follows: 0, slices: 0, emptySlices: 0, rows: 0,
      globallyNew: 0, profiles: 0, eligible: 0 };
    this.save(state);
  }

  noteFollow(pk: string | null, _at?: number): void {
    if (pk === null) return;
    const state = this.snapshot();
    const source = state.sources.find((s) => s.pk === pk);
    if (source !== undefined) {
      source.totalFollows += 1;
      if (source.visit !== null) source.visit.follows += 1;
    }
    state.totalFollows += 1;
    state.recentFollowSources.push(pk);
    state.recentFollowSources = state.recentFollowSources.slice(-POLICY.shareWindow);
    this.save(state);
  }

  noteAcquisition(pk: string, rows: number, globallyNew = 0): void {
    this.updateVisit(pk, (v) => { v.rows += rows; v.globallyNew += globallyNew; });
  }

  noteEnrichment(pk: string, attempted: number): void {
    this.updateVisit(pk, (v) => { v.profiles += attempted; });
  }

  notePlan(pk: string, eligible: number): void {
    this.updateVisit(pk, (v) => {
      v.slices += 1;
      v.eligible += eligible;
      v.emptySlices = eligible === 0 ? v.emptySlices + 1 : 0;
    });
  }

  private updateVisit(pk: string, update: (visit: SourceVisit) => void): void {
    const state = this.snapshot();
    const visit = state.sources.find((s) => s.pk === pk)?.visit;
    if (visit === null || visit === undefined) return;
    update(visit);
    this.save(state);
  }

  rotationReason(pk: string): SourceVisitEndReason | null {
    const visit = this.snapshot().sources.find((s) => s.pk === pk)?.visit;
    if (!visit) return null;
    if (visit.emptySlices >= POLICY.emptySlicesBeforeDefer) return 'low-yield';
    if (visit.follows >= POLICY.followsPerVisit) return 'visit-budget';
    return null;
  }

  endVisit(pk: string, reason: SourceVisitEndReason): void {
    const state = this.snapshot();
    const source = state.sources.find((s) => s.pk === pk);
    if (source === undefined) return;
    // Re-evaluating a parked frontier must not restart the revisit deadline.
    if (state.currentTargetPk !== pk && source.status !== 'working') return;
    source.lastReason = reason;
    source.status = reason === 'verified-ended' ? 'verified-ended' : 'deferred';
    const now = this.deps.clock.now();
    source.resumeAt = reason === 'verified-ended' || reason === 'coverage-policy'
      ? planDayStartAfter((t) => this.planDay.window(t), now) : reason === 'low-yield' ? this.planDay.window(now).endsAt : now;
    if (state.currentTargetPk === pk) state.currentTargetPk = null;
    this.save(state);
    log.info('frontier: source visit finished', { pk, reason, resumeAt: source.resumeAt, visit: source.visit });
  }

  next(excludePk?: string): FrontierSource | null {
    const state = this.snapshot();
    const now = this.deps.clock.now();
    const recent = [...new Set([...state.recentFollowSources].reverse())].slice(0, POLICY.maxSources);
    const candidates = state.sources.filter((source) => source.pk !== excludePk && source.resumeAt <= now &&
      this.deps.store.getAccount(source.pk)?.username !== undefined);
    if (candidates.length < POLICY.rankMinCandidates) return candidates[0] ?? null;
    const exploration = (state.totalFollows + 1) % Math.round(1 / POLICY.explorationFraction) === 0;
    const yields = matureYields(this.deps.store, now, this.deps.outcomeWindowMs?.());
    const totals = exploration ? this.followTotals(state) : new Map<string, number>();
    const utility = new Map(candidates.map((source) => {
      const quality = (yields.get(source.pk) ?? priorYield()).rate;
      const overlap = observedOverlap(this.deps.store, source.pk, recent) ?? POLICY.unknownOverlap;
      const share = state.recentFollowSources.filter((pk) => pk === source.pk).length / Math.max(1, state.recentFollowSources.length);
      return [source.pk, quality * (1 - POLICY.overlapWeight * overlap) - share * POLICY.sharePenalty];
    }));
    candidates.sort((a, b) => {
      if (exploration && totals.get(a.pk) !== totals.get(b.pk)) return (totals.get(a.pk) ?? 0) - (totals.get(b.pk) ?? 0);
      return (utility.get(b.pk) ?? 0) - (utility.get(a.pk) ?? 0) || a.lastVisitedAt - b.lastVisitedAt || a.pk.localeCompare(b.pk);
    });
    return candidates[0] ?? null;
  }

  nextResumeAt(): number | null {
    const now = this.deps.clock.now();
    const dates = this.snapshot().sources.map((s) => s.resumeAt).filter((at) => at > now);
    return dates.length === 0 ? null : Math.min(...dates);
  }

  /** Called only for fresh follows. Cleanup and safety precedence remain with the conductor. */
  pickQueued(records: readonly FollowRecord[]): FollowRecord | null {
    if (this.deps.quality !== undefined) {
      const quality = this.snapshot().quality;
      const cfg = this.deps.quality.scorer();
      const { floor } = anchoredQuality(quality ?? null, cfg);
      if (quality === undefined || quality === null || floor === null || this.deps.quality.readyCount() === 0) return null;
      records = scoreQueue(this.deps.store, records, cfg, this.deps.clock.now())
        .filter((r) => r.score >= floor && r.targetPk !== null && quality.qualifiedSources.includes(r.targetPk));
    }
    if (records.length === 0) return null;
    const state = this.snapshot();
    const bySource = new Map<string, FollowRecord[]>();
    for (const record of records) {
      const key = record.targetPk ?? '';
      bySource.set(key, [...(bySource.get(key) ?? []), record]);
    }
    let sources = [...bySource.keys()];
    const counts = (pk: string): number => state.recentFollowSources.filter((p) => p === pk).length;
    if (sources.length >= POLICY.shareMinSources && state.recentFollowSources.length >= POLICY.followsPerVisit) {
      const under = sources.filter((pk) => counts(pk) / state.recentFollowSources.length < POLICY.sourceShare);
      if (under.length > 0) sources = under;
    }
    const exploration = (state.totalFollows + 1) % Math.round(1 / POLICY.explorationFraction) === 0;
    const totals = exploration ? this.followTotals(state) : new Map<string, number>();
    sources.sort((a, b) => {
      if (exploration) {
        const total = (pk: string): number => totals.get(pk) ?? 0;
        if (total(a) !== total(b)) return total(a) - total(b);
      }
      return counts(a) - counts(b) || a.localeCompare(b);
    });
    return [...(bySource.get(sources[0]) ?? [])].sort(compareByScoreDesc)[0] ?? null;
  }
}
