/**
 * The review vocabulary (spec §16.2) round-trips through the store: the `kept`
 * state and its columns, parks, the shared re-check columns, journal attempts,
 * the `expired` result, retired targets and request edges.
 */

import { FOLLOW_STATES, type FollowRecord } from '@/store/types';
import { withStore } from '../kit/store';

const record = (over: Partial<FollowRecord> = {}): FollowRecord => ({
  accountPk: 'p1', targetPk: null, state: 'pending_followback', followedAt: 10, retryCount: 0, ...over,
});

test('FOLLOW_STATES ends with kept, so zero-filled funnels count it', () => {
  expect(FOLLOW_STATES.at(-1)).toBe('kept');
  return withStore((s) => {
    expect(s.targetFunnel('none').states.kept).toBe(0);
  });
});

test('a kept record round-trips its reason, match, stamps, park and dating bound', () => {
  return withStore((s) => {
    s.upsertFollowRecord(record({
      state: 'kept', keptReason: 'bio-word', keptMatch: 'cafe', keptAt: 20, recheckAt: 30,
      parkReason: 'unreadable', checkFailures: 2, followbackAfter: 15,
    }));
    expect(s.getFollowRecord('p1')).toMatchObject({
      state: 'kept', keptReason: 'bio-word', keptMatch: 'cafe', keptAt: 20, recheckAt: 30,
      parkReason: 'unreadable', checkFailures: 2, followbackAfter: 15,
    });
    expect(s.followRecordsByState('kept').map((r) => r.accountPk)).toEqual(['p1']);
  });
});

test('a fresh record reads checkFailures 0, and a write that omits it keeps the stored count', () => {
  return withStore((s) => {
    s.upsertFollowRecord(record());
    expect(s.getFollowRecord('p1')?.checkFailures).toBe(0);
    s.upsertFollowRecord(record({ checkFailures: 3 }));
    s.upsertFollowRecord(record({ state: 'followed_back' }));
    expect(s.getFollowRecord('p1')).toMatchObject({ state: 'followed_back', checkFailures: 3 });
  });
});

test('an intent starts with zero attempts and no next attempt', () => {
  return withStore((s) => {
    const intent = s.beginEffectIntent({ accountPk: 'a', username: 'a', action: 'unfollow', channel: 'growth', at: 1 });
    expect(intent).toMatchObject({ attempts: 0, nextAttemptAt: null });
  });
});

test('a dispatched intent that expires still reserves its budget slot', () => {
  return withStore((s) => {
    const intent = s.beginEffectIntent({ accountPk: 'a', username: 'a', action: 'unfollow', channel: 'growth', at: 100 });
    s.markEffectDispatched(intent.id, 110);
    s.settleEffectIntent(intent.id, { at: 120, result: 'expired' });
    expect(s.getEffectIntent(intent.id)?.result).toBe('expired');
    expect(s.additionalMutationCountSince(0)).toBe(1);
  });
});

test('a retired target and a request edge round-trip', () => {
  return withStore((s) => {
    s.addTarget({ accountPk: 't', source: 'seed', status: 'active', chainIndex: 0 });
    s.setTargetStatus('t', 'retired');
    expect(s.getTarget('t')?.status).toBe('retired');
    s.observeEdge('r', 'me', 'requests', true, 5);
    expect(s.getEdge('r', 'me', 'requests')).toMatchObject({ type: 'requests', status: 'active' });
    expect(s.getEdge('r', 'me', 'follows')).toBeNull();
  });
});
