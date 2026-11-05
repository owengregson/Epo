import fc from 'fast-check';
import type { Sentinel } from '@/adapter/sentinel';
import { calendarPlanDayClock } from '@/governors/plan-day-clock';
import { checkFollowing, storeFollowingFacts } from '@/rim/following-check';
import type { WalkArgs, WalkResult } from '@/rim/list-walk-types';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { setLevel } from '@/utils/logger';
import { rec } from '../kit/engine-harness';
import { FakeSentinel } from '../kit/fakes';
import { openTestStore } from '../kit/store';

beforeAll(() => setLevel('error'));

const NOW = 5_000_000;

/** A walker that returns the whole following list in one page and proves its end (or ends as told). */
function listWalker(pks: readonly string[], end: Partial<WalkResult> = {}) {
  const calls: WalkArgs[] = [];
  return {
    calls,
    walkAll: async (a: WalkArgs): Promise<WalkResult> => {
      calls.push(a);
      for (const pk of pks) a.onObservation({ accountPk: pk, observedAt: NOW, source: 'following-list', fields: { username: `u${pk}` } }, null);
      return { pks: [...pks], pages: 2, complete: true, endConfirmed: true, endEvidence: 'probe', quarantined: 0,
        reason: 'no-more-pages', cursor: null, ...end };
    },
  };
}

function setup(): KnowledgeStore {
  const store = openTestStore(':memory:');
  store.setOwnPk('ME');
  // Epo follows a (managed); the owner followed b and c outside Epo earlier.
  for (const pk of ['a', 'b', 'c']) store.observeEdge('ME', pk, 'follows', true, NOW - 100);
  store.upsertFollowRecord(rec({ accountPk: 'a', state: 'pending_followback', followedAt: NOW - 100 }));
  store.upsertFollowRecord(rec({ accountPk: 'm', state: 'pending_followback', followedAt: NOW - 50 }));
  store.growth.completeOutsideFollowing(new Set(['a', 'b', 'c']), calendarPlanDayClock().window(NOW).startsAt, NOW - 100);
  return store;
}

const run = (store: KnowledgeStore, walker: ReturnType<typeof listWalker>, signal = new AbortController().signal) =>
  checkFollowing({ walker, facts: storeFollowingFacts(store, 'ME', calendarPlanDayClock()), clock: { now: () => NOW },
    sentinel: new FakeSentinel() as unknown as Sentinel }, { ownPk: 'ME', signal });

test('a whole read names outside follows and outside unfollows; managed records the owner unfollowed become external', async () => {
  const store = setup();
  // The owner unfollowed a (Epo's) and c, and followed d; m is Epo's follow whose edge the read confirms.
  const walker = listWalker(['b', 'd', 'm']);
  const res = await run(store, walker);
  expect(res).toEqual({ ok: true, complete: true, count: 3, removed: 2, added: 1 });
  expect(store.getEdge('ME', 'a', 'follows')?.status).toBe('removed');
  expect(store.getEdge('ME', 'c', 'follows')?.status).toBe('removed');
  expect(store.getEdge('ME', 'd', 'follows')?.status).toBe('active');
  expect(store.getFollowRecord('a')?.state).toBe('external');
  expect(store.getFollowRecord('m')?.state).toBe('pending_followback');
  expect(walker.calls[0]).toMatchObject({ which: 'following', maxPages: 2, readUse: 'check' });
  store.close();
});

test('a read that did not prove the whole list writes its rows but no absence', async () => {
  const store = setup();
  const res = await run(store, listWalker(['b', 'd'], { complete: false, reason: 'max-pages' }));
  expect(res).toEqual({ ok: false, reason: 'incomplete' });
  expect(store.getEdge('ME', 'a', 'follows')?.status).toBe('active');
  expect(store.getEdge('ME', 'd', 'follows')?.status).toBe('active');
  store.close();
});

test('quarantined rows refuse every verdict', async () => {
  const store = setup();
  expect(await run(store, listWalker(['b'], { quarantined: 1 }))).toEqual({ ok: false, reason: 'incomplete' });
  expect(store.getEdge('ME', 'a', 'follows')?.status).toBe('active');
  store.close();
});

test('a refused read budget and a stop are typed', async () => {
  const store = setup();
  expect(await run(store, listWalker([], { complete: false, reason: 'read-budget', retryAt: 9 })))
    .toEqual({ ok: false, reason: 'read-budget', retryAt: 9 });
  expect(await run(store, listWalker([], { complete: false, reason: 'stop-requested' })))
    .toEqual({ ok: false, reason: 'stopped' });
  store.close();
});


test('exact additions replace estimates, survive partial reads, and repeated checks never double-charge (law)', async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 6 }), async (n, repeats) => {
    const store = setup();
    const day = calendarPlanDayClock().window(NOW);
    const additions = Array.from({ length: n }, (_, i) => `outside${i}`);
    store.growth.noteOwnHeader({ at: day.startsAt + 1, followers: 10, following: 3 });
    store.growth.noteOwnHeader({ at: NOW - 1, followers: 10, following: 3 + n + 9 });
    await run(store, listWalker(additions, { complete: false, reason: 'max-pages' }));
    expect(store.growth.outsideSince(day.startsAt)).toBe(n + 9);
    const whole = ['a', 'b', 'c', 'm', ...additions];
    expect(await run(store, listWalker(whole))).toMatchObject({ added: n });
    for (let i = 0; i < repeats; i++) {
      expect(await run(store, listWalker(whole))).toMatchObject({ added: 0 });
      expect(store.growth.outsideSince(day.startsAt)).toBe(n);
    }
    // Epo's later public follow consumes one of the header's three new follows.
    store.recordAction('engine-new', 'follow', 'ok', NOW + 1);
    store.growth.noteOwnHeader({ at: NOW + 2, followers: 10, following: whole.length + 3 });
    store.growth.invalidate();
    expect(store.growth.outsideSince(day.startsAt)).toBe(n + 2);
    expect(store.growth.outsideSince(day.endsAt)).toBe(0);
    store.close();
  }), { numRuns: 20 });
});


test('the first whole following list establishes stock while preserving the earlier header charge', async () => {
  const store = openTestStore(':memory:');
  store.setOwnPk('ME');
  const day = calendarPlanDayClock().window(NOW);
  store.growth.noteOwnHeader({ at: day.startsAt + 1, followers: 10, following: 100 });
  store.growth.noteOwnHeader({ at: NOW - 1, followers: 10, following: 104 });
  const stock = Array.from({ length: 104 }, (_, i) => `stock${i}`);
  expect(await run(store, listWalker(stock))).toMatchObject({ added: 0 });
  expect(store.growth.outsideSince(day.startsAt)).toBe(4);
  expect(await run(store, listWalker([...stock, 'new-outside']))).toMatchObject({ added: 1 });
  expect(store.growth.outsideSince(day.startsAt)).toBe(5);
  expect(await run(store, listWalker([...stock, 'new-outside']))).toMatchObject({ added: 0 });
  expect(store.growth.outsideSince(day.startsAt)).toBe(5);
  store.close();
});

test('landed manual and engine follows without managed records are never charged again as outside follows', async () => {
  const store = setup();
  store.recordAction('manual', 'follow', 'ok', NOW - 1);
  store.observe({ accountPk: 'private', observedAt: NOW - 200, source: 'profile', fields: { isPrivate: true } });
  store.recordAction('private', 'follow', 'ok', NOW - 200); // an earlier request accepted after the baseline
  const i = store.beginEffectIntent({ accountPk: 'intent', username: 'intent', action: 'follow', channel: 'manual', at: NOW - 2 });
  store.markEffectDispatched(i.id, NOW - 2);
  store.settleEffectIntent(i.id, { result: 'ok', at: NOW - 1, ledger: 'none' });
  expect(await run(store, listWalker(['a', 'b', 'c', 'manual', 'private', 'intent', 'outside']))).toMatchObject({ added: 1 });
  expect(store.growth.outsideSince(calendarPlanDayClock().window(NOW).startsAt)).toBe(1);
  store.close();
});

test('a verified removal ends the exemption of an older Epo follow before an outside refollow', async () => {
  const store = setup();
  store.recordAction('old', 'follow', 'ok', NOW - 200);
  store.observeEdge('ME', 'old', 'follows', false, NOW - 100);
  expect(await run(store, listWalker(['a', 'b', 'c', 'old']))).toMatchObject({ added: 1 });
  store.close();
});
