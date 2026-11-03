/**
 * The census on the plan-day boundary (spec §17.9): the first census treats one plan-day before its
 * verdict as its own walk's stock, with the window passed in; the last complete census is exposed.
 */
import type { KnowledgeStore } from '@/store/knowledge-store';
import { memoryStore } from '../kit/store';

const H = 3_600_000;
const AT = 1_000 * H;

let s: KnowledgeStore;
beforeEach(() => { s = memoryStore({ now: () => AT }); s.setOwnPk('ME'); s.ensureFollowersBaseline(H); });
afterEach(() => s.close());

const gains = () => s.growth.changesSince(Number.MIN_SAFE_INTEGER).filter((c) => c.delta === 1).map((c) => c.accountPk);

test('a 25-hour plan-day widens the first census stock window to 25 hours', () => {
  s.observeEdge('W', 'ME', 'follows', true, AT - 24.5 * H);
  s.ingestScanCensus([], ['W'], AT, { authoritative: true, planDay: { startsAt: AT - 2 * H, endsAt: AT + 23 * H } });
  expect(gains()).toEqual([]);
  expect(s.getEdge('W', 'ME', 'follows')?.firstSeenAt).toBe(H);
});

test('a 23-hour plan-day keeps an older walk row as growth', () => {
  s.observeEdge('W', 'ME', 'follows', true, AT - 23.5 * H);
  s.ingestScanCensus([], ['W'], AT, { authoritative: true, planDay: { startsAt: AT - 2 * H, endsAt: AT + 21 * H } });
  expect(gains()).toEqual(['W']);
  expect(s.getEdge('W', 'ME', 'follows')?.firstSeenAt).toBe(AT - 23.5 * H);
});

test('the last complete census is exposed for the durable census predicate', () => {
  expect(s.censusLastCompleteAt()).toBeNull();
  s.savePruneCensus({ at: AT, following: 1, followers: 2, scrapedFollowing: 1, scrapedFollowers: 2,
    notFollowingBack: 0, candidates: 0 });
  expect(s.censusLastCompleteAt()).toBe(AT);
});
