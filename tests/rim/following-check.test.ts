import type { Sentinel } from '@/adapter/sentinel';
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
  return store;
}

const run = (store: KnowledgeStore, walker: ReturnType<typeof listWalker>, signal = new AbortController().signal) =>
  checkFollowing({ walker, facts: storeFollowingFacts(store, 'ME'), clock: { now: () => NOW },
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
