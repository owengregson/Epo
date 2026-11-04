import { FollowbackWatcher } from '@/engine/followback-watcher';
import { FrontierSweep, type SweepPlanView } from '@/engine/frontier-sweep';
import { FakeClock } from '@/governors/clock';
import { sweepFacts } from '@/main/services/sweep-facts';
import type { FeedPassOptions, FeedReadResult } from '@/rim/feed-source';
import { advanceWatermark, type FeedWatermark } from '@/rim/feed-watermark';
import type { HeadWalkArgs, HeadWalkResult } from '@/rim/followers-head';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { setLevel } from '@/utils/logger';
import { rec } from '../kit/engine-harness';
import { openTestStore } from '../kit/store';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 3, 12);
let store: KnowledgeStore;
let clock: FakeClock;

beforeEach(() => {
  setLevel('error');
  store = openTestStore(':memory:');
  store.setOwnPk('ME');
  store.ensureFollowersBaseline(NOW - 30 * 24 * HOUR);
  clock = new FakeClock(NOW);
});
afterEach(() => store.close());

const view = (over: Partial<SweepPlanView> = {}): SweepPlanView => ({ checkSpacingMs: HOUR, clockToleranceMs: 300_000,
  light: false, catchUp: { profiles: 1, notifications: 1, pages: 5 }, checkPages: 5, followingPages: 2,
  acceptsAllowed: (n) => Math.min(n, 3), planDayKey: '2026-11-03', planDayStartsAt: NOW - 6 * HOUR, ...over });
const ok = (w: FeedWatermark | null, fresh = 0, over: Partial<Extract<FeedReadResult, { ok: true }>> = {}): FeedReadResult =>
  ({ ok: true, next: advanceWatermark(w, [], clock.now(), false, null), bodies: 1, filtered: false, fresh, accepted: 0,
    requesters: { count: 0, source: 'none', complete: false }, ...over });
const initialized = async (a: HeadWalkArgs): Promise<HeadWalkResult> => ({ outcome: a.frontierAt === null ? 'initialized' : 'reached-frontier',
  pages: 1, newRows: 0, next: { walkedAt: clock.now(), rowsPerPage: 12, contiguous: true, order: { verdict: 'unverified', pairs: 0, ordered: 0, at: 0 } } });

function sweepWith(o: { plan?: Partial<SweepPlanView>; feed?: (w: FeedWatermark | null, p: FeedPassOptions) => Promise<FeedReadResult>;
  launchAt?: number } = {}) {
  const watcher = new FollowbackWatcher({ store, clock, ownPk: 'ME', cfg: { holdAfterFollowbackMs: 2 * 24 * HOUR, autoAcceptRequests: true } });
  const calls = { visit: 0, head: [] as HeadWalkArgs[], following: 0, panels: [] as FeedPassOptions['panel'][] };
  const sweep = new FrontierSweep({ clock, ownPk: 'ME', launchAt: o.launchAt ?? NOW - HOUR, plan: { view: () => view(o.plan) },
    header: { land: async () => false, visit: async () => { calls.visit += 1; return 'ok'; } },
    feed: { fetchSince: async (w, p) => { calls.panels.push(p.panel); return (o.feed ?? (async (x) => ok(x)))(w, p); } },
    head: async (a) => { calls.head.push(a); return initialized(a); },
    following: async () => { calls.following += 1; return { ok: true, complete: true, count: 3, removed: 1, added: 2 }; },
    facts: sweepFacts(store, 'ME', watcher), autoAccept: () => true });
  return { sweep, calls };
}
const header = (at: number, followers: number, following: number) =>
  store.observe({ accountPk: 'ME', observedAt: at, source: 'profile', fields: { username: 'me', followers, following } });

test('a session sweep applies each fresh event as it arrives and persists every frontier; its end is the check anchor', async () => {
  store.upsertFollowRecord(rec({ accountPk: 'a', state: 'pending_followback', followedAt: NOW - 3 * 24 * HOUR }));
  const { sweep, calls } = sweepWith({ feed: async (w, p) => {
    p.onEvent({ pk: 'a', username: 'alice', atMs: NOW - HOUR });
    expect(store.getFollowRecord('a')?.state).toBe('followed_back');
    return ok(w, 1, { next: advanceWatermark(w, [{ pk: 'a', username: 'alice', atMs: NOW - HOUR }], clock.now(), true, null) });
  } });
  const res = await sweep.run('session', new AbortController().signal);
  expect(calls.visit).toBe(1);
  expect(calls.panels).toEqual([{ mode: 'accept', allowed: 3 }]);
  expect(calls.head[0]).toMatchObject({ frontierAt: null, use: 'check' });
  const s = store.reopen.get();
  expect(s?.feed).toMatchObject({ atMs: NOW - HOUR, filteredAt: NOW });
  expect(s?.head?.walkedAt).toBe(NOW);
  expect(s?.lastSweep).toMatchObject({ id: 1, mode: 'session', endedAt: NOW });
  expect(sweep.lastSweepEndedAt()).toBe(NOW);
  expect(res.summary).toMatchObject({ isReturn: false, newFollowers: 1 });
  expect(sweep.view()).toMatchObject({ state: 'done', mode: 'session' });
});

test('a launch consumes the landing\'s header, opens no panel and never reads the following list', async () => {
  store.reopen.set({ v: 1, feed: null, head: null, requests: null, lastSweep: { id: 4, mode: 'check', startedAt: NOW - 9 * HOUR,
    endedAt: NOW - 8 * HOUR }, lastCatchUp: null, following: null });
  header(NOW - 20 * HOUR, 100, 50);
  header(NOW - 1_000, 104, 57);
  const { sweep, calls } = sweepWith({ launchAt: NOW - 2_000 });
  const res = await sweep.run('launch', new AbortController().signal);
  expect(calls.visit).toBe(0);
  expect(calls.panels).toEqual([null]);
  expect(calls.following).toBe(0);
  expect(calls.head[0]).toMatchObject({ use: 'catch-up', maxPages: 2 });
  expect(res.summary).toMatchObject({ isReturn: true, from: NOW - 8 * HOUR, followers: { before: 100, after: 104 } });
  expect(store.reopen.get()?.lastCatchUp).toEqual(res.summary);
});

test('a failed drawer ends its step only: the watermark is kept, the read time stamped, and the sweep still ends', async () => {
  const feed: FeedWatermark = { atMs: NOW - 5 * HOUR, keysAtMs: ['x|1'], readAt: NOW - 2 * HOUR, filteredAt: null, gap: null };
  store.reopen.set({ v: 1, feed, head: null, requests: null, lastSweep: null, lastCatchUp: null, following: null });
  const { sweep } = sweepWith({ feed: async () => ({ ok: false, reason: 'no-response', opened: true }) });
  const res = await sweep.run('check', new AbortController().signal);
  expect(store.reopen.get()?.feed).toEqual({ ...feed, readAt: NOW });
  expect(res.steps.find((s) => s.id === 'notifications')?.step).toEqual({ state: 'failed', why: 'unreadable' });
  expect(store.reopen.get()?.lastSweep?.mode).toBe('check');
});

test('Boost defers the head walk and the following check; their frontiers keep', async () => {
  header(NOW - 20 * HOUR, 100, 50);
  header(NOW - 1_000, 104, 57);
  const { sweep, calls } = sweepWith({ plan: { light: true } });
  const res = await sweep.run('session', new AbortController().signal);
  expect(calls.head).toHaveLength(0);
  expect(calls.following).toBe(0);
  expect(res.steps.find((s) => s.id === 'followers-head')?.step).toEqual({ state: 'skipped', why: 'boost' });
});

test('a session reads the following list when its count moved outside Epo, once per plan-day', async () => {
  header(NOW - 20 * HOUR, 100, 50);
  header(NOW - 1_000, 104, 57);
  const { sweep, calls } = sweepWith();
  const res = await sweep.run('session', new AbortController().signal);
  expect(calls.following).toBe(1);
  expect(store.reopen.get()?.following).toEqual({ checkedAt: NOW, count: 3, complete: true });
  expect(res.summary?.following.outsideEpo).toBe(1);
  clock.advance(HOUR);
  await sweep.run('session', new AbortController().signal);
  expect(calls.following).toBe(1);
});

test('a complete panel ends the requests it no longer lists — the only absence verdict on requests', async () => {
  for (const pk of ['r1', 'r2']) store.observeEdge(pk, 'ME', 'requests', true, NOW - HOUR);
  const { sweep } = sweepWith({ feed: async (w, p) => {
    p.onRequester({ pk: 'r1', username: 'r1', observation: { accountPk: 'r1', observedAt: NOW, source: 'friend-requests', fields: { username: 'r1' } } });
    return ok(w, 0, { requesters: { count: 1, source: 'panel', complete: true } });
  } });
  await sweep.run('check', new AbortController().signal);
  expect(store.hasActiveRequest('r1')).toBe(true);
  expect(store.hasActiveRequest('r2')).toBe(false);
  expect(store.reopen.get()?.requests).toMatchObject({ count: 1, complete: true, verifiedDayKey: '2026-11-03' });
});

test('a stop keeps the finished frontiers and records no sweep end', async () => {
  const stop = new AbortController();
  const { sweep, calls } = sweepWith({ feed: async (w) => { stop.abort(); return ok(w); } });
  await sweep.run('session', stop.signal);
  expect(store.reopen.get()?.feed?.readAt).toBe(NOW);
  expect(store.reopen.get()?.lastSweep).toBeNull();
  expect(calls.head).toHaveLength(0);
});

const census = (at: number) => store.savePruneCensus({ at, following: 0, followers: 0, scrapedFollowing: 0, scrapedFollowers: 0,
  notFollowingBack: 0, candidates: 0 });

test('the upgrade launch walks one head page even when the legacy seed wrote a reopen state (spec §9.5)', async () => {
  census(NOW - 20 * 24 * HOUR);
  store.reopen.seedFromLegacy({ sweepLastRunAt: NOW - 5 * 24 * HOUR });
  const { sweep, calls } = sweepWith();
  const res = await sweep.run('launch', new AbortController().signal);
  expect(calls.head).toHaveLength(1);
  expect(calls.head[0]).toMatchObject({ frontierAt: null, use: 'catch-up' });
  // The away window starts where the v1 sweep last ran.
  expect(res.summary).toMatchObject({ from: NOW - 5 * 24 * HOUR, isReturn: true });
});

test('a later launch with a frontier the new model read falls back to the census when the head frontier is missing', async () => {
  census(NOW - 20 * 24 * HOUR);
  store.reopen.set({ v: 1, feed: { atMs: NOW - 2 * HOUR, keysAtMs: [], readAt: NOW - 2 * HOUR, filteredAt: null, gap: null },
    head: null, requests: null, lastSweep: null, lastCatchUp: null, following: null });
  const { sweep, calls } = sweepWith();
  await sweep.run('launch', new AbortController().signal);
  expect(calls.head[0]?.frontierAt).toBe(NOW - 20 * 24 * HOUR);
});

test('a launch lands when the splash produced no header, and visits only if the landing gave none', async () => {
  const landed: number[] = [];
  let visits = 0;
  const watcher = new FollowbackWatcher({ store, clock, ownPk: 'ME', cfg: { holdAfterFollowbackMs: 0, autoAcceptRequests: false } });
  const sweep = new FrontierSweep({ clock, ownPk: 'ME', launchAt: NOW - HOUR, plan: { view: () => view() },
    header: { land: async () => { landed.push(clock.now()); header(clock.now(), 10, 20); return true; },
      visit: async () => { visits += 1; return 'ok'; } },
    feed: { fetchSince: async (w) => ok(w) }, head: initialized, following: async () => ({ ok: false, reason: 'stopped' }),
    facts: sweepFacts(store, 'ME', watcher), autoAccept: () => false });
  await sweep.run('launch', new AbortController().signal);
  expect(landed).toEqual([NOW]);
  expect(visits).toBe(0);
});

test('a refused catch-up shows as skipped with its reason, pushes once and reads nothing', () => {
  const views: unknown[] = [];
  const watcher = new FollowbackWatcher({ store, clock, ownPk: 'ME', cfg: { holdAfterFollowbackMs: 0, autoAcceptRequests: false } });
  const sweep = new FrontierSweep({ clock, ownPk: 'ME', launchAt: NOW, plan: { view: () => view() },
    header: { land: async () => false, visit: async () => 'ok' }, feed: { fetchSince: async (w) => ok(w) }, head: initialized,
    following: async () => ({ ok: false, reason: 'stopped' }), facts: sweepFacts(store, 'ME', watcher), autoAccept: () => false,
    report: (v) => views.push(v) });
  sweep.skip('offline');
  expect(sweep.view()).toMatchObject({ state: 'skipped', mode: 'launch', skipped: 'offline', isReturn: true, since: null });
  expect(views).toHaveLength(1);
  expect(store.reopen.get()).toBeNull();
});
