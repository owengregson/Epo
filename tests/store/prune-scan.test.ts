/**
 * Prune scan snapshot persistence (migration 3): the singleton meta row plus
 * the consumable remaining-candidates set that restores the prune panel across
 * restarts.
 */
import { KnowledgeStore } from '@/store/knowledge-store';
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
});
