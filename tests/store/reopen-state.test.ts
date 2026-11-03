/**
 * The reopen frontiers' home (`meta.reopen_state`, spec §16.3): a validated parse where a corrupt
 * value logs an error and reads as absent, and the one-time seed from the legacy `lifecycle_state`.
 */
import type { KnowledgeStore } from '@/store/knowledge-store';
import type { ReopenState } from '@/store/repos/reopen-state';
import { setSink } from '@/utils/logger';
import { memoryStore } from '../kit/store';

let s: KnowledgeStore;
let errors: string[];
beforeEach(() => {
  s = memoryStore();
  errors = [];
  setSink((level, message) => { if (level === 'error') errors.push(message); });
});
afterEach(() => { setSink(null); s.close(); });

const FULL: ReopenState = {
  v: 1,
  feed: { atMs: 900, keysAtMs: ['p1|900'], readAt: 1_000, filteredAt: 1_000, gap: { fromAtMs: 100, toAtMs: 400 } },
  head: { walkedAt: 1_000, rowsPerPage: 24, order: { verdict: 'newest-first', pairs: 60, ordered: 60, at: 1_000 },
    contiguous: true },
  requests: { observedAt: 1_000, count: 3, complete: false, verifiedDayKey: '2026-11-02' },
  lastSweep: { id: 4, mode: 'session', startedAt: 990, endedAt: 1_010 },
  lastCatchUp: null,
  following: { checkedAt: 1_000, count: 412, complete: true },
};

test('absent until written; a written state reads back exactly', () => {
  expect(s.reopen.get()).toBeNull();
  s.reopen.set(FULL);
  expect(s.reopen.get()).toEqual(FULL);
});

test.each([
  ['not JSON', '{nope'],
  ['a future version', JSON.stringify({ ...FULL, v: 2 })],
  ['a bad frontier', JSON.stringify({ ...FULL, head: { ...FULL.head, rowsPerPage: 'many' } })],
  ['a bad watermark key list', JSON.stringify({ ...FULL, feed: { ...FULL.feed, keysAtMs: [1] } })],
  ['an unknown sweep mode', JSON.stringify({ ...FULL, lastSweep: { ...FULL.lastSweep, mode: 'later' } })],
])('a corrupt document (%s) logs an error and reads as absent', (_why, raw) => {
  s.reopen.setRaw(raw);
  expect(s.reopen.get()).toBeNull();
  expect(errors).toEqual(['store: reopen_state unreadable, treated as absent']);
});

describe('the legacy seed', () => {
  const legacy = (lastActiveAt: number | null) =>
    s.setLifecycleState(JSON.stringify({ v: 1, phase: 'ready', reason: null, lastActiveAt }));

  test('the last sweep ends at the later of v1 activity and the carried sweep stamp; v1 is cleared', () => {
    legacy(5_000);
    const seeded = s.reopen.seedFromLegacy({ sweepLastRunAt: 7_000 });
    expect(seeded?.lastSweep).toEqual({ id: 0, mode: 'check', startedAt: 7_000, endedAt: 7_000 });
    expect(seeded).toMatchObject({ feed: null, head: null, requests: null, lastCatchUp: null, following: null });
    expect(s.reopen.get()).toEqual(seeded);
    expect(s.getLifecycleState()).toBeNull();
  });

  test('runs once: an existing state is kept and nothing is re-read', () => {
    s.reopen.set(FULL);
    legacy(9_000);
    expect(s.reopen.seedFromLegacy({ sweepLastRunAt: 9_500 })).toEqual(FULL);
    expect(s.getLifecycleState()).not.toBeNull();
  });

  test('a corrupt v1 logs an error, seeds nothing and is cleared', () => {
    s.setLifecycleState('{broken');
    expect(s.reopen.seedFromLegacy({ sweepLastRunAt: null })).toBeNull();
    expect(errors).toEqual(['store: lifecycle_state unreadable, nothing seeded']);
    expect(s.reopen.get()).toBeNull();
    expect(s.getLifecycleState()).toBeNull();
  });

  test('with no legacy evidence nothing is seeded (the first sweep runs as a first run)', () => {
    expect(s.reopen.seedFromLegacy({ sweepLastRunAt: null })).toBeNull();
    legacy(null);
    expect(s.reopen.seedFromLegacy({ sweepLastRunAt: null })).toBeNull();
    expect(s.getLifecycleState()).toBeNull();
  });
});
