import type { Clock } from '../governors/clock';
import type { KnowledgeStore } from '../store/knowledge-store';
import type { FollowRecord } from '../store/types';
import { warn } from '../utils/logger';
import type { FollowbackRelationships } from './followback-types';

/** Bounded reads stream facts. A budget pause preserves completed members of this epoch. */
export async function reconcileFollowbackCohort(d: {
  store: KnowledgeStore; clock: Clock; ownPk: string; relationships: FollowbackRelationships;
  records: FollowRecord[];
  signal?: () => AbortSignal | undefined;
}): Promise<{ outcome: 'complete' | 'progress' | 'failed' | 'read-budget'; retryAt?: number }> {
  let observed = 0;
  const token = d.signal?.();
  const stopped = (): boolean => Boolean(token?.aborted || token !== d.signal?.());
  for (const rec of d.records.slice(0, 10)) {
    if (stopped()) return { outcome: 'progress' };
    const username = d.store.getAccount(rec.accountPk)?.username;
    if (!username) continue;
    const startedAt = d.clock.now();
    try {
      const read = await d.relationships.read(rec.accountPk, username);
      if (stopped()) return { outcome: 'progress' };
      if (!read.ok) {
        if (read.reason === 'read-budget') return { outcome: 'read-budget', retryAt: read.retryAt };
        continue;
      }
      if (!Number.isFinite(read.observedAt) || read.observedAt < startedAt || read.observedAt > d.clock.now()) continue;
      d.store.observeEdge(rec.accountPk, d.ownPk, 'follows', read.followsUs, read.observedAt);
      observed++;
    } catch (error) {
      warn('followback: targeted relationship read failed', { accountPk: rec.accountPk, error: String(error) });
    }
  }
  return { outcome: observed === d.records.length ? 'complete' : observed > 0 ? 'progress' : 'failed' };
}
