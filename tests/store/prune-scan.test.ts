/**
 * Prune scan snapshot persistence (migration 3): the singleton meta row plus
 * the consumable remaining-candidates set that restores the prune panel across
 * restarts.
 */
import { KnowledgeStore, type PruneCensusRecord } from '@/store/knowledge-store';
import type { PruneScanSnapshot } from '@/store/types';
import { setLevel } from '@/utils/logger';

beforeAll(() => setLevel('error'));

const SNAP: PruneScanSnapshot = {
  at: 1_000,
  following: 250,
  followers: 180,
  candidateCount: 3,
  remaining: [
    { pk: '11', username: 'alpha' },
    { pk: '22', username: null },
    { pk: '33', username: 'gamma' },
  ],
};

describe('KnowledgeStore prune scan snapshot', () => {
  let store: KnowledgeStore;
  beforeEach(() => {
    store = new KnowledgeStore(':memory:');
  });
  afterEach(() => store.close());

  test('empty store has no snapshot', () => {
    expect(store.getPruneScan()).toBeNull();
  });

  test('save → get round-trips, preserving order and null usernames', () => {
    store.savePruneScan(SNAP);
    expect(store.getPruneScan()).toEqual(SNAP);
  });

  test('a second save fully replaces the first (singleton semantics)', () => {
    store.savePruneScan(SNAP);
    const next: PruneScanSnapshot = {
      at: 2_000,
      following: 10,
      followers: 4,
      candidateCount: 1,
      remaining: [{ pk: '99', username: 'zeta' }],
    };
    store.savePruneScan(next);
    expect(store.getPruneScan()).toEqual(next);
  });

  test('consuming a candidate drops exactly that row; meta is untouched', () => {
    store.savePruneScan(SNAP);
    store.consumePruneScanCandidate('22');
    const got = store.getPruneScan();
    expect(got?.candidateCount).toBe(3);
    expect(got?.remaining).toEqual([
      { pk: '11', username: 'alpha' },
      { pk: '33', username: 'gamma' },
    ]);
    // Consuming an unknown pk is a harmless no-op.
    store.consumePruneScanCandidate('nope');
    expect(store.getPruneScan()?.remaining).toHaveLength(2);
  });

  test('an all-consumed snapshot still reports its counts (empty remaining)', () => {
    store.savePruneScan(SNAP);
    for (const c of SNAP.remaining) store.consumePruneScanCandidate(c.pk);
    expect(store.getPruneScan()).toEqual({ ...SNAP, remaining: [] });
  });

  test('clear forgets the snapshot entirely', () => {
    store.savePruneScan(SNAP);
    store.clearPruneScan();
    expect(store.getPruneScan()).toBeNull();
  });

  test('pruneScanRemainingCount counts the unvisited rows without loading them', () => {
    expect(store.pruneScanRemainingCount()).toBe(0);
    store.savePruneScan(SNAP);
    expect(store.pruneScanRemainingCount()).toBe(3);
    store.consumePruneScanCandidate('22');
    expect(store.pruneScanRemainingCount()).toBe(2);
  });
});

describe('KnowledgeStore last-complete prune census (meta-backed)', () => {
  const CENSUS: PruneCensusRecord = {
    at: 5_000,
    following: 120,
    followers: 90,
    scrapedFollowing: 118,
    scrapedFollowers: 89,
    notFollowingBack: 40,
    candidates: 33,
  };

  let store: KnowledgeStore;
  beforeEach(() => {
    store = new KnowledgeStore(':memory:');
  });
  afterEach(() => store.close());

  test('empty store has no census', () => {
    expect(store.getPruneCensus()).toBeNull();
  });

  test('save → get round-trips', () => {
    store.savePruneCensus(CENSUS);
    expect(store.getPruneCensus()).toEqual(CENSUS);
  });

  test('a second save replaces the first (singleton semantics)', () => {
    store.savePruneCensus(CENSUS);
    store.savePruneCensus({ ...CENSUS, at: 9_000, following: 100 });
    expect(store.getPruneCensus()).toEqual({ ...CENSUS, at: 9_000, following: 100 });
  });

  test('clearing the runnable-scan snapshot leaves the census standing', () => {
    store.savePruneScan(SNAP);
    store.savePruneCensus(CENSUS);
    store.clearPruneScan();
    expect(store.getPruneScan()).toBeNull();
    expect(store.getPruneCensus()).toEqual(CENSUS);
  });
});
