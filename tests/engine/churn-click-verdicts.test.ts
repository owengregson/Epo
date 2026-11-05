/**
 * Verify-at-act in the churn (spec §9.7–9.9): the click's verdict settles the record in the intent's
 * own transaction, selection passes over parked, journal-blocked and requesting records (law L5: no
 * head-of-line), requesters are never queued, and reviews that press nothing are bounded per session.
 */
import fc from 'fast-check';
import { ChurnScheduler } from '@/engine/churn-scheduler';
import { FakeClock } from '@/governors/clock';
import type { RateGovernor } from '@/governors/rate-governor';
import type { ClickVerdict } from '@/shared/click-verdict';
import type { KnowledgeStore } from '@/store/knowledge-store';
import type { FollowRecord } from '@/store/types';
import { DEFAULT_CONFIGS } from '../kit/configs';
import { FakeActions, kitStore, T0 } from '../kit/engine-harness';

const DAY = 86_400_000;
let store: KnowledgeStore;
let clock: FakeClock;
let actions: FakeActions;
let verdict: ClickVerdict | undefined;
beforeEach(() => {
  store = kitStore();
  store.setOwnPk('me');
  clock = new FakeClock(T0);
  actions = new FakeActions();
  verdict = undefined;
  actions.unfollow = async (username: string) => {
    actions.unfollowCalls.push(username);
    return verdict === undefined ? { status: 'ok' } : { status: 'reviewed', verdict };
  };
});

const churn = (over: Partial<ConstructorParameters<typeof ChurnScheduler>[0]> = {}) => new ChurnScheduler({
  store, clock, rate: {} as RateGovernor, actions, ownPk: 'me', cfg: DEFAULT_CONFIGS.churn,
  parkSlots: () => ({ nextSessionAt: clock.now() + 3_600_000, planDayStartAfter: (k) => clock.now() + k * DAY }), ...over,
});
const named = (pk: string) => store.observe({ accountPk: pk, observedAt: T0, source: 'profile', fields: { username: `u${pk}` } });
const queued = (pk: string, over: Partial<FollowRecord> = {}) => {
  named(pk);
  store.upsertFollowRecord({ accountPk: pk, targetPk: null, state: 'unfollow_queued', retryCount: 0,
    followedAt: T0 - 9 * DAY, unfollowDueAt: T0 - DAY, unfollowReason: 'no-followback', ...over });
};
const stuck = (pk: string) => {
  const i = store.beginEffectIntent({ accountPk: pk, username: `u${pk}`, action: 'unfollow', channel: 'manual', at: T0 });
  store.markEffectUncertain(i.id, T0);
};

describe('the click verdict settles the record (applyClickVerdict)', () => {
  test('reheld: followed_back with a fresh hold, the intent cancelled, never a failure', async () => {
    queued('1');
    verdict = { kind: 'reheld' };
    const s = churn();
    expect(await s.execute(store.getFollowRecord('1')!)).toBe('reviewed');
    expect(store.getFollowRecord('1')).toMatchObject({ state: 'followed_back', followbackObservedAt: T0,
      holdUntil: T0 + DEFAULT_CONFIGS.churn.holdAfterFollowbackMs, followbackAfter: T0 - 9 * DAY });
    expect(store.pendingEffectIntents()).toEqual([]);
    expect(s.streaks()).toEqual({ failed: 0, drift: 0, blocked: 0 });
  });

  test('unavailable parks the record off the queue until its re-check; already-gone closes it', async () => {
    queued('1');
    verdict = { kind: 'unavailable', evidence: 'absent' };
    const s = churn();
    await s.execute(store.getFollowRecord('1')!);
    expect(store.getFollowRecord('1')).toMatchObject({ state: 'unfollow_queued', parkReason: 'unreachable', recheckAt: T0 + DAY });
    expect(s.nextDue()).toBeNull();
    clock.advance(DAY);
    expect(s.nextDue()?.accountPk).toBe('1');
    verdict = { kind: 'already-gone' };
    await s.execute(store.getFollowRecord('1')!);
    expect(store.getFollowRecord('1')?.state).toBe('external');
  });

  test('a deferral before the visit leaves the record untouched', async () => {
    queued('1');
    actions.unfollow = async () => ({ status: 'blocked', cause: 'local-policy', verdict: { kind: 'deferred', reason: 'hourly-cap', until: T0 + 5 } });
    expect(await churn().execute(store.getFollowRecord('1')!)).toBe('blocked');
    expect(store.getFollowRecord('1')).toMatchObject({ state: 'unfollow_queued', retryCount: 0 });
  });
});

describe('selection passes over what cannot act now (spec §9.8–9.9)', () => {
  test('a parked, a journal-blocked and a requesting head never stop the next record', () => {
    queued('1', { unfollowDueAt: T0 - 4 * DAY, recheckAt: T0 + DAY });
    queued('2', { unfollowDueAt: T0 - 3 * DAY });
    stuck('2');
    queued('3', { unfollowDueAt: T0 - 2 * DAY });
    store.observeEdge('3', 'me', 'requests', true, T0);
    queued('4', { unfollowDueAt: T0 - DAY });
    expect(churn().nextDue()?.accountPk).toBe('4');
  });

  test('a requester is never queued, and an open follower edge is left to the consistency step', () => {
    for (const pk of ['r', 'f', 'p']) {
      named(pk);
      store.upsertFollowRecord({ accountPk: pk, targetPk: null, state: 'pending_followback', retryCount: 0, followedAt: T0 - 9 * DAY });
    }
    store.observeEdge('r', 'me', 'requests', true, T0);
    store.observeEdge('f', 'me', 'follows', true, T0);
    churn().advanceTimers();
    expect(['r', 'f', 'p'].map((pk) => store.getFollowRecord(pk)?.state))
      .toEqual(['pending_followback', 'pending_followback', 'unfollow_queued']);
  });

  test('once a session\'s reviews that pressed nothing reach its planned unfollows, no unfollow is offered', () => {
    queued('1');
    const reviewed = store.beginEffectIntent({ accountPk: 'x', username: 'ux', action: 'unfollow', channel: 'growth', at: T0 });
    store.settleEffectIntent(reviewed.id, { at: T0, result: 'cancelled' });
    expect(churn({ reviewBound: () => ({ since: T0 - 1, planned: 2 }) }).nextDue()?.accountPk).toBe('1');
    expect(churn({ reviewBound: () => ({ since: T0 - 1, planned: 1 }) }).nextDue()).toBeNull();
  });

  test('law L5: nextDue returns an actionable record whenever one exists, never one before its re-check', () => {
    type Kind = 'clear' | 'parked' | 'blocked' | 'requester' | 'protected';
    fc.assert(fc.property(fc.array(fc.constantFrom<Kind>('clear', 'parked', 'blocked', 'requester', 'protected'),
      { minLength: 1, maxLength: 8 }), (kinds) => {
      store.close();
      store = kitStore();
      store.setOwnPk('me');
      kinds.forEach((k, i) => {
        const pk = `p${i}`;
        queued(pk, { unfollowDueAt: T0 - (10 - i) * DAY, ...(k === 'parked' ? { recheckAt: T0 + DAY } : {}) });
        if (k === 'blocked') stuck(pk);
        if (k === 'requester') store.observeEdge(pk, 'me', 'requests', true, T0);
        if (k === 'protected') store.addTarget({ accountPk: pk, source: 'seed', status: 'retained', chainIndex: 0 });
      });
      const pick = churn().nextDue(T0, 'unfollow');
      const first = kinds.indexOf('clear');
      expect(pick?.accountPk ?? null).toBe(first === -1 ? null : `p${first}`);
      if (pick !== null) expect(pick.recheckAt ?? 0).toBeLessThanOrEqual(T0);
    }), { numRuns: 120 });
  });
});
