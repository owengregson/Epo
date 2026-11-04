/**
 * Reopen I1–I12 (spec §20.3, T5's list) and the following check, over the real store, the real frontier sweep and
 * appliers, the real head walk and following check over scripted list pages, a scripted drawer that classifies by
 * the real watermark, and a fake clock. Each case counts the reads: only the delta is read, nothing is fabricated.
 * I10 (conversion parity) is law L7 over a real store in tests/store/conversion-parity.test.ts.
 */
import type { FollowEvent } from '@/adapter/surface-types';
import { FollowbackWatcher } from '@/engine/followback-watcher';
import { FrontierSweep, type SweepPlanView } from '@/engine/frontier-sweep';
import { FakeClock } from '@/governors/clock';
import { calendarPlanDayClock } from '@/governors/plan-day-clock';
import { ownCounts } from '@/main/services/reopen-status';
import { seedReopenState } from '@/main/services/reopen-wiring';
import { sweepFacts } from '@/main/services/sweep-facts';
import type { FeedFailure, FeedPassOptions, FeedReadResult } from '@/rim/feed-source';
import { advanceWatermark, classifyBody, type FeedWatermark, gapOf, reached } from '@/rim/feed-watermark';
import { storeHeadFacts, walkFollowersHead } from '@/rim/followers-head';
import { checkFollowing, storeFollowingFacts } from '@/rim/following-check';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { setLevel } from '@/utils/logger';
import { FakeSentinel } from '../kit/fakes';
import { scriptedListWalker } from '../kit/harness-reopen';
import { openTestStore } from '../kit/store';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 9, 20, 12);
const TOLERANCE = 5 * MIN;

interface Script {
  events: FollowEvent[]; fail?: FeedFailure; requesters?: string[]; head: string[][]; following: string[][];
  /** Runs once the drawer pass returned (a crash right after the step). */
  after?: () => void;
}

function rig(o: { at: number; plan?: Partial<SweepPlanView> }) {
  setLevel('error');
  const store: KnowledgeStore = openTestStore(':memory:');
  store.setOwnPk('ME');
  const clock = new FakeClock(o.at);
  const script: Script = { events: [], head: [], following: [] };
  const reads = { drawer: 0, headPages: 0, followingReads: 0, visits: 0, panels: [] as FeedPassOptions['panel'][] };
  const view = (): SweepPlanView => ({ checkSpacingMs: HOUR, clockToleranceMs: TOLERANCE, light: false,
    catchUp: { profiles: 1, notifications: 1, pages: 5 }, checkPages: 5, followingPages: 2, acceptsAllowed: (n) => Math.min(n, 3),
    planDayKey: new Date(clock.now()).toISOString().slice(0, 10), planDayStartsAt: clock.now() - 6 * HOUR, ...o.plan });
  const feed = async (w: FeedWatermark | null, p: FeedPassOptions): Promise<FeedReadResult> => {
    reads.drawer += 1;
    reads.panels.push(p.panel);
    if (script.fail !== undefined) return { ok: false, reason: script.fail, opened: true };
    const body = classifyBody(script.events, w, clock.now(), TOLERANCE);
    for (const e of body.fresh) p.onEvent(e);
    for (const pk of script.requesters ?? []) p.onRequester({ pk, username: `u${pk}`,
      observation: { accountPk: pk, observedAt: clock.now(), source: 'friend-requests', fields: { username: `u${pk}` } } });
    const gap = reached(w, body.oldestAtMs) ? null : gapOf(w, body.oldestAtMs);
    queueMicrotask(() => script.after?.());
    return { ok: true, next: advanceWatermark(w, body.fresh, clock.now(), true, gap), bodies: 1, filtered: true,
      fresh: body.fresh.length, accepted: 0,
      requesters: { count: script.requesters?.length ?? 0, source: script.requesters ? 'sibling' : 'none', complete: false } };
  };
  const head = scriptedListWalker(() => script.head, () => clock.now());
  const following = scriptedListWalker(() => script.following, () => clock.now());
  const watcher = new FollowbackWatcher({ store, clock, ownPk: 'ME', cfg: { holdAfterFollowbackMs: 2 * DAY, autoAcceptRequests: true } });
  const sentinel = new FakeSentinel() as never;
  const facts = sweepFacts(store, 'ME', watcher);
  const sweep = (light = false) => new FrontierSweep({ clock, ownPk: 'ME', launchAt: clock.now(),
    plan: { view: () => ({ ...view(), light }) },
    header: { land: async () => false, visit: async () => { reads.visits += 1; return 'failed'; } },
    feed: { fetchSince: feed },
    head: async (a) => { const r = await walkFollowersHead({ walker: head, facts: storeHeadFacts(store, 'ME'), clock, sentinel }, a);
      reads.headPages += r.pages; return r; },
    following: async (a) => { reads.followingReads += 1;
      return checkFollowing({ walker: following, facts: storeFollowingFacts(store, 'ME', calendarPlanDayClock()), clock, sentinel }, a); },
    facts, autoAccept: () => true });
  const header = (followers: number, followingCount: number, at = clock.now()) =>
    store.observe({ accountPk: 'ME', observedAt: at, source: 'profile', fields: { username: 'me', followers, following: followingCount } });
  return { store, clock, script, reads, sweep, header, facts, head };
}

const follower = (store: KnowledgeStore, pk: string, at: number) => store.observeEdge(pk, 'ME', 'follows', true, at);
const event = (pk: string, atMs: number): FollowEvent => ({ pk, username: `u${pk}`, atMs });

/** A store that ran one sweep at `at`: three known followers, a head frontier, a watermark. */
async function settled(r: ReturnType<typeof rig>) {
  r.store.ensureFollowersBaseline(r.clock.now() - 30 * DAY);
  for (const pk of ['o1', 'o2', 'o3']) follower(r.store, pk, r.clock.now() - 20 * DAY);
  r.header(100, 80);
  r.script.events = [event('o1', r.clock.now() - 20 * DAY)];
  r.script.head = [['o1', 'o2', 'o3']];
  await r.sweep().run('launch', new AbortController().signal);
  Object.assign(r.reads, { drawer: 0, headPages: 0, followingReads: 0, visits: 0, panels: [] });
}

describe('reopen I1–I12 (spec §20.3)', () => {
  test('I1 overnight reopen: one drawer pass dates the new followers; the head stops at the frontier', async () => {
    const r = rig({ at: T0 });
    await settled(r);
    r.store.upsertFollowRecord({ accountPk: 'n1', targetPk: null, state: 'pending_followback', followedAt: T0 - DAY, retryCount: 0 });
    r.clock.advance(10 * HOUR);
    r.header(103, 80);
    r.script.events = [event('n1', T0 + 2 * HOUR), event('n2', T0 + 3 * HOUR), event('o1', T0 - 20 * DAY)];
    r.script.head = [['n3', 'n2', 'n1', 'o1', 'o2'], ['o3']];
    const res = await r.sweep().run('launch', new AbortController().signal);
    expect(r.reads).toMatchObject({ drawer: 1, headPages: 1, followingReads: 0, visits: 0 });
    expect(r.store.getFollowRecord('n1')).toMatchObject({ state: 'followed_back', followedBackAt: T0 + 2 * HOUR });
    expect(res.summary).toMatchObject({ isReturn: true, newFollowers: 3, followBacks: 1, lostIdentified: 0 });
  });

  test('I2 a week away: an unreached watermark leaves a gap the head walk closes within the catch-up pages', async () => {
    const r = rig({ at: T0 });
    await settled(r);
    r.clock.advance(7 * DAY);
    r.header(140, 80);
    r.script.events = [event('n9', r.clock.now() - HOUR)];
    r.script.head = Array.from({ length: 9 }, (_, i) => [`h${i}a`, `h${i}b`]);
    const res = await r.sweep().run('launch', new AbortController().signal);
    expect(r.reads.headPages).toBeLessThanOrEqual(5);
    expect(res.summary?.gaps).toEqual({ feed: true, head: true });
    // Only the delta: nobody was declared lost without a census.
    expect(res.summary?.lostIdentified).toBe(0);
  });

  test('I3 a DST fall-back and a timezone change cost zero reads: frontiers are server times and spacing', async () => {
    const r = rig({ at: Date.UTC(2026, 10, 1, 8, 30) });
    await settled(r);
    r.clock.advance(30 * MIN); // across the America/Los_Angeles fall-back hour
    await r.sweep().run('check', new AbortController().signal);
    expect(r.reads).toMatchObject({ drawer: 0, headPages: 0, visits: 0 });
  });

  test('I4 drawer drift ends the drawer step only: the watermark stays, the read time is stamped, no retry loop', async () => {
    const r = rig({ at: T0 });
    await settled(r);
    const before = r.store.reopen.get()?.feed;
    r.clock.advance(2 * HOUR);
    r.script.fail = 'feed-shape-drift';
    const res = await r.sweep().run('check', new AbortController().signal);
    expect(res.steps.find((s) => s.id === 'notifications')?.step).toEqual({ state: 'failed', why: 'drift' });
    expect(r.store.reopen.get()?.feed).toMatchObject({ atMs: before?.atMs, readAt: r.clock.now() });
    await r.sweep().run('check', new AbortController().signal);
    expect(r.reads.drawer).toBe(1);
  });

  test('I5 a deleted account at the queue head costs the sweep nothing: no pre-read of any managed record', async () => {
    const r = rig({ at: T0 });
    await settled(r);
    r.store.upsertFollowRecord({ accountPk: 'gone', targetPk: null, state: 'unfollow_queued', followedAt: T0 - 9 * DAY, retryCount: 0 });
    r.clock.advance(2 * HOUR);
    await r.sweep().run('session', new AbortController().signal);
    expect(r.reads.visits).toBe(1); // the stale own header only
    expect(r.store.getFollowRecord('gone')?.state).toBe('unfollow_queued');
  });

  test('I6 a private account with 5 requesters: each is an open request edge; a session pass opens the accept panel', async () => {
    const r = rig({ at: T0 });
    await settled(r);
    r.clock.advance(2 * HOUR);
    r.script.requesters = ['q1', 'q2', 'q3', 'q4', 'q5'];
    const res = await r.sweep().run('session', new AbortController().signal);
    for (const pk of r.script.requesters) expect(r.store.hasActiveRequest(pk)).toBe(true);
    expect(r.reads.panels).toEqual([{ mode: 'accept', allowed: 3 }]);
    expect(res.summary?.requestsWaiting).toEqual({ count: 5, atLeast: true });
  });

  test('I7 + the following check: a manual unfollow and an outside follow after a week away are identified exactly', async () => {
    const r = rig({ at: T0 });
    await settled(r);
    for (const pk of ['m1', 'm2']) {
      r.store.observeEdge('ME', pk, 'follows', true, T0 - 9 * DAY);
      r.store.upsertFollowRecord({ accountPk: pk, targetPk: null, state: 'pending_followback', followedAt: T0 - 9 * DAY, retryCount: 0 });
    }
    r.store.growth.completeOutsideFollowing(new Set(['m1', 'm2']), calendarPlanDayClock().window(T0).startsAt, T0);
    r.clock.advance(7 * DAY);
    r.header(100, 81); // outside Epo: m2 unfollowed, x1 and x2 followed
    const unverified = () => ownCounts({ store: r.store, sweep: { view: () => ({}) as never },
      dayClock: calendarPlanDayClock({ now: () => r.clock.now() }), followingResidual: r.facts.followingResidual })?.followingUnverified;
    expect(unverified()).toBe(1);
    r.script.following = [['m1', 'x1', 'x2']];
    const res = await r.sweep().run('session', new AbortController().signal);
    expect(r.reads.followingReads).toBe(1);
    expect(r.store.getFollowRecord('m2')?.state).toBe('external');
    expect(r.store.getFollowRecord('m1')?.state).toBe('pending_followback');
    expect(r.store.getEdge('ME', 'x1', 'follows')?.status).toBe('active');
    expect(res.summary?.following.outsideEpo).toBe(1); // two followed, one unfollowed
    expect(r.store.reopen.get()?.following).toMatchObject({ count: 3, complete: true });
    expect(unverified()).toBe(0); // the People lanes drop the marker
    // Never at launch, never under Boost, at most once per plan-day.
    await r.sweep().run('session', new AbortController().signal);
    await r.sweep(true).run('session', new AbortController().signal);
    await r.sweep().run('launch', new AbortController().signal);
    expect(r.reads.followingReads).toBe(1);
  });

  test('I8 a crash after the drawer step: the next launch reads only past the persisted watermark', async () => {
    const r = rig({ at: T0 });
    await settled(r);
    const ended = r.store.reopen.get()?.lastSweep?.endedAt;
    r.clock.advance(3 * HOUR);
    r.script.events = [event('n1', T0 + HOUR)];
    const crash = new AbortController();
    r.script.after = () => crash.abort();
    await r.sweep().run('launch', crash.signal);
    // The drawer's facts and frontier committed; the sweep recorded no end.
    expect(r.store.reopen.get()).toMatchObject({ feed: { atMs: T0 + HOUR }, lastSweep: { endedAt: ended } });
    r.script.after = undefined;
    r.clock.advance(2 * HOUR);
    r.script.events = [event('n1', T0 + HOUR), event('n2', T0 + 2 * HOUR)];
    const res = await r.sweep().run('launch', new AbortController().signal);
    expect(res.steps.find((s) => s.id === 'notifications')?.step).toEqual({ state: 'done', found: 1 }); // only n2
  });

  test('I9 a 4 500-follower header: the head walk stays within the frontier pages whatever the gains', async () => {
    const r = rig({ at: T0 });
    await settled(r);
    r.clock.advance(DAY);
    r.header(4_500, 80);
    r.script.head = Array.from({ length: 50 }, (_, i) => [`g${i}a`, `g${i}b`, `g${i}c`]);
    await r.sweep().run('launch', new AbortController().signal);
    expect(r.reads.headPages).toBeLessThanOrEqual(5);
  });

  test('I11 Boost active: the header and the drawer run, the head walk and the following check are deferred', async () => {
    const r = rig({ at: T0 });
    await settled(r);
    r.clock.advance(2 * HOUR);
    const res = await r.sweep(true).run('session', new AbortController().signal);
    expect(res.steps.find((s) => s.id === 'followers-head')?.step).toEqual({ state: 'skipped', why: 'boost' });
    expect(r.reads).toMatchObject({ drawer: 1, headPages: 0, followingReads: 0 });
  });

  test('I12 the upgrade of the live store: the legacy seed carries the last sweep, and exactly one head page is read', async () => {
    const r = rig({ at: T0 });
    r.store.ensureFollowersBaseline(T0 - 90 * DAY);
    r.store.savePruneCensus({ at: T0 - 30 * DAY, following: 0, followers: 0, scrapedFollowing: 0, scrapedFollowers: 0, notFollowingBack: 0, candidates: 0 });
    r.store.setLifecycleState(JSON.stringify({ v: 1, phase: 'ready', lastActiveAt: T0 - 2 * DAY }));
    const consume = jest.fn(() => true);
    seedReopenState(r.store, 'ME', { take: () => ({ forPk: 'ME', sweepLastRunAt: T0 - 3 * DAY }), consume });
    r.script.head = Array.from({ length: 30 }, (_, i) => [`f${i}`]);
    const res = await r.sweep().run('launch', new AbortController().signal);
    expect(r.reads.headPages).toBe(1);
    expect(consume).toHaveBeenCalledTimes(1);
    expect(res.summary?.from).toBe(T0 - 2 * DAY);
    expect(r.store.reopen.get()?.head).not.toBeNull();
  });
});
