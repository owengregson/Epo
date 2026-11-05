/** A prepared cohort establishes the quality bar; dwindling queues never lower it. */

import { EXPLORATION_POLICY } from '../kernel/exploration-policy';
import type { KnowledgeStore } from '../store/knowledge-store';
import { compareByScoreDesc, type FollowRecord } from '../store/types';
import { journalBlocks } from './journal';
import { type CandidateProfile, type ScorerConfig, scoreCandidate } from './scorer';

export interface CandidateQualityConfig {
  scorer(): ScorerConfig;
  readyCount(): number;
  capacity(): number;
}

export interface CandidateQualitySnapshot {
  /** Frozen features, not stale numeric scores: explicit audience edits use the same score scale. */
  anchors: CandidateProfile[];
  /** Entry is latched: consuming a prepared batch does not disqualify its last good candidates. */
  qualifiedSources: string[];
}

export interface CandidateQualityView {
  floor: number | null;
  readyCount: number;
  qualifiedSources: string[];
  counts: Map<string, number>;
  needsReset: boolean;
}

export type QualityStore = Pick<KnowledgeStore,
  'getAccount' | 'getTarget' | 'hasActiveRequest' | 'effectIntents' | 'followRecordsByState'>;

export interface QualityEvaluation {
  next: CandidateQualitySnapshot | null;
  view: CandidateQualityView;
  records: FollowRecord[];
}
type ScoredRecord = FollowRecord & { score: number };

/** Only executable, freshly scoreable records can prove that a source is prepared. */
export function scoreQueue(store: QualityStore, records: readonly FollowRecord[], cfg: ScorerConfig, now: number): ScoredRecord[] {
  const unsettled = store.effectIntents.pending();
  return records.flatMap((r) => {
    if (r.state !== 'queued' || r.targetPk === null || store.getTarget(r.targetPk)?.status === 'retired'
      || (r.recheckAt ?? now) > now || store.hasActiveRequest(r.accountPk) || journalBlocks(r.accountPk, unsettled)) return [];
    const account = store.getAccount(r.accountPk);
    if (account === null) return [];
    const score = scoreCandidate(account, cfg);
    return score.eligible && Number.isFinite(score.score) ? [{ ...r, score: score.score }] : [];
  });
}

function groups(records: readonly ScoredRecord[]): Map<string, ScoredRecord[]> {
  const result = new Map<string, ScoredRecord[]>();
  for (const r of records) {
    if (r.targetPk !== null) result.set(r.targetPk, [...(result.get(r.targetPk) ?? []), r]);
  }
  for (const batch of result.values()) batch.sort(compareByScoreDesc);
  return result;
}

function anchor(store: QualityStore, r: FollowRecord): CandidateProfile {
  const a = store.getAccount(r.accountPk);
  if (a === null) throw new Error('Quality anchor disappeared during preparation');
  return { followers: a.followers, following: a.following, ratio: a.ratio,
    mutuals: a.mutuals, isPrivate: a.isPrivate, isVerified: a.isVerified };
}

/** No writes: the frontier explicitly persists `next` before it admits any new cohort. */
export function evaluateQuality(store: QualityStore, state: CandidateQualitySnapshot | null,
  config: CandidateQualityConfig, now: number): QualityEvaluation {
  const cfg = config.scorer();
  const readyCount = Math.max(0, Math.min(config.readyCount(), config.capacity()));
  const records = scoreQueue(store, store.followRecordsByState('queued'), cfg, now);
  let next = state;
  if (next === null && readyCount > 0) {
    const batches = [...groups(records.filter((r) => r.score >= cfg.bandEdgeScore)).entries()]
      .filter(([, batch]) => batch.length >= readyCount)
      .map(([source, batch]) => ({ source, batch: batch.slice(0, readyCount) }));
    const weakest = (batch: readonly ScoredRecord[]): number => Math.min(...batch.map((r) => r.score));
    batches.sort((a, b) => weakest(b.batch) - weakest(a.batch)
      || a.source.localeCompare(b.source));
    const best = batches[0];
    if (best !== undefined) next = { anchors: best.batch.map((r) => anchor(store, r)), qualifiedSources: [] };
  }
  const scores = next?.anchors.map((a) => scoreCandidate(a, cfg)) ?? [];
  const needsReset = next !== null && (scores.length === 0 || scores.some((s) => !s.eligible));
  const floor = next === null || needsReset ? null : Math.max(cfg.bandEdgeScore, Math.min(...scores.map((s) => s.score)));
  const good = floor === null || readyCount === 0 ? [] : records.filter((r) => r.score >= floor);
  const bySource = groups(good);
  if (next !== null && !needsReset && readyCount > 0) {
    const qualified = new Set(next.qualifiedSources.filter((pk) => store.getTarget(pk)?.status !== 'retired'));
    for (const [pk, batch] of bySource) if (batch.length >= readyCount) qualified.add(pk);
    next = { ...next, qualifiedSources: [...qualified].sort() };
  }
  return { next, records: good, view: { floor, readyCount, needsReset,
    qualifiedSources: next?.qualifiedSources ?? [], counts: new Map([...bySource].map(([pk, batch]) => [pk, batch.length])) } };
}

export function validQuality(value: unknown): value is CandidateQualitySnapshot {
  if (value === null || typeof value !== 'object') return false;
  const s = value as Partial<CandidateQualitySnapshot>;
  const count = (n: unknown): boolean => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  return Array.isArray(s.anchors) && s.anchors.length > 0 && s.anchors.length <= EXPLORATION_POLICY.queuedPerSource
    && s.anchors.every((a) => a !== null && typeof a === 'object' && count(a.followers) && count(a.following)
      && (a.ratio === undefined || (Number.isFinite(a.ratio) && a.ratio >= 0))
      && (a.mutuals === undefined || count(a.mutuals))
      && (a.isPrivate === undefined || typeof a.isPrivate === 'boolean')
      && (a.isVerified === undefined || typeof a.isVerified === 'boolean'))
    && Array.isArray(s.qualifiedSources) && s.qualifiedSources.every((pk) => typeof pk === 'string');
}
