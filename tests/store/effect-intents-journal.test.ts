/**
 * The journal's reads and writes on `effect_intents` (spec §9.8, migration 14 columns): what is due,
 * a park with its record in one transaction, the per-account set, the reviews that pressed nothing,
 * the graph-open cancel of interrupted intents, and `expired` holding its quota.
 */
import type { KnowledgeStore } from '@/store/knowledge-store';
import type { MutationAction } from '@/store/types';
import { openTestStore } from '../kit/store';

let s: KnowledgeStore;
beforeEach(() => { s = openTestStore(':memory:'); });
afterEach(() => s.close());

const begin = (pk: string, at: number, action: MutationAction = 'unfollow') =>
  s.beginEffectIntent({ accountPk: pk, username: pk, action, channel: 'growth', at });

test('due: open intents with no park, or a park served, oldest first; prepared and settled never', () => {
  const a = begin('a', 10); s.markEffectUncertain(a.id, 11);
  const b = begin('b', 5); s.markEffectDispatched(b.id, 6);
  const c = begin('c', 1); s.markEffectUncertain(c.id, 2);
  s.effectIntents.park(c.id, { attempts: 1, nextAttemptAt: 100 }, null);
  begin('d', 1);
  expect(s.effectIntents.due(50).map((i) => i.accountPk)).toEqual(['b', 'a']);
  expect(s.effectIntents.due(100).map((i) => i.accountPk)).toEqual(['c', 'b', 'a']);
});

test('a park writes the attempts, the next attempt and the record together, and only on an open intent', () => {
  s.upsertFollowRecord({ accountPk: 'a', targetPk: null, state: 'unfollow_queued', retryCount: 0 });
  const a = begin('a', 10); s.markEffectUncertain(a.id, 11);
  const pulses = jest.fn(); s.onMutation(pulses);
  const record = { accountPk: 'a', targetPk: null, state: 'unfollow_queued' as const, retryCount: 0,
    parkReason: 'unreadable' as const, checkFailures: 1, recheckAt: 500 };
  expect(s.effectIntents.park(a.id, { attempts: 1, nextAttemptAt: 500 }, record)).toBe(true);
  expect(s.getEffectIntent(a.id)).toMatchObject({ state: 'uncertain', attempts: 1, nextAttemptAt: 500 });
  expect(s.getFollowRecord('a')).toMatchObject({ parkReason: 'unreadable', checkFailures: 1, recheckAt: 500 });
  expect(pulses).toHaveBeenCalled();
  s.settleEffectIntent(a.id, { at: 600, result: 'cancelled' });
  expect(s.effectIntents.park(a.id, { attempts: 2, nextAttemptAt: 900 }, { ...record, recheckAt: 900 })).toBe(false);
  expect(s.getFollowRecord('a')?.recheckAt).toBe(500);
});

test('unsettledFor: every unsettled intent of one account, whatever its verb or channel', () => {
  const a = begin('a', 1); s.markEffectUncertain(a.id, 2);
  begin('a', 3, 'follow');
  const b = begin('b', 4); s.markEffectDispatched(b.id, 5);
  const settled = s.beginEffectIntent({ accountPk: 'a', username: 'a', action: 'unfollow', channel: 'manual', at: 6 });
  s.settleEffectIntent(settled.id, { at: 7, result: 'cancelled' });
  expect(s.effectIntents.unsettledFor('a').map((i) => i.action).sort()).toEqual(['follow', 'unfollow']);
  expect(s.effectIntents.unsettledFor('c')).toEqual([]);
});

test('nonDispatchReviewsSince counts the unfollow reviews that pressed nothing since a session start', () => {
  const reviewed = begin('a', 100); s.settleEffectIntent(reviewed.id, { at: 101, result: 'cancelled' });
  const early = begin('b', 50); s.settleEffectIntent(early.id, { at: 51, result: 'cancelled' });
  const pressed = begin('c', 120); s.markEffectDispatched(pressed.id, 121);
  s.settleEffectIntent(pressed.id, { at: 122, result: 'cancelled' });
  const follow = begin('d', 130, 'follow'); s.settleEffectIntent(follow.id, { at: 131, result: 'cancelled' });
  expect(s.effectIntents.nonDispatchReviewsSince(100)).toBe(1);
  expect(s.effectIntents.nonDispatchReviewsSince(0)).toBe(2);
});

test('a graph open cancels the prepared intents an earlier run left, never an open or a newer one', () => {
  const stale = begin('a', 10);
  const open = begin('b', 10); s.markEffectUncertain(open.id, 11);
  const fresh = begin('c', 30);
  expect(s.effectIntents.cancelInterruptedPrepared(20)).toBe(1);
  expect(s.getEffectIntent(stale.id)).toMatchObject({ state: 'settled', result: 'cancelled', settledAt: 20 });
  expect(s.getEffectIntent(open.id)?.state).toBe('uncertain');
  expect(s.getEffectIntent(fresh.id)?.state).toBe('prepared');
  expect(s.effectIntents.cancelInterruptedPrepared(20)).toBe(0);
});

test('an expired intent keeps its dispatch-day quota reserved, like external and cancelled', () => {
  const e = begin('a', 100); s.markEffectUncertain(e.id, 110);
  s.settleEffectIntent(e.id, { at: 200, result: 'expired' });
  expect(s.additionalMutationCountSince(100)).toBe(1);
  expect(s.tallySince(100).unfollow).toBe(1);
  expect(s.additionalMutationCountSince(111)).toBe(0);
});
