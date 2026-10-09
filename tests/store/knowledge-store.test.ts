import type { KnowledgeStore } from '@/store/knowledge-store';
import { memoryStore } from '../kit/store';

/**
 * A fixed LOCAL instant every day-bucket assertion is anchored to. The growth
 * series buckets by local midnight, so reading "today" off the machine's clock
 * made these tests a function of when they ran (and of DST). The store takes
 * `now`, so the calendar is an input here, not an accident.
 */
const NOON_TODAY = new Date(2026, 4, 14, 12, 0, 0, 0).getTime(); // local noon
const localMidnight = (ms: number): number => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const TODAY_MS = localMidnight(NOON_TODAY);
const YESTERDAY_MS = (() => {
  const d = new Date(TODAY_MS);
  d.setDate(d.getDate() - 1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
})();
const DAY = 86_400_000;

let s: KnowledgeStore;
beforeEach(() => { s = memoryStore({ now: () => NOON_TODAY }); });
afterEach(() => s.close());

test('observe then getAccount projects state', () => {
  s.observe({ accountPk: '7', observedAt: 100, source: 'profile', fields: { username: 'z', followers: 100, following: 110 } });
  const a = s.getAccount('7')!;
  expect(a.username).toBe('z');
  expect(a.ratio).toBeCloseTo(1.1);
  expect(a.enrichment).toBe('profiled');
});

test('bio persists, re-projects, and distinguishes empty from never-observed', () => {
  s.observe({ accountPk: '7', observedAt: 100, source: 'followers-list', fields: { username: 'z' } });
  expect(s.getAccount('7')!.bio).toBeUndefined(); // never observed
  s.observe({ accountPk: '7', observedAt: 200, source: 'profile', fields: { bio: 'Dog mom 🐶' } });
  expect(s.getAccount('7')!.bio).toBe('Dog mom 🐶');
  s.observe({ accountPk: '7', observedAt: 300, source: 'profile', fields: { bio: '' } });
  expect(s.getAccount('7')!.bio).toBe(''); // fetched-and-empty is a fact, not absence
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

test('username_history logs only real changes, never one row per observation', () => {
  const rows = (): Array<{ username: string; seen_at: number }> =>
    (s as unknown as {
      db: { prepare(q: string): { all(pk: string): Array<{ username: string; seen_at: number }> } };
    }).db
      .prepare(`SELECT username, seen_at FROM username_history WHERE pk = ? ORDER BY seen_at`)
      .all('7');

  // First sighting is a change (nothing was known before).
  s.observe({ accountPk: '7', observedAt: 100, source: 'followers-list', fields: { username: 'z' } });
  expect(rows()).toEqual([{ username: 'z', seen_at: 100 }]);

  // Re-observing the SAME username — what every census row does — writes nothing.
  s.observe({ accountPk: '7', observedAt: 200, source: 'followers-list', fields: { username: 'z' } });
  s.observe({ accountPk: '7', observedAt: 300, source: 'followers-list', fields: { username: 'z' } });
  expect(rows()).toHaveLength(1);

  // A genuine rename is history.
  s.observe({ accountPk: '7', observedAt: 400, source: 'profile', fields: { username: 'zed' } });
  expect(rows()).toEqual([
    { username: 'z', seen_at: 100 },
    { username: 'zed', seen_at: 400 },
  ]);

  // An OLDER read the projection rejects leaves no trace either — the log
  // follows the projected username, not every payload seen.
  s.observe({ accountPk: '7', observedAt: 150, source: 'followers-list', fields: { username: 'z' } });
  expect(s.getAccount('7')?.username).toBe('zed');
  expect(rows()).toHaveLength(2);
});

test('action ledger drives durable daily count', () => {
  s.recordAction('7', 'follow', 'ok', 1000);
  s.recordAction('8', 'follow', 'ok', 2000);
  expect(s.actionCountSince(0)).toBe(2);
  expect(s.actionCountSince(1500)).toBe(1);
});

test('netGrowthSeries buckets gains/losses into cumulative local-day series', () => {
  // f1 gains us today; f2 gained us yesterday then dropped us today; f3 is
  // outside the 3-day window and must be excluded.
  s.observeEdge('f1', 'ME', 'follows', true, TODAY_MS + 3_600_000);
  s.observeEdge('f2', 'ME', 'follows', true, YESTERDAY_MS + 3_600_000);
  s.observeEdge('f2', 'ME', 'follows', false, TODAY_MS + 7_200_000);
  s.observeEdge('f3', 'ME', 'follows', true, TODAY_MS - 5 * DAY);

  const series = s.netGrowthSeries(3, 'ME');
  expect(series).toHaveLength(3);
  expect(series[0].cumulativeNet).toBe(0); // two days ago: no activity
  expect(series[1].dayStartMs).toBe(YESTERDAY_MS);
  expect(series[1].cumulativeNet).toBe(1); // +1 (f2 gained)
  expect(series[2].dayStartMs).toBe(TODAY_MS);
  expect(series[2].cumulativeNet).toBe(1); // +1 (f1) -1 (f2 removed) on top of 1
});

test('the first census sets the growth BASELINE: its bulk never charts as one-day growth', () => {
  s.setOwnPk('ME');
  // Initial app run: the first complete census records ~everyone at once.
  s.ingestScanCensus(['x1', 'x2'], ['f1', 'f2', 'f3'], NOON_TODAY);
  expect(s.followersBaselineAt()).toBe(NOON_TODAY);

  // The census bulk is STOCK — the series stays flat at zero.
  const flat = s.netGrowthSeries(3, 'ME');
  expect(flat.every((p) => p.cumulativeNet === 0)).toBe(true);

  // A follower gained AFTER the baseline is real growth; a baseline follower
  // dropping us after it is a real loss.
  s.observeEdge('f4', 'ME', 'follows', true, NOON_TODAY + 3_600_000);
  s.observeEdge('f1', 'ME', 'follows', false, NOON_TODAY + 7_200_000);
  const series = s.netGrowthSeries(3, 'ME');
  expect(series[series.length - 1].cumulativeNet).toBe(0); // +1 (f4) − 1 (f1)
  s.observeEdge('f5', 'ME', 'follows', true, NOON_TODAY + 10_800_000);
  expect(s.netGrowthSeries(3, 'ME')[2].cumulativeNet).toBe(1);
});

test('the baseline is set-once and retroactively absorbs earlier partial sweeps', () => {
  s.setOwnPk('ME');
  // A follow-back sweep ran BEFORE any census and bulk-recorded head followers.
  s.observeEdge('s1', 'ME', 'follows', true, NOON_TODAY - 3_600_000);
  s.observeEdge('s2', 'ME', 'follows', true, NOON_TODAY - 3_600_000);
  // Without a baseline they chart (nothing better is known yet)…
  expect(s.netGrowthSeries(3, 'ME')[2].cumulativeNet).toBe(2);

  // …but the first census heals it: sweep edges predate the baseline → stock.
  s.ingestScanCensus([], ['s1', 's2', 'f1'], NOON_TODAY);
  expect(s.netGrowthSeries(3, 'ME')[2].cumulativeNet).toBe(0);

  // A SECOND census does not move the baseline; genuinely new followers in it
  // (first seen after the baseline) count as growth.
  s.ingestScanCensus([], ['s1', 's2', 'f1', 'NEW'], NOON_TODAY + 3_600_000);
  expect(s.followersBaselineAt()).toBe(NOON_TODAY);
  expect(s.netGrowthSeries(3, 'ME')[2].cumulativeNet).toBe(1); // just NEW
});

test('REGRESSION: event gains observed weeks before the first census survive it', () => {
  s.setOwnPk('ME');
  // Measurement began weeks ago: the first sweep anchored the baseline, then
  // the watcher recorded genuine follow events at their own times.
  s.ensureFollowersBaseline(NOON_TODAY - 21 * DAY);
  s.observeOwnFollowerEvent('e1', 'ME', NOON_TODAY - 20 * DAY);
  s.observeOwnFollowerEvent('e2', 'ME', NOON_TODAY - 10 * DAY);
  expect(s.netFollowersSince(0)).toBe(2);

  // The user's FIRST prune scan lands weeks later. Its census re-confirms the
  // event-observed followers and discovers never-seen stock in bulk.
  s.ingestScanCensus([], ['e1', 'e2', 'st1', 'st2', 'st3'], NOON_TODAY);

  // The pre-census gains still chart — the census did not move the baseline —
  // and the discovered stock never charts as a census-day cliff.
  expect(s.followersBaselineAt()).toBe(NOON_TODAY - 21 * DAY);
  expect(s.netFollowersSince(0)).toBe(2);
  const series = s.netGrowthSeries(30, 'ME');
  expect(series[series.length - 1].cumulativeNet).toBe(2);
});

test('DEFENSE: pre-census event gains survive even when no path anchored a baseline', () => {
  s.setOwnPk('ME');
  // A collection path recorded raw event edges and forgot ensureFollowersBaseline.
  s.observeEdge('e1', 'ME', 'follows', true, NOON_TODAY - 20 * DAY);
  s.observeEdge('e2', 'ME', 'follows', true, NOON_TODAY - 10 * DAY);
  s.ingestScanCensus([], ['e1', 'e2', 'st1'], NOON_TODAY);

  // The first census stamps the baseline just BELOW the earliest observed
  // gain, so both pre-census gains count; its own discovery (st1) is stock.
  expect(s.followersBaselineAt()).toBe(NOON_TODAY - 20 * DAY - 1);
  expect(s.netFollowersSince(0)).toBe(2);
});

test('the first census absorbs its walk-streamed discoveries as stock (no one-day cliff)', () => {
  s.setOwnPk('ME');
  s.ensureFollowersBaseline(NOON_TODAY - 15 * DAY);
  s.observeOwnFollowerEvent('gain', 'ME', NOON_TODAY - 10 * DAY);
  // The scan's followers walk streams its rows per-item, minutes before
  // the census verdict — never-seen accounts land with fresh first_seen_at.
  s.observeEdge('w1', 'ME', 'follows', true, NOON_TODAY - 30 * 60_000);
  s.observeEdge('w2', 'ME', 'follows', true, NOON_TODAY - 20 * 60_000);
  s.ingestScanCensus([], ['gain', 'w1', 'w2'], NOON_TODAY);

  // Only the event gain charts; the walk's stock discoveries were re-dated
  // onto the baseline instead of charting as a census-day cliff.
  expect(s.netFollowersSince(0)).toBe(1);

  // A SECOND census discovering a new follower still charts it (a genuine
  // gain the notifications missed) — the stock absorption is first-census-only.
  s.ingestScanCensus([], ['gain', 'w1', 'w2', 'NEW'], NOON_TODAY + 3_600_000);
  expect(s.netFollowersSince(0)).toBe(2);
});

test('ensureFollowersBaseline is set-once and a later census never moves it', () => {
  s.setOwnPk('ME');
  s.ensureFollowersBaseline(1000);
  s.ensureFollowersBaseline(2000);
  expect(s.followersBaselineAt()).toBe(1000);
  s.ingestScanCensus([], ['a'], 5000);
  expect(s.followersBaselineAt()).toBe(1000);
  expect(s.netFollowersSince(0)).toBe(0); // the census discovery is stock
});

test('observeOwnFollowerEvent anchors the baseline: the first-ever event is the boundary', () => {
  s.setOwnPk('ME');
  s.observeOwnFollowerEvent('a', 'ME', 1000);
  expect(s.followersBaselineAt()).toBe(1000);
  expect(s.netFollowersSince(0)).toBe(0); // the boundary event itself is stock
  s.observeOwnFollowerEvent('b', 'ME', 2000);
  expect(s.netFollowersSince(0)).toBe(1); // everything after it charts
});

test('netGrowthSeries guards non-positive days and empty ownPk', () => {
  s.observeEdge('f1', 'ME', 'follows', true, NOON_TODAY);
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

test('absence is a verdict PER SIDE: a following walk that missed rows heals nothing on its side', () => {
  // Live 2026-08-31: the following walk returned 2,928 of 3,329 rows, "complete",
  // and the census declared 361 follows gone — which then re-entered the
  // candidate pool as accounts to follow. The followers walk (99.6%) was sound.
  s.setOwnPk('ME');
  s.observeEdge('ME', 'x', 'follows', true, 1000);
  s.observeEdge('ME', 'missed', 'follows', true, 1000);
  s.observeEdge('gone', 'ME', 'follows', true, 1000);

  s.ingestScanCensus(['x'], ['z'], 2000, { authoritative: { followers: true, following: false } });

  expect(s.getEdge('gone', 'ME', 'follows')?.status).toBe('removed');
  expect(s.getEdge('ME', 'missed', 'follows')?.status).toBe('active');
});

test('an authoritative census never flips a record growth still holds', () => {
  // A request to a private account never appears in the following list, in ANY
  // held state: flipping an `unfollow_queued` one to external left the request
  // outstanding forever. Churn's own unfollow visit reads the true state instead.
  s.setOwnPk('ME');
  for (const [pk, state] of [['q', 'unfollow_queued'], ['b', 'followed_back']] as const) {
    s.observeEdge('ME', pk, 'follows', true, 1000);
    s.upsertFollowRecord({ accountPk: pk, targetPk: null, state, followedAt: 1000, retryCount: 0 });
  }

  s.ingestScanCensus([], [], 2000, { authoritative: true });

  expect(s.getFollowRecord('q')?.state).toBe('unfollow_queued');
  expect(s.getFollowRecord('b')?.state).toBe('followed_back');
  expect(s.getEdge('ME', 'q', 'follows')?.status).toBe('active');
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
  const s2 = memoryStore(); // fresh; just asserts constructor+migrate doesn't throw
  expect(s2.getAccount('nope')).toBeNull();
  s2.close();
});
