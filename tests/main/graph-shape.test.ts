import { shapeGraphSnapshot, type GraphShapeOpts } from '@/main/foundation-reads';
import type { GraphSourceRows } from '@/store/types';
import { GRAPH_NODE_STATUSES, type GraphNodeStatus, type GraphSnapshot } from '@/types';

/**
 * The graph-view shaper (`graph:snapshot`) is pure — raw store rows in, one
 * columnar snapshot out — so it is exercised here with plain fixtures: no
 * SQLite, no login, no browser.
 */

const DAY = 24 * 3600 * 1000;
const OPTS: GraphShapeOpts = { now: 10 * DAY, followbackWaitMs: 4 * DAY };

function rows(over: Partial<GraphSourceRows> = {}): GraphSourceRows {
  return {
    ownPk: 'me',
    ownUsername: 'owen',
    hubs: [{ pk: 'T1', username: 'seed', status: 'active', chainIndex: 0 }],
    records: [],
    crowd: [],
    ownFollowers: [],
    ownFollowing: [],
    ...over,
  };
}

/** Status name of node `pk` in a shaped snapshot. */
function statusOf(snap: GraphSnapshot, pk: string): GraphNodeStatus {
  const i = snap.pks.indexOf(pk);
  expect(i).toBeGreaterThanOrEqual(0);
  return GRAPH_NODE_STATUSES[snap.statuses[i] as number] as GraphNodeStatus;
}

function nodeOf(snap: GraphSnapshot, pk: string): number {
  const i = snap.pks.indexOf(pk);
  expect(i).toBeGreaterThanOrEqual(0);
  return i;
}

test('null in, null out (pre-login there is nothing to draw)', () => {
  expect(shapeGraphSnapshot(null, OPTS)).toBeNull();
});

test('hubs are self-first then chain order, and are never members', () => {
  const snap = shapeGraphSnapshot(
    rows({
      hubs: [
        { pk: 'T1', username: 'seed', status: 'active', chainIndex: 0 },
        { pk: 'T2', username: 'next', status: 'exhausted', chainIndex: 1 },
      ],
      // Edges onto hubs/self must not create member nodes.
      crowd: [
        { pk: 'T2', hubPk: 'T1', username: 'next', followers: 10 },
        { pk: 'me', hubPk: 'T1', username: 'owen', followers: 10 },
        { pk: 'a', hubPk: 'T1', username: 'a', followers: 10 },
      ],
      ownFollowers: [{ pk: 'T1', username: 'seed', followers: 5 }],
    }),
    OPTS,
  );
  expect(snap).not.toBeNull();
  expect(snap?.hubs.map((h) => h.pk)).toEqual(['me', 'T1', 'T2']);
  expect(snap?.hubs[0]?.kind).toBe('self');
  expect(snap?.hubs[1]?.targetStatus).toBe('active');
  expect(snap?.pks).toEqual(['a']);
});

test('crowd rows read as known, first hub in chain order claiming the node', () => {
  const snap = shapeGraphSnapshot(
    rows({
      hubs: [
        { pk: 'T1', username: 'seed', status: 'active', chainIndex: 0 },
        { pk: 'T2', username: 'next', status: 'active', chainIndex: 1 },
      ],
      crowd: [
        { pk: 'a', hubPk: 'T1', username: 'a', followers: 100 },
        { pk: 'a', hubPk: 'T2', username: 'a', followers: 100 }, // dup: T1 already won
        { pk: 'b', hubPk: 'T2', username: 'b', followers: -0 },
      ],
    }),
    OPTS,
  )!;
  expect(statusOf(snap, 'a')).toBe('known');
  expect(snap.hubIndex[nodeOf(snap, 'a')]).toBe(1); // T1
  expect(snap.hubIndex[nodeOf(snap, 'b')]).toBe(2); // T2
  expect(snap.hubs[1]?.memberCount).toBe(1);
  expect(snap.hubs[2]?.memberCount).toBe(1);
});

test('own edges: follows_you / you_follow, and both at once reads mutual', () => {
  const snap = shapeGraphSnapshot(
    rows({
      ownFollowers: [
        { pk: 'fan', username: 'fan', followers: 1 },
        { pk: 'friend', username: 'friend', followers: 1 },
      ],
      ownFollowing: [
        { pk: 'idol', username: 'idol', followers: 1 },
        { pk: 'friend', username: 'friend', followers: 1 },
      ],
    }),
    OPTS,
  )!;
  expect(statusOf(snap, 'fan')).toBe('follows_you');
  expect(statusOf(snap, 'idol')).toBe('you_follow');
  expect(statusOf(snap, 'friend')).toBe('mutual');
  // Relationship-only nodes cluster on the self hub.
  expect(snap.hubIndex[nodeOf(snap, 'fan')]).toBe(0);
  expect(snap.counts.mutual).toBe(1);
});

test('a follow record always wins the status and its target claims the cluster', () => {
  const snap = shapeGraphSnapshot(
    rows({
      crowd: [{ pk: 'a', hubPk: 'T1', username: 'a', followers: 3 }],
      ownFollowers: [{ pk: 'a', username: 'a', followers: 3 }],
      records: [
        {
          pk: 'a',
          state: 'followed_back',
          followedAt: 5 * DAY,
          followedBackAt: 8 * DAY,
          holdUntil: 12 * DAY,
          targetPk: 'T1',
          username: 'a',
          followers: 3,
        },
      ],
    }),
    OPTS,
  )!;
  expect(statusOf(snap, 'a')).toBe('held');
  expect(snap.hubIndex[nodeOf(snap, 'a')]).toBe(1);
  // now=10d sits halfway through the 8d→12d hold.
  expect(snap.progress[nodeOf(snap, 'a')]).toBeCloseTo(0.5);
});

test('a record without a live target keeps the prior cluster, else self', () => {
  const snap = shapeGraphSnapshot(
    rows({
      crowd: [{ pk: 'a', hubPk: 'T1', username: 'a', followers: 3 }],
      records: [
        { pk: 'a', state: 'external', followedAt: null, followedBackAt: null, holdUntil: null, targetPk: 'gone', username: 'a', followers: 3 },
        { pk: 'b', state: 'unfollowed', followedAt: null, followedBackAt: null, holdUntil: null, targetPk: null, username: 'b', followers: 1 },
      ],
    }),
    OPTS,
  )!;
  expect(snap.hubIndex[nodeOf(snap, 'a')]).toBe(1); // kept T1 from the crowd row
  expect(snap.hubIndex[nodeOf(snap, 'b')]).toBe(0); // self fallback
  expect(statusOf(snap, 'a')).toBe('external');
  expect(statusOf(snap, 'b')).toBe('unfollowed');
});

test('waiting progress runs follow → timeout and clamps', () => {
  const record = (pk: string, followedAt: number | null) => ({
    pk,
    state: 'pending_followback' as const,
    followedAt,
    followedBackAt: null,
    holdUntil: null,
    targetPk: 'T1',
    username: pk,
    followers: 0,
  });
  const snap = shapeGraphSnapshot(
    rows({
      records: [record('half', 8 * DAY), record('overdue', DAY), record('unstamped', null)],
    }),
    OPTS,
  )!;
  expect(snap.progress[nodeOf(snap, 'half')]).toBeCloseTo(0.5); // 2d into a 4d wait
  expect(snap.progress[nodeOf(snap, 'overdue')]).toBe(1); // clamped
  expect(snap.progress[nodeOf(snap, 'unstamped')]).toBe(0); // clock not visibly started
});

test('untimed statuses carry progress -1; degenerate holds read as elapsed', () => {
  const snap = shapeGraphSnapshot(
    rows({
      crowd: [{ pk: 'k', hubPk: 'T1', username: 'k', followers: 0 }],
      records: [
        {
          pk: 'd',
          state: 'followed_back',
          followedAt: DAY,
          followedBackAt: 2 * DAY,
          holdUntil: 2 * DAY, // zero-length hold
          targetPk: 'T1',
          username: 'd',
          followers: 0,
        },
      ],
    }),
    OPTS,
  )!;
  expect(snap.progress[nodeOf(snap, 'k')]).toBe(-1);
  expect(snap.progress[nodeOf(snap, 'd')]).toBe(1);
});

test('counts and memberCount agree with the columnar arrays', () => {
  const snap = shapeGraphSnapshot(
    rows({
      crowd: [
        { pk: 'a', hubPk: 'T1', username: 'a', followers: 0 },
        { pk: 'b', hubPk: 'T1', username: 'b', followers: 0 },
      ],
      ownFollowers: [{ pk: 'c', username: 'c', followers: 0 }],
    }),
    OPTS,
  )!;
  expect(snap.pks.length).toBe(3);
  expect(snap.usernames.length).toBe(3);
  expect(snap.statuses.length).toBe(3);
  expect(snap.progress.length).toBe(3);
  expect(snap.hubIndex.length).toBe(3);
  expect(snap.followers.length).toBe(3);
  expect(snap.counts.known).toBe(2);
  expect(snap.counts.follows_you).toBe(1);
  const total = GRAPH_NODE_STATUSES.reduce((sum, s) => sum + snap.counts[s], 0);
  expect(total).toBe(3);
  expect(snap.hubs.reduce((sum, h) => sum + h.memberCount, 0)).toBe(3);
});
