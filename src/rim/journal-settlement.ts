/**
 * The journal's settlement step (spec §9.8): one due intent per call, read once on its account's
 * page and settled by the pure table in `engine/journal.ts`; channel evidence settles an accepted
 * request with zero reads. Never replays a click and never invents a historical outcome.
 */

import { type IntentObservation, type Settlement, settlementFor } from '@/engine/journal';
import type { Clock } from '@/governors/clock';
import type { ReadBudget } from '@/governors/read-budget';
import type { ParkSlots } from '@/kernel/derive-parks';
import type { KnowledgeStore } from '@/store/knowledge-store';
import type { EffectIntent } from '@/store/types';
import type { ProfileVisitor } from './profile-visit-port';

export type SettleOutcome = 'settled' | 'parked' | 'expired' | 'none' | 'aborted' | 'walled';

export interface JournalSettlementDeps {
  store: KnowledgeStore;
  profiles: ProfileVisitor;
  ownPk: string;
  clock: Clock;
  readBudget: Pick<ReadBudget, 'consume'>;
  /** The plan's park slots at the moment of settling. */
  slots(): ParkSlots;
  /** Failed attempts a record survives before it is abandoned (the churn config's retries). */
  maxRetries(): number;
  signal(): AbortSignal | undefined;
}

/** Settle the oldest due intent: `none` when nothing is due, `walled` for the recovery ladder. */
export async function settleNextIntent(d: JournalSettlementDeps): Promise<{ outcome: SettleOutcome }> {
  const token = d.signal();
  const stopped = (): boolean => Boolean(token?.aborted || token !== d.signal());
  const intent = d.store.effectIntents.due(d.clock.now())[0];
  if (intent === undefined) return { outcome: 'none' };
  if (stopped()) return { outcome: 'aborted' };
  const o = await observe(d, intent, stopped);
  if (o === null) return { outcome: 'aborted' };
  const rec = d.store.getFollowRecord(intent.accountPk);
  return { outcome: apply(d, intent, settlementFor(intent, o, rec, { ownPk: d.ownPk, slots: d.slots(), maxRetries: d.maxRetries() })) };
}

/** Settle each intent due on entry once, oldest first; stops at a wall, a stop, or an empty journal. */
export async function settleDueIntents(d: JournalSettlementDeps): Promise<readonly SettleOutcome[]> {
  const outcomes: SettleOutcome[] = [];
  for (let n = d.store.effectIntents.due(d.clock.now()).length; n > 0; n -= 1) {
    const { outcome } = await settleNextIntent(d);
    outcomes.push(outcome);
    if (outcome === 'none' || outcome === 'aborted' || outcome === 'walled') break;
  }
  return outcomes;
}

/** One read of the intent's account under its current username; null when stopped mid-visit. */
async function observe(d: JournalSettlementDeps, intent: EffectIntent, stopped: () => boolean): Promise<IntentObservation | null> {
  const permit = d.readBudget.consume('profile', 'reconciliation', 1, 'reconcile');
  if (!permit.allowed) return { kind: 'read-budget', at: d.clock.now(), resumeAt: permit.resumeAt };
  const started = d.clock.now();
  const seen = await d.profiles.visit(d.store.getAccount(intent.accountPk)?.username ?? intent.username);
  if (stopped()) return null;
  const at = d.clock.now();
  if (!seen.ok) return { kind: seen.kind === 'gone' ? 'absent' : seen.kind === 'walled' ? 'walled' : 'unreadable', at };
  if (seen.obs.accountPk !== intent.accountPk) return { kind: 'renamed', at };
  const t = seen.obs.observedAt;
  if (!Number.isFinite(t) || t < started || t > at) return { kind: 'unreadable', at };
  const { following, requested, followsUs } = seen.viewer;
  return { kind: 'ok', following, requested, followsUs, at: t };
}

function apply(d: JournalSettlementDeps, intent: EffectIntent, s: Settlement): SettleOutcome {
  if ('ladder' in s) return 'walled';
  if ('park' in s) {
    d.store.effectIntents.park(intent.id, s.park, s.record);
    return 'parked';
  }
  if ('expire' in s) {
    d.store.settleEffectIntent(intent.id, s.expire);
    return 'expired';
  }
  d.store.settleEffectIntent(intent.id, s.settle);
  if (s.closesRequest === true) closeRequest(d.store, intent.accountPk, d.ownPk, s.settle.at);
  return 'settled';
}

/** An accepted requester's open `requests` edge ends; an edge never seen is never written. */
function closeRequest(store: KnowledgeStore, pk: string, ownPk: string, at: number): void {
  if (store.getEdge(pk, ownPk, 'requests')?.status === 'active') store.observeEdge(pk, ownPk, 'requests', false, at);
}

/**
 * Settle open accepted requests from channel evidence, with zero reads: a requester seen following
 * after the dispatch landed it; one still listed after the dispatch did not. Returns how many settled.
 */
export function settleFromChannels(
  d: { store: KnowledgeStore; ownPk: string; now: number },
  e: { follower?: { pk: string; atMs: number }; stillRequesting?: { pk: string; at: number } },
): number {
  // A channel reading is readable by construction, so no park is ever drawn from these slots.
  const ctx = { ownPk: d.ownPk, slots: { nextSessionAt: null, planDayStartAfter: () => d.now }, maxRetries: 0 };
  let settled = 0;
  const evidence = [
    ...(e.follower ? [{ pk: e.follower.pk, at: e.follower.atMs, landed: true }] : []),
    ...(e.stillRequesting ? [{ pk: e.stillRequesting.pk, at: e.stillRequesting.at, landed: false }] : []),
  ];
  for (const { pk, at, landed } of evidence) {
    for (const i of d.store.effectIntents.unsettledFor(pk)) {
      if (i.action !== 'accept-request' || i.dispatchedAt === null || at < i.dispatchedAt) continue;
      const s = settlementFor(i, { kind: 'ok', followsUs: landed, at }, null, ctx);
      if (!('settle' in s) || !d.store.settleEffectIntent(i.id, s.settle)) continue;
      if (s.closesRequest === true) closeRequest(d.store, pk, d.ownPk, at);
      settled += 1;
    }
  }
  return settled;
}
