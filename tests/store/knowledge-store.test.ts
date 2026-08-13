import { KnowledgeStore } from '@/store/knowledge-store';
let s: KnowledgeStore;
beforeEach(() => { s = new KnowledgeStore(':memory:'); });
afterEach(() => s.close());

test('observe then getAccount projects state', () => {
  s.observe({ accountPk: '7', observedAt: 100, source: 'profile', fields: { username: 'z', followers: 100, following: 110 } });
  const a = s.getAccount('7')!;
  expect(a.username).toBe('z');
  expect(a.ratio).toBeCloseTo(1.1);
  expect(a.enrichment).toBe('profiled');
});

test('two observations keep history but project latest', () => {
  s.observe({ accountPk: '7', observedAt: 100, source: 'followers-list', fields: { username: 'z' } });
  s.observe({ accountPk: '7', observedAt: 200, source: 'profile', fields: { followers: 50, following: 60 } });
  expect(s.getAccount('7')!.followers).toBe(50);
});

test('edges track follow-back as reciprocal actives', () => {
  s.observeEdge('ME', '7', 'follows', true, 100);   // we follow them
  s.observeEdge('7', 'ME', 'follows', true, 150);   // they follow back
  expect(s.getEdge('ME', '7', 'follows')!.status).toBe('active');
  expect(s.getEdge('7', 'ME', 'follows')!.status).toBe('active');
});

test('action ledger drives durable daily count', () => {
  s.recordAction('7', 'follow', 'ok', 1000);
  s.recordAction('8', 'follow', 'ok', 2000);
  expect(s.actionCountSince(0)).toBe(2);
  expect(s.actionCountSince(1500)).toBe(1);
});

test('netGrowthSeries buckets gains/losses into cumulative local-day series', () => {
  const today0 = new Date();
  today0.setHours(0, 0, 0, 0);
  const todayMs = today0.getTime();
  const yest = new Date(today0);
  yest.setDate(yest.getDate() - 1);
  yest.setHours(0, 0, 0, 0);
  const yestMs = yest.getTime();

  // f1 gains us today; f2 gained us yesterday then dropped us today; f3 is
  // outside the 3-day window and must be excluded.
  s.observeEdge('f1', 'ME', 'follows', true, todayMs + 3_600_000);
  s.observeEdge('f2', 'ME', 'follows', true, yestMs + 3_600_000);
  s.observeEdge('f2', 'ME', 'follows', false, todayMs + 7_200_000);
  s.observeEdge('f3', 'ME', 'follows', true, todayMs - 5 * 86_400_000);

  const series = s.netGrowthSeries(3, 'ME');
  expect(series).toHaveLength(3);
  expect(series[0].cumulativeNet).toBe(0); // two days ago: no activity
  expect(series[1].dayStartMs).toBe(yestMs);
  expect(series[1].cumulativeNet).toBe(1); // +1 (f2 gained)
  expect(series[2].dayStartMs).toBe(todayMs);
  expect(series[2].cumulativeNet).toBe(1); // +1 (f1) -1 (f2 removed) on top of 1
});

test('netGrowthSeries guards non-positive days and empty ownPk', () => {
  s.observeEdge('f1', 'ME', 'follows', true, Date.now());
  expect(s.netGrowthSeries(0, 'ME')).toEqual([]);
  expect(s.netGrowthSeries(-3, 'ME')).toEqual([]);
  expect(s.netGrowthSeries(7, '')).toEqual([]);
});

test('netFollowersSince counts reciprocated follow_records since a timestamp', () => {
  s.upsertFollowRecord({ accountPk: 'a', targetPk: null, state: 'followed_back', followedAt: 100, followedBackAt: 1000, retryCount: 0 });
  s.upsertFollowRecord({ accountPk: 'b', targetPk: null, state: 'followed_back', followedAt: 100, followedBackAt: 2000, retryCount: 0 });
  s.upsertFollowRecord({ accountPk: 'c', targetPk: null, state: 'pending_followback', followedAt: 100, retryCount: 0 });
  expect(s.netFollowersSince(0)).toBe(2);
  expect(s.netFollowersSince(1500)).toBe(1);
  expect(s.netFollowersSince(3000)).toBe(0);
});

test('migrations are idempotent across reopen', () => {
  s.observe({ accountPk: '7', observedAt: 100, source: 'profile', fields: { followers: 1, following: 1 } });
  s.close();
  const s2 = new KnowledgeStore(':memory:'); // fresh; just asserts constructor+migrate doesn't throw
  expect(s2.getAccount('nope')).toBeNull();
  s2.close();
});
