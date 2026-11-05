import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { setLevel } from '@/utils/logger';
import { openTestStore } from '../kit/store';

beforeAll(() => setLevel('error'));
const begin = (s: KnowledgeStore) => s.beginEffectIntent({ accountPk: 'a', username: 'alice', action: 'follow', channel: 'growth', at: 100 });

test('dispatch survives close/reopen and atomic settlement is idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'epo-effects-'));
  let s = openTestStore(join(dir, 'store.db'));
  try {
    const effect = begin(s);
    s.markEffectDispatched(effect.id, 120);
    s.close();
    s = openTestStore(join(dir, 'store.db'));
    expect(s.pendingEffectIntents()[0]).toMatchObject({ id: effect.id, state: 'dispatched', dispatchedAt: 120 });
    expect(s.additionalMutationCountSince(110)).toBe(1);
    const outcome = { at: 130, result: 'ok' as const, ledger: 'growth' as const,
      record: { accountPk: 'a', targetPk: null, state: 'pending_followback' as const, followedAt: 130, retryCount: 0 },
      edge: { srcPk: 'me', dstPk: 'a', active: true } };
    const observed: number[] = [];
    s.onMutation(() => observed.push(s.pendingEffectIntents().length));
    expect(s.settleEffectIntent(effect.id, outcome)).toBe(true);
    expect(s.settleEffectIntent(effect.id, outcome)).toBe(false);
    expect(observed).toEqual([0]);
    expect(s.actionCountSince(0)).toBe(1);
    expect(s.additionalMutationCountSince(0)).toBe(0);
    expect(s.getFollowRecord('a')?.state).toBe('pending_followback');
    expect(s.getEdge('me', 'a', 'follows')?.status).toBe('active');
  } finally { s.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a failure between record and edge write rolls back the entire settlement and emits nothing', () => {
  const s = openTestStore(':memory:');
  try {
    const effect = begin(s);
    s.markEffectDispatched(effect.id, 110);
    const observer = jest.fn(); s.onMutation(observer);
    expect(() => s.settleEffectIntent(effect.id, { at: 120, result: 'ok', ledger: 'growth',
      record: { accountPk: 'a', targetPk: null, state: 'pending_followback', retryCount: 0 },
      edge: { srcPk: 'me', dstPk: null as unknown as string, active: true },
    })).toThrow();
    expect(s.getFollowRecord('a')).toBeNull();
    expect(s.actionCountSince(0)).toBe(0);
    expect(s.pendingEffectIntents()[0].state).toBe('dispatched');
    expect(observer).not.toHaveBeenCalled();
  } finally { s.close(); }
});

test('acceptance and uncertain reconciled effects each consume exactly one additional budget slot', () => {
  const s = openTestStore(':memory:');
  try {
    const accept = s.beginEffectIntent({ accountPk: 'r', username: 'requester', action: 'accept-request', channel: 'accept-request', at: 100 });
    s.markEffectDispatched(accept.id, 110);
    expect(s.additionalMutationCountSince(0)).toBe(1);
    s.settleEffectIntent(accept.id, { at: 120, result: 'ok' });
    expect(s.additionalMutationCountSince(0)).toBe(1);
    const unknown = begin(s); s.markEffectUncertain(unknown.id, 130);
    s.settleEffectIntent(unknown.id, { at: 140, result: 'external' });
    expect(s.additionalMutationCountSince(0)).toBe(2);
  } finally { s.close(); }
});

test('retention removes only old settled intent detail and preserves unresolved intents and outcome evidence', () => {
  const s = openTestStore(':memory:');
  const now = Date.now();
  const old = now - 100 * 86_400_000;
  try {
    const settled = s.beginEffectIntent({ accountPk: 'history', username: 'history', action: 'follow', channel: 'growth', at: old });
    s.markEffectDispatched(settled.id, old + 1);
    s.settleEffectIntent(settled.id, { at: old + 2, result: 'ok', ledger: 'growth', record: {
      accountPk: 'history', targetPk: 'source', state: 'unfollowed', followedAt: old + 1,
      followedBackAt: old + 86_400_000, retryCount: 0,
    } });
    const pending = s.beginEffectIntent({ accountPk: 'pending', username: 'pending', action: 'follow', channel: 'growth', at: old });
    s.markEffectUncertain(pending.id, old + 1);
    const recent = s.beginEffectIntent({ accountPk: 'recent', username: 'recent', action: 'accept-request', channel: 'accept-request', at: now });
    s.markEffectDispatched(recent.id, now);
    s.settleEffectIntent(recent.id, { at: now, result: 'ok' });
    s.pruneRetainedLogs();
    expect(s.getEffectIntent(settled.id)).toBeNull();
    expect(s.getEffectIntent(pending.id)?.state).toBe('uncertain');
    expect(s.getEffectIntent(recent.id)?.state).toBe('settled');
    expect(s.getFollowRecord('history')?.followedBackAt).toBe(old + 86_400_000);
    expect(s.actionCountSince(0)).toBe(1);
    expect(s.additionalMutationCountSince(now - 1000)).toBe(1);
  } finally { s.close(); }
});
