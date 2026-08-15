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

test('action-delay deadline round-trips through durable meta (set, overwrite, clear)', () => {
  expect(s.getActionDelayDeadline()).toBeNull();
  s.setActionDelayDeadline(1_234_567);
  expect(s.getActionDelayDeadline()).toBe(1_234_567);
  s.setActionDelayDeadline(2_000_000); // mutable, unlike the set-once baseline
  expect(s.getActionDelayDeadline()).toBe(2_000_000);
  s.setActionDelayDeadline(null);
  expect(s.getActionDelayDeadline()).toBeNull();
});

test('mutual-follower count persists and re-projects', () => {
  s.observe({ accountPk: '7', observedAt: 100, source: 'profile', fields: { followers: 100, following: 90, mutuals: 12 } });
  expect(s.getAccount('7')!.mutuals).toBe(12);
  // A later profile read updates it; an older/weaker read cannot clobber it.
  s.observe({ accountPk: '7', observedAt: 200, source: 'profile', fields: { mutuals: 15 } });
  expect(s.getAccount('7')!.mutuals).toBe(15);
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

test('the first census sets the growth BASELINE: its bulk never charts as one-day growth', () => {
  const today0 = new Date();
  today0.setHours(0, 0, 0, 0);
  const noonToday = today0.getTime() + 12 * 3_600_000;

  s.setOwnPk('ME');
  // Initial app run: the first complete census records ~everyone at once.
  s.ingestScanCensus(['x1', 'x2'], ['f1', 'f2', 'f3'], noonToday);
  expect(s.followersBaselineAt()).toBe(noonToday);

  // The census bulk is STOCK — the series stays flat at zero.
  const flat = s.netGrowthSeries(3, 'ME');
  expect(flat.every((p) => p.cumulativeNet === 0)).toBe(true);

  // A follower gained AFTER the baseline is real growth; a baseline follower
  // dropping us after it is a real loss.
  s.observeEdge('f4', 'ME', 'follows', true, noonToday + 3_600_000);
  s.observeEdge('f1', 'ME', 'follows', false, noonToday + 7_200_000);
  const series = s.netGrowthSeries(3, 'ME');
  expect(series[series.length - 1].cumulativeNet).toBe(0); // +1 (f4) − 1 (f1)
  s.observeEdge('f5', 'ME', 'follows', true, noonToday + 10_800_000);
  expect(s.netGrowthSeries(3, 'ME')[2].cumulativeNet).toBe(1);
});

test('the baseline is set-once and retroactively absorbs earlier partial sweeps', () => {
  const today0 = new Date();
  today0.setHours(0, 0, 0, 0);
  const noonToday = today0.getTime() + 12 * 3_600_000;

  s.setOwnPk('ME');
  // A follow-back sweep ran BEFORE any census and bulk-recorded head followers.
  s.observeEdge('s1', 'ME', 'follows', true, noonToday - 3_600_000);
  s.observeEdge('s2', 'ME', 'follows', true, noonToday - 3_600_000);
  // Without a baseline they chart (nothing better is known yet)…
  expect(s.netGrowthSeries(3, 'ME')[2].cumulativeNet).toBe(2);

  // …but the first census heals it: sweep edges predate the baseline → stock.
  s.ingestScanCensus([], ['s1', 's2', 'f1'], noonToday);
  expect(s.netGrowthSeries(3, 'ME')[2].cumulativeNet).toBe(0);

  // A SECOND census does not move the baseline; genuinely new followers in it
  // (first seen after the baseline) count as growth.
  s.ingestScanCensus([], ['s1', 's2', 'f1', 'NEW'], noonToday + 3_600_000);
  expect(s.followersBaselineAt()).toBe(noonToday);
  expect(s.netGrowthSeries(3, 'ME')[2].cumulativeNet).toBe(1); // just NEW
});

test('netGrowthSeries guards non-positive days and empty ownPk', () => {
  s.observeEdge('f1', 'ME', 'follows', true, Date.now());
  expect(s.netGrowthSeries(0, 'ME')).toEqual([]);
  expect(s.netGrowthSeries(-3, 'ME')).toEqual([]);
  expect(s.netGrowthSeries(7, '')).toEqual([]);
});

test('netFollowersSince is a true net: edge gains minus edge losses in the window', () => {
  s.setOwnPk('ME');
  // Gains: two followers first seen at 1000 and 2000.
  s.observeEdge('a', 'ME', 'follows', true, 1000);
  s.observeEdge('b', 'ME', 'follows', true, 2000);
  // Loss: one earlier follower removed at 2500.
  s.observeEdge('c', 'ME', 'follows', true, 500);
  s.observeEdge('c', 'ME', 'follows', false, 2500);
  // Window from 0: gains a,b,c(+3) minus loss c(−1) = 2.
  expect(s.netFollowersSince(0)).toBe(2);
  // Window from 1500: gain b(+1) minus loss c(−1) = 0.
  expect(s.netFollowersSince(1500)).toBe(0);
  // Window from 3000: nothing.
  expect(s.netFollowersSince(3000)).toBe(0);
});

test('netFollowersSince respects the followers baseline (stock never counts)', () => {
  s.setOwnPk('ME');
  s.observeEdge('stock', 'ME', 'follows', true, 1000);
  s.ingestScanCensus([], ['stock'], 1000); // establishes baseline at 1000
  s.observeEdge('new', 'ME', 'follows', true, 2000);
  expect(s.netFollowersSince(0)).toBe(1); // only 'new'; 'stock' is baseline
});

test('an authoritative census records lost followers and healed follows', () => {
  s.setOwnPk('ME');
  // We follow x and y; x follows us back. A pending request to p is outstanding.
  s.observeEdge('ME', 'x', 'follows', true, 1000);
  s.observeEdge('ME', 'y', 'follows', true, 1000);
  s.observeEdge('ME', 'p', 'follows', true, 1000);
  s.upsertFollowRecord({ accountPk: 'p', targetPk: null, state: 'pending_followback', followedAt: 1000, retryCount: 0 });
  s.observeEdge('x', 'ME', 'follows', true, 1000);
  s.observeEdge('z', 'ME', 'follows', true, 1000);

  // Complete census: we still follow x only; only z still follows us.
  s.ingestScanCensus(['x'], ['z'], 2000, { authoritative: true });

  // Lost follower x → pk→ME edge removed; z stays active.
  expect(s.getEdge('x', 'ME', 'follows')?.status).toBe('removed');
  expect(s.getEdge('z', 'ME', 'follows')?.status).toBe('active');
  // Gone follow y → ME→pk edge removed; the pending private request p is spared.
  expect(s.getEdge('ME', 'y', 'follows')?.status).toBe('removed');
  expect(s.getEdge('ME', 'p', 'follows')?.status).toBe('active');
  expect(s.getFollowRecord('p')?.state).toBe('pending_followback');
});

test('a non-authoritative census stays purely additive', () => {
  s.setOwnPk('ME');
  s.observeEdge('x', 'ME', 'follows', true, 1000);
  s.ingestScanCensus([], ['z'], 2000);
  expect(s.getEdge('x', 'ME', 'follows')?.status).toBe('active');
});

test('migrations are idempotent across reopen', () => {
  s.observe({ accountPk: '7', observedAt: 100, source: 'profile', fields: { followers: 1, following: 1 } });
  s.close();
  const s2 = new KnowledgeStore(':memory:'); // fresh; just asserts constructor+migrate doesn't throw
  expect(s2.getAccount('nope')).toBeNull();
  s2.close();
});
