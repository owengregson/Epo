/**
 * The own-edge transition hook (spec §9.10) and the `requests` edges (spec §9.9): every own-follower
 * transition writes one dated change row in the edge's own write; requesters are a live predicate.
 */
import { requesterPredicate } from '@/main/services/reopen-wiring';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { memoryStore } from '../kit/store';

let s: KnowledgeStore;
beforeEach(() => { s = memoryStore({ now: () => 10_000 }); s.setOwnPk('ME'); });
afterEach(() => s.close());

const rows = () => s.growth.changesSince(Number.MIN_SAFE_INTEGER)
  .map(({ accountPk, delta, lo, hi, source }) => ({ accountPk, delta, lo, hi, source }));
const census = (at: number) => s.savePruneCensus({ at, following: 0, followers: 0, scrapedFollowing: 0,
  scrapedFollowers: 0, notFollowingBack: 0, candidates: 0 });

test('only transitions write rows; a never-active edge and our own follows write nothing', () => {
  s.ensureFollowersBaseline(100);
  s.observeEdge('A', 'ME', 'follows', true, 200);
  s.observeEdge('A', 'ME', 'follows', true, 300);
  s.observeEdge('A', 'ME', 'follows', false, 400);
  s.observeEdge('A', 'ME', 'follows', true, 350);
  s.observeEdge('B', 'ME', 'follows', false, 500);
  s.observeEdge('ME', 'A', 'follows', true, 600);
  expect(rows()).toEqual([
    { accountPk: 'A', delta: 1, lo: 100, hi: 200, source: 'list' },
    { accountPk: 'A', delta: -1, lo: 300, hi: 400, source: 'list' },
  ]);
});

test('a re-follow is dated after the loss; before any baseline nothing is growth', () => {
  s.observeEdge('A', 'ME', 'follows', true, 50);
  expect(rows()).toEqual([]);
  s.ensureFollowersBaseline(100);
  s.observeEdge('A', 'ME', 'follows', false, 200);
  s.observeEdge('A', 'ME', 'follows', true, 300, { source: 'visit' });
  expect(rows()).toEqual([
    { accountPk: 'A', delta: -1, lo: 50, hi: 200, source: 'list' },
    { accountPk: 'A', delta: 1, lo: 200, hi: 300, source: 'visit' },
  ]);
});

test('a new follower is dated from the last complete census when there is one', () => {
  s.ensureFollowersBaseline(100);
  census(150);
  s.observeEdge('A', 'ME', 'follows', true, 400);
  s.observeEdge('C', 'ME', 'follows', true, 500, { source: 'head-walk', lo: 450 });
  expect(rows()).toEqual([
    { accountPk: 'A', delta: 1, lo: 150, hi: 400, source: 'list' },
    { accountPk: 'C', delta: 1, lo: 450, hi: 500, source: 'head-walk' },
  ]);
});

test('feed events are exact; a late dated event narrows the gain that holds it', () => {
  s.ensureFollowersBaseline(100);
  s.observeEdge('A', 'ME', 'follows', true, 500);
  s.observeOwnFollowerEvent('A', 'ME', 300);
  s.observeOwnFollowerEvent('C', 'ME', 600);
  s.observeOwnFollowerEvent('D', 'ME', 700, 'accept');
  expect(rows()).toEqual([
    { accountPk: 'A', delta: 1, lo: 300, hi: 300, source: 'list' },
    { accountPk: 'C', delta: 1, lo: 600, hi: 600, source: 'feed' },
    { accountPk: 'D', delta: 1, lo: 700, hi: 700, source: 'accept' },
  ]);
});

test('the first census is stock; a later one dates its gains from the last complete census', () => {
  s.ingestScanCensus([], ['A', 'B'], 1_000, { authoritative: true });
  expect(rows()).toEqual([]);
  census(1_000);
  s.ingestScanCensus([], ['B', 'C'], 5_000, { authoritative: true });
  expect(rows()).toEqual([
    { accountPk: 'C', delta: 1, lo: 1_000, hi: 5_000, source: 'census' },
    { accountPk: 'A', delta: -1, lo: 1_000, hi: 5_000, source: 'census' },
  ]);
  expect(s.growth.netSince(0)).toBe(0);
});

test("the first census drops its own walk's streamed rows when a baseline came first", () => {
  s.ensureFollowersBaseline(100);
  s.observeOwnFollowerEvent('E', 'ME', 200);
  s.observeEdge('W', 'ME', 'follows', true, 5_000);
  s.ingestScanCensus([], ['E', 'W', 'Z'], 6_000, { authoritative: true });
  expect(rows().map((r) => r.accountPk)).toEqual(['E']);
});

describe('requests', () => {
  test('a requester is a live predicate; the request closes when the follow opens', () => {
    const isRequester = requesterPredicate(s);
    s.observeEdge('R', 'ME', 'requests', true, 100);
    s.observeEdge('Q', 'ME', 'requests', true, 110);
    expect(isRequester('R')).toBe(true);
    expect(s.activeRequestPks().sort()).toEqual(['Q', 'R']);
    s.observeEdge('R', 'ME', 'follows', true, 200);
    expect(isRequester('R')).toBe(false);
    expect(s.getEdge('R', 'ME', 'requests')).toMatchObject({ status: 'removed', lastConfirmedAt: 200 });
    s.observeEdge('Q', 'ME', 'requests', false, 300);
    expect(s.activeRequestPks()).toEqual([]);
  });

  test('without an own pk nobody is a requester', () => {
    const fresh = memoryStore();
    try {
      fresh.observeEdge('R', 'ME', 'requests', true, 100);
      expect(fresh.hasActiveRequest('R')).toBe(false);
      expect(fresh.activeRequestPks()).toEqual([]);
    } finally { fresh.close(); }
  });
});
