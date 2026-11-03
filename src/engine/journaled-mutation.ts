import type { Clock } from '../governors/clock';
import type { KnowledgeStore } from '../store/knowledge-store';
import * as log from '../utils/logger';
import type { ChurnActionOutcome, ChurnActions } from './churn-scheduler';
import { normalizeMutationOutcome } from './mutation-outcome';

/** Shared settlement for non-growth writes. The lifecycle scheduler owns its record transition. */
export async function journaledMutation<A extends 'follow' | 'unfollow'>(d: {
  store: KnowledgeStore; clock: Clock; ownPk: string; actions: Pick<ChurnActions, A>;
  action: A; username: string; accountPk: string;
  channel: 'manual' | 'prune';
}): Promise<ChurnActionOutcome> {
  const intent = d.store.beginEffectIntent({ ...d, at: d.clock.now() });
  if (intent.state !== 'prepared') return { status: 'blocked', cause: 'tab-unhealthy', unverifiedClick: true };
  let outcome: ChurnActionOutcome;
  try {
    outcome = await d.actions[d.action](d.username, d.accountPk, () => {
      d.store.markEffectDispatched(intent.id, d.clock.now());
    });
  } catch (error) {
    if (d.store.getEffectIntent(intent.id)?.state === 'dispatched') {
      d.store.markEffectUncertain(intent.id, d.clock.now());
      log.warn('mutation: dispatched write has no verified result', { action: d.action, accountPk: d.accountPk, error: String(error) });
      return { status: 'blocked', cause: 'tab-unhealthy', unverifiedClick: true };
    } else d.store.settleEffectIntent(intent.id, { at: d.clock.now(), result: 'cancelled' });
    throw error;
  }
  const at = d.clock.now();
  const dispatched = d.store.getEffectIntent(intent.id)?.state === 'dispatched';
  outcome = normalizeMutationOutcome(outcome, dispatched);
  if (outcome.status === 'blocked') {
    if (dispatched || outcome.unverifiedClick) d.store.markEffectUncertain(intent.id, at);
    else d.store.settleEffectIntent(intent.id, { at, result: 'cancelled' });
    return outcome;
  }
  // The click review consumed the work before any press (spec §9.7): never dispatched, so cancelled.
  if (outcome.status === 'reviewed') {
    d.store.settleEffectIntent(intent.id, { at, result: 'cancelled' });
    return outcome;
  }
  const external = outcome.status === 'ok' && outcome.alreadyInState;
  d.store.settleEffectIntent(intent.id, {
    at, result: external ? 'external' : outcome.status === 'failed' ? 'fail' : outcome.status,
    ledger: external ? 'none' : d.channel === 'prune' ? 'prune' : 'growth',
    edge: outcome.status === 'ok'
      ? { srcPk: d.ownPk, dstPk: d.accountPk, active: d.action === 'follow' } : undefined,
  });
  return outcome;
}
