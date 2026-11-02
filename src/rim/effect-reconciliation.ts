import type { Clock } from '../governors/clock';
import type { ReadBudget } from '../governors/read-budget';
import type { KnowledgeStore } from '../store/knowledge-store';
import type { ProfileVisitor } from './profile-visit-port';

export interface EffectReconciliationResult {
  outcome: 'complete' | 'progress' | 'deferred' | 'failed';
  remaining: number;
  settled: number;
  retryAt?: number;
}

/** Observe uncertain writes; never replay a click or invent its historical outcome. */
export async function reconcileEffects(deps: {
  store: KnowledgeStore; profiles: ProfileVisitor; ownPk: string; clock: Clock;
  signal?: () => AbortSignal | undefined;
  readBudget?: Pick<ReadBudget, 'consume'>;
}): Promise<EffectReconciliationResult> {
  const { store, profiles, ownPk, clock } = deps;
  const token = deps.signal?.();
  const stopped = (): boolean => Boolean(token?.aborted || token !== deps.signal?.());
  let settled = 0;
  const result = (outcome: EffectReconciliationResult['outcome'], retryAt?: number): EffectReconciliationResult => ({
    outcome, remaining: store.pendingEffectIntents().length, settled,
    ...(retryAt === undefined ? {} : { retryAt }),
  });
  for (const intent of store.pendingEffectIntents().slice(0, 10)) {
    if (stopped()) return result('deferred');
    if (intent.state === 'prepared') {
      store.settleEffectIntent(intent.id, { at: clock.now(), result: 'cancelled', ledger: 'none' });
      settled++;
      continue;
    }
    const permit = deps.readBudget?.consume('profile', 'reconciliation');
    if (permit && !permit.allowed) return result('deferred', permit.resumeAt ?? undefined);
    const observationStartedAt = clock.now();
    const seen = await profiles.visit(intent.username);
    if (!seen.ok || seen.obs.accountPk !== intent.accountPk) continue;
    if (!Number.isFinite(seen.obs.observedAt) || seen.obs.observedAt < observationStartedAt || seen.obs.observedAt > clock.now()) continue;
    if (stopped()) return result('deferred');
    const incoming = intent.action === 'accept-request';
    const actual = incoming ? seen.viewer.followsUs
      : seen.viewer.following === true || seen.viewer.requested === true ? true
        : seen.viewer.following === false && seen.viewer.requested === false ? false : null;
    if (actual === null) continue;
    const rec = intent.channel === 'growth' ? store.getFollowRecord(intent.accountPk) : null;
    store.settleEffectIntent(intent.id, {
      at: clock.now(), result: 'external', ledger: 'none',
      // An uncertain action has no reliable ownership timestamp. Respect the observed state.
      record: rec ? {
        ...rec,
        state: !actual && intent.action === 'unfollow' ? 'unfollowed' : 'external',
        reconciledAt: seen.obs.observedAt,
      } : undefined,
      edge: { srcPk: incoming ? intent.accountPk : ownPk, dstPk: incoming ? ownPk : intent.accountPk,
        active: actual, observedAt: seen.obs.observedAt },
    });
    settled++;
  }
  return result(store.pendingEffectIntents().length === 0 ? 'complete' : settled > 0 ? 'progress' : 'failed');
}
