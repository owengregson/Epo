import {
  FollowbackWatcher,
  FOLLOWBACK_DEFAULTS,
  type OwnFollowersSource,
} from '@/engine/followback-watcher';
import { KnowledgeStore } from '@/store/knowledge-store';
import { FakeClock } from '@/governors/clock';
import type { FollowRecord } from '@/store/types';

const OWN = 'me';
const NOW = 1_000_000;

type Page = { pks: string[]; cursor: string | null; hasMore: boolean };

/** A scripted follower source that counts how many pages were fetched. */
class FakeFollowers implements OwnFollowersSource {
  calls = 0;
  constructor(private readonly pages: Page[]) {}
  async nextPage(_cursor: string | null): Promise<Page> {
    const page = this.pages[this.calls] ?? { pks: [], cursor: null, hasMore: false };
    this.calls += 1;
    return page;
  }
}

let store: KnowledgeStore;
let clock: FakeClock;
beforeEach(() => {
  store = new KnowledgeStore(':memory:');
  clock = new FakeClock(NOW);
});
afterEach(() => store.close());

const rec = (over: Partial<FollowRecord> & { accountPk: string }): FollowRecord => ({
  targetPk: null,
  state: 'pending_followback',
  followedAt: NOW - 5000,
  retryCount: 0,
  ...over,
});

const watcher = (followers: FakeFollowers): FollowbackWatcher =>
  new FollowbackWatcher({ store, clock, ownPk: OWN, followers });

test('detects a pending follow that appears at the head, holds the rest', async () => {
  store.upsertFollowRecord(rec({ accountPk: 'A' }));
  store.upsertFollowRecord(rec({ accountPk: 'B' }));
  store.upsertFollowRecord(rec({ accountPk: 'C' }));

  const src = new FakeFollowers([{ pks: ['A', 'X'], cursor: null, hasMore: false }]);
  const { detected } = await watcher(src).check();

  expect(detected).toEqual(['A']);

  // A transitioned to followed_back with the hold timer set from `now`.
  const a = store.getFollowRecord('A')!;
  expect(a.state).toBe('followed_back');
  expect(a.followedBackAt).toBe(NOW);
  expect(a.holdUntil).toBe(NOW + FOLLOWBACK_DEFAULTS.holdAfterFollowbackMs);

  // Their follow-of-us edge is recorded active.
  const edge = store.getEdge('A', OWN, 'follows')!;
  expect(edge.status).toBe('active');
  expect(edge.dstPk).toBe(OWN);

  // B and C remain pending.
  expect(store.getFollowRecord('B')!.state).toBe('pending_followback');
  expect(store.getFollowRecord('C')!.state).toBe('pending_followback');
});

test('empty pending → does not fetch any page', async () => {
  // No pending_followback records at all.
  store.upsertFollowRecord(rec({ accountPk: 'Z', state: 'queued' }));

  const src = new FakeFollowers([{ pks: ['A'], cursor: null, hasMore: false }]);
  const { detected } = await watcher(src).check();

  expect(detected).toEqual([]);
  expect(src.calls).toBe(0);
});

test('incremental stop: a page of only already-known followers halts pagination', async () => {
  store.upsertFollowRecord(rec({ accountPk: 'A' }));

  // Y already follows us (active edge pre-seeded) — it is "already-known".
  store.observeEdge('Y', OWN, 'follows', true, NOW - 10_000);

  const src = new FakeFollowers([
    { pks: ['Y'], cursor: 'c1', hasMore: true }, // all already-known → incremental stop
    { pks: ['A'], cursor: null, hasMore: false }, // must NOT be reached
  ]);
  const { detected } = await watcher(src).check();

  expect(detected).toEqual([]);
  expect(src.calls).toBe(1); // stopped after the first page
  expect(store.getFollowRecord('A')!.state).toBe('pending_followback');
});

test('an already-active edge is treated as already-known (not re-detected as new)', async () => {
  // A already follows us, and we are still pending on A. It should transition, but
  // the edge counts as already-known so a page of only such followers stops paging.
  store.upsertFollowRecord(rec({ accountPk: 'A' }));
  store.observeEdge('A', OWN, 'follows', true, NOW - 10_000);

  const src = new FakeFollowers([
    { pks: ['A'], cursor: 'c1', hasMore: true },
    { pks: ['B'], cursor: null, hasMore: false }, // must NOT be reached
  ]);
  const { detected } = await watcher(src).check();

  expect(detected).toEqual(['A']);
  expect(store.getFollowRecord('A')!.state).toBe('followed_back');
  // pending emptied by detecting A, so we stop; second page never fetched.
  expect(src.calls).toBe(1);
});

test('pages until a pending follow is found, then stops', async () => {
  store.upsertFollowRecord(rec({ accountPk: 'A' }));

  const src = new FakeFollowers([
    { pks: ['X'], cursor: 'c1', hasMore: true }, // new follower, not pending → keep going
    { pks: ['A'], cursor: null, hasMore: false }, // found A here
  ]);
  const { detected } = await watcher(src).check();

  expect(detected).toEqual(['A']);
  expect(src.calls).toBe(2);
  expect(store.getFollowRecord('A')!.state).toBe('followed_back');
});

test('maxPagesPerCheck caps the number of fetches', async () => {
  store.upsertFollowRecord(rec({ accountPk: 'NEVER' }));

  // Every page has a distinct new follower and always claims hasMore, so only the cap stops it.
  const pages: Page[] = Array.from({ length: 20 }, (_, i) => ({
    pks: [`new${i}`],
    cursor: `c${i}`,
    hasMore: true,
  }));
  const src = new FakeFollowers(pages);
  const { detected } = await new FollowbackWatcher({
    store,
    clock,
    ownPk: OWN,
    followers: src,
    cfg: { holdAfterFollowbackMs: 1000, maxPagesPerCheck: 3 },
  }).check();

  expect(detected).toEqual([]);
  expect(src.calls).toBe(3);
});

test('a page-fetch error stops the check without throwing', async () => {
  store.upsertFollowRecord(rec({ accountPk: 'A' }));

  const boom: OwnFollowersSource = {
    nextPage: async () => {
      throw new Error('network down');
    },
  };
  const { detected } = await new FollowbackWatcher({
    store,
    clock,
    ownPk: OWN,
    followers: boom,
  }).check();

  expect(detected).toEqual([]);
  expect(store.getFollowRecord('A')!.state).toBe('pending_followback');
});
