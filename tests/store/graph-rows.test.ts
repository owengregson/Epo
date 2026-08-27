import { KnowledgeStore } from '@/store/knowledge-store';

/**
 * `graphSnapshotRows` — the bulk joined reads feeding the Graph view. Real
 * in-memory SQLite; the pure shaping on top is covered in
 * tests/main/graph-shape.test.ts.
 */

let s: KnowledgeStore;
beforeEach(() => {
  s = new KnowledgeStore(':memory:');
});
afterEach(() => s.close());

const seen = (pk: string, username: string, followers?: number): void =>
  s.observe({
    accountPk: pk,
    observedAt: 1000,
    source: 'profile',
    fields: followers === undefined ? { username } : { username, followers, following: 10 },
  });

test('null until setOwnPk — pre-login there is no graph to anchor', () => {
  expect(s.graphSnapshotRows()).toBeNull();
  s.setOwnPk('me');
  expect(s.graphSnapshotRows()).not.toBeNull();
});

test('hubs come back in chain order with usernames joined', () => {
  s.setOwnPk('me');
  seen('me', 'owen');
  seen('T1', 'seed');
  seen('T2', 'next');
  s.addTarget({ accountPk: 'T2', source: 'discovered', status: 'active', chainIndex: 1 });
  s.addTarget({ accountPk: 'T1', source: 'seed', status: 'exhausted', chainIndex: 0 });
  const rows = s.graphSnapshotRows();
  expect(rows?.ownUsername).toBe('owen');
  expect(rows?.hubs.map((h) => h.pk)).toEqual(['T1', 'T2']);
  expect(rows?.hubs[0]).toEqual({ pk: 'T1', username: 'seed', status: 'exhausted', chainIndex: 0 });
});

test('records join their account and carry every timer column', () => {
  s.setOwnPk('me');
  seen('10', 'alice', 500);
  s.upsertFollowRecord({
    accountPk: '10',
    targetPk: 'T1',
    state: 'followed_back',
    followedAt: 100,
    followedBackAt: 200,
    holdUntil: 300,
    retryCount: 0,
  });
  const rows = s.graphSnapshotRows();
  expect(rows?.records).toEqual([
    {
      pk: '10',
      state: 'followed_back',
      followedAt: 100,
      followedBackAt: 200,
      holdUntil: 300,
      targetPk: 'T1',
      username: 'alice',
      followers: 500,
    },
  ]);
});

test('crowd holds ACTIVE followers of chain targets only, in chain order', () => {
  s.setOwnPk('me');
  s.addTarget({ accountPk: 'T1', source: 'seed', status: 'active', chainIndex: 0 });
  s.addTarget({ accountPk: 'T2', source: 'discovered', status: 'active', chainIndex: 1 });
  seen('a', 'a_user', 42);
  s.observeEdge('a', 'T2', 'follows', true, 1000);
  s.observeEdge('b', 'T1', 'follows', true, 1000); // stub account: null username
  s.observeEdge('c', 'T1', 'follows', true, 1000);
  s.observeEdge('c', 'T1', 'follows', false, 2000); // removed → excluded
  s.observeEdge('d', 'X', 'follows', true, 1000); // not a target → excluded
  const rows = s.graphSnapshotRows();
  expect(rows?.crowd).toEqual([
    { pk: 'b', hubPk: 'T1', username: null, followers: null },
    { pk: 'a', hubPk: 'T2', username: 'a_user', followers: 42 },
  ]);
});

test('own follower/following edges come back joined, active only', () => {
  s.setOwnPk('me');
  seen('fan', 'fan_user', 7);
  s.observeEdge('fan', 'me', 'follows', true, 1000);
  s.observeEdge('me', 'idol', 'follows', true, 1000);
  s.observeEdge('me', 'gone', 'follows', true, 1000);
  s.observeEdge('me', 'gone', 'follows', false, 2000);
  const rows = s.graphSnapshotRows();
  expect(rows?.ownFollowers).toEqual([{ pk: 'fan', username: 'fan_user', followers: 7 }]);
  expect(rows?.ownFollowing).toEqual([{ pk: 'idol', username: null, followers: null }]);
});
