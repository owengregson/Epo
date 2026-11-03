import type { LocateConfirmRequestResult } from '@/adapter/ig-surface';
import { Reader } from '@/adapter/reader';
import type { Sentinel } from '@/adapter/sentinel';
import type { FollowEvent } from '@/adapter/surface-types';
import type { FeedWatermark } from '@/rim/feed-watermark';
import {
  AdapterBackedFollowNotifications, type FeedPanel, type FeedReadResult, type FeedRequester,
} from '@/rim/follow-notifications';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { setLevel } from '@/utils/logger';
import { FakeSentinel, FakeTab, mkResp } from '../kit/fakes';
import { openTestStore } from '../kit/store';

beforeAll(() => setLevel('error'));

const GRAPHQL_URL = 'https://www.instagram.com/api/graphql';
const GRAPHQL_QUERY_URL = 'https://www.instagram.com/graphql/query';
const FEED_OP = { 'x-fb-friendly-name': 'PolarisActivityFeedStoriesViewQuery' };
const PANEL_OP = { 'x-fb-friendly-name': 'PolarisActivityFeedFollowRequestsViewQuery' };
const reader = new Reader();

const followStory = (pk: string, atSec: number): unknown => ({
  story_type: 101,
  args: { profile_id: pk, profile_name: `u${pk}`, timestamp: atSec, text: `u${pk} started following you.` },
});
const likeStory = (pk: string): unknown => ({ story_type: 60, args: { profile_id: pk, text: 'liked', timestamp: 1_000 } });

/** The GraphQL feed body; `preview` fills the sibling requester list. */
const feed = (stories: unknown[], preview: Array<{ pk: string; username: string }> = []): unknown => ({
  data: {
    xdt_activity_inbox: { new_stories: [], old_stories: stories },
    ...(preview.length > 0 ? { xdt_api__v1__friendships__pending: {
      users: preview.map((r) => ({ pk: r.pk, username: r.username, is_private: false, is_verified: false })) } } : {}),
  },
  extensions: { is_final: true },
});
const panel = (rows: Array<{ pk: string; username: string }>, hasNext = false): unknown => ({
  data: { xdt_friendships_pending_users: { users: {
    edges: rows.map((r) => ({ node: { pk: r.pk, id: r.pk, username: r.username }, cursor: null })),
    page_info: { end_cursor: null, has_next_page: hasNext },
  } } },
});

/** A scripted drawer: the bell, a chip that may need a few tries, a scrollable list, the requests panel. */
class FakeDrawer {
  clicks = 0;
  onOpen?: () => void;
  chipReadyAfter = 1;
  filterClicks = 0;
  onFilter?: () => void;
  closeClicks = 0;
  scrolls = 0;
  onScroll?: () => boolean;
  entryExists = false;
  entryClicks = 0;
  onEntry?: () => void;
  requestQueue: string[] = [];
  confirmClicks = 0;
  async clickNotifications(): Promise<boolean> {
    this.clicks += 1;
    if (this.clicks === 1) this.onOpen?.();
    return true;
  }
  async clickNotificationsFollowsFilter(): Promise<boolean> {
    this.filterClicks += 1;
    if (this.filterClicks < this.chipReadyAfter) return false;
    this.onFilter?.();
    return true;
  }
  async clickNotificationsClose(): Promise<boolean> {
    this.closeClicks += 1;
    return true;
  }
  async scrollNotificationsList(): Promise<boolean> {
    this.scrolls += 1;
    return this.onScroll?.() ?? false;
  }
  async clickFollowRequestsEntry(): Promise<boolean> {
    if (!this.entryExists) return false;
    this.entryClicks += 1;
    this.onEntry?.();
    return true;
  }
  async confirmNextFollowRequest(onDispatch?: (u: string | null) => void | Promise<void>): Promise<{ clicked: boolean; username: string | null; remaining: number }> {
    const head = this.requestQueue[0];
    if (head === undefined) return { clicked: false, username: null, remaining: 0 };
    await onDispatch?.(head);
    this.confirmClicks += 1;
    const remaining = this.requestQueue.length;
    this.requestQueue.shift();
    return { clicked: true, username: head, remaining };
  }
  async probeFollowRequestHead(): Promise<LocateConfirmRequestResult> {
    const head = this.requestQueue[0];
    return head === undefined ? { found: false, username: null, remaining: 0 }
      : { found: true, username: head, remaining: this.requestQueue.length };
  }
}

const build = (o: { sentinel?: FakeSentinel; store?: KnowledgeStore; waitMs?: number } = {}) => {
  const tab = new FakeTab();
  const drawer = new FakeDrawer();
  const source = new AdapterBackedFollowNotifications({
    tab, actor: drawer, reader, sentinel: (o.sentinel ?? new FakeSentinel()) as unknown as Sentinel, store: o.store,
    ownPk: o.store ? 'ME' : undefined, responseWaitMs: o.waitMs ?? 300, acceptVerifyMs: 100, sleep: async () => {},
  });
  return { tab, drawer, source };
};

interface Heard { events: FollowEvent[]; undated: FollowEvent[]; requesters: FeedRequester[]; accepted: string[] }
const pass = async (source: AdapterBackedFollowNotifications, w: FeedWatermark | null, p: FeedPanel = null,
  onEvent?: (e: FollowEvent) => void): Promise<{ res: FeedReadResult; heard: Heard }> => {
  const heard: Heard = { events: [], undated: [], requesters: [], accepted: [] };
  const res = await source.fetchSince(w, { use: 'check', signal: new AbortController().signal, panel: p,
    onEvent: (e) => { heard.events.push(e); onEvent?.(e); }, onUndated: (e) => heard.undated.push(e),
    onRequester: (r) => heard.requesters.push(r), onAccepted: (a) => heard.accepted.push(a.username) });
  return { res, heard };
};
const mark = (atMs: number): FeedWatermark => ({ atMs, keysAtMs: [], readAt: 1, filteredAt: null, gap: null });

test('a first pass reads one body, hands every dated event over, and sets the watermark to the newest', async () => {
  const { tab, drawer, source } = build();
  drawer.onOpen = () => tab.emit(mkResp(GRAPHQL_URL, feed([followStory('111', 2_000), followStory('222', 1_500), likeStory('9')]), FEED_OP));
  const { res, heard } = await pass(source, null);
  expect(heard.events.map((e) => e.pk)).toEqual(['111', '222']);
  expect(res).toMatchObject({ ok: true, bodies: 1, fresh: 2, requesters: { source: 'none', count: 0 } });
  if (res.ok) expect(res.next).toMatchObject({ atMs: 2_000_000, keysAtMs: ['111|2000000'], gap: null });
  expect(drawer.scrolls).toBe(0);
  expect(drawer.closeClicks).toBe(1);
});

test('per-body streaming: an event is written before the pass resolves', async () => {
  const store = openTestStore(':memory:');
  const { tab, drawer, source } = build();
  drawer.onOpen = () => tab.emit(mkResp(GRAPHQL_URL, feed([followStory('111', 2_000)]), FEED_OP));
  let atClose: boolean | null = null;
  const close = drawer.clickNotificationsClose.bind(drawer);
  drawer.clickNotificationsClose = async () => {
    atClose = store.getAccount('111') !== null;
    return close();
  };
  await pass(source, null, null, (e) => store.observe({ accountPk: e.pk, observedAt: 1, source: 'activity-feed',
    fields: { username: e.username ?? 'x' } }));
  expect(atClose).toBe(true);
  store.close();
});

test('events at or below the watermark write nothing; the reached watermark is never scrolled past', async () => {
  const { tab, drawer, source } = build();
  drawer.onOpen = () => tab.emit(mkResp(GRAPHQL_URL, feed([followStory('111', 3_000), followStory('222', 1_000)]), FEED_OP));
  drawer.onScroll = () => true;
  const { res, heard } = await pass(source, mark(2_000_000));
  expect(heard.events.map((e) => e.pk)).toEqual(['111']);
  expect(drawer.scrolls).toBe(0);
  if (res.ok) expect(res.next.gap).toBeNull();
});

test('an unreached watermark scrolls at most the runaway rounds, stops when a round adds nothing, and records the gap', async () => {
  const { tab, drawer, source } = build();
  drawer.onOpen = () => tab.emit(mkResp(GRAPHQL_URL, feed([followStory('111', 9_000)]), FEED_OP));
  drawer.onScroll = () => {
    if (drawer.scrolls === 1) tab.emit(mkResp(GRAPHQL_URL, feed([followStory('222', 8_000)]), FEED_OP));
    return true;
  };
  const { res, heard } = await pass(source, mark(1_000_000));
  expect(heard.events.map((e) => e.pk)).toEqual(['111', '222']);
  expect(drawer.scrolls).toBe(2); // the second round added nothing
  if (res.ok) expect(res.next.gap).toEqual({ fromAtMs: 1_000_000, toAtMs: 8_000_000 });
});

test('the Follows chip is pressed once ready, and the body after the press counts as filtered', async () => {
  const { tab, drawer, source } = build();
  drawer.chipReadyAfter = 3;
  drawer.onOpen = () => tab.emit(mkResp(GRAPHQL_URL, feed([likeStory('1')]), FEED_OP));
  drawer.onFilter = () => tab.emit(mkResp(GRAPHQL_URL, feed([followStory('5', 4_000)]), FEED_OP));
  const { res, heard } = await pass(source, null);
  expect(drawer.filterClicks).toBe(3);
  expect(heard.events.map((e) => e.pk)).toEqual(['5']);
  expect(res).toMatchObject({ ok: true, filtered: true, bodies: 2 });
});

test('no body after the press reads the full feed and records filtered: false', async () => {
  const { tab, drawer, source } = build({ waitMs: 60 });
  drawer.onOpen = () => tab.emit(mkResp(GRAPHQL_URL, feed([followStory('5', 4_000)]), FEED_OP));
  const { res } = await pass(source, null);
  expect(res).toMatchObject({ ok: true, filtered: false });
  if (res.ok) expect(res.next.filteredAt).toBeNull();
});

test('sibling requesters reach the caller row by row; the panel stays closed without an errand', async () => {
  const { tab, drawer, source } = build();
  drawer.entryExists = true;
  drawer.onOpen = () => tab.emit(mkResp(GRAPHQL_URL, feed([], [{ pk: '901', username: 'req_a' }]), FEED_OP));
  const { res, heard } = await pass(source, null);
  expect(heard.requesters.map((r) => r.pk)).toEqual(['901']);
  expect(res).toMatchObject({ ok: true, requesters: { source: 'sibling', count: 1, complete: false } });
  expect(drawer.entryClicks).toBe(0);
});

test('a verification read opens the panel, reads every row, accepts nothing, and reports completeness', async () => {
  const { tab, drawer, source } = build();
  drawer.entryExists = true;
  drawer.requestQueue = ['req_a'];
  drawer.onOpen = () => tab.emit(mkResp(GRAPHQL_URL, feed([]), FEED_OP));
  drawer.onEntry = () => tab.emit(mkResp(GRAPHQL_QUERY_URL, panel([{ pk: '901', username: 'req_a' }]), PANEL_OP));
  const { res, heard } = await pass(source, null, { mode: 'verify' });
  expect(heard.requesters.map((r) => r.pk)).toEqual(['901']);
  expect(drawer.confirmClicks).toBe(0);
  expect(res).toMatchObject({ ok: true, accepted: 0, requesters: { source: 'panel', count: 1, complete: true } });
});

test('a panel with a next page is never complete', async () => {
  const { tab, drawer, source } = build();
  drawer.entryExists = true;
  drawer.onOpen = () => tab.emit(mkResp(GRAPHQL_URL, feed([]), FEED_OP));
  drawer.onEntry = () => tab.emit(mkResp(GRAPHQL_QUERY_URL, panel([{ pk: '901', username: 'req_a' }], true), PANEL_OP));
  const { res } = await pass(source, null, { mode: 'verify' });
  expect(res).toMatchObject({ ok: true, requesters: { source: 'panel', complete: false } });
});

test('an accept pass accepts up to its allowance, journals each, and closes the requester edge exactly at the accept', async () => {
  const store = openTestStore(':memory:');
  store.setOwnPk('ME');
  store.ensureFollowersBaseline(1);
  const { tab, drawer, source } = build({ store });
  drawer.entryExists = true;
  drawer.requestQueue = ['req_a', 'req_b', 'req_c'];
  drawer.onOpen = () => tab.emit(mkResp(GRAPHQL_URL, feed([]), FEED_OP));
  drawer.onEntry = () => tab.emit(mkResp(GRAPHQL_QUERY_URL, panel([
    { pk: '901', username: 'req_a' }, { pk: '902', username: 'req_b' }, { pk: '903', username: 'req_c' }]), PANEL_OP));
  const { res, heard } = await pass(source, null, { mode: 'accept', allowed: 2 }, undefined);
  for (const r of heard.requesters) store.observeEdge(r.pk, 'ME', 'requests', true, 2);
  expect(heard.accepted).toEqual(['req_a', 'req_b']);
  expect(res).toMatchObject({ ok: true, accepted: 2 });
  expect(store.getEdge('901', 'ME', 'follows')?.status).toBe('active');
  const gain = store.growth.latestGain('901');
  expect(gain?.source).toBe('accept');
  expect(gain?.lo).toBe(gain?.hi);
  store.observeEdge('902', 'ME', 'follows', true, Date.now());
  expect(store.hasActiveRequest('902')).toBe(false);
  expect(store.hasActiveRequest('903')).toBe(true);
  store.close();
});

test('an accept errand with no allowance never opens the panel', async () => {
  const { tab, drawer, source } = build();
  drawer.entryExists = true;
  drawer.onOpen = () => tab.emit(mkResp(GRAPHQL_URL, feed([]), FEED_OP));
  await pass(source, null, { mode: 'accept', allowed: 0 });
  expect(drawer.entryClicks).toBe(0);
});

describe('typed failures end the pass only', () => {
  test('a refused read budget is typed and opens nothing', async () => {
    const tab = new FakeTab();
    const drawer = new FakeDrawer();
    const source = new AdapterBackedFollowNotifications({ tab, actor: drawer, reader,
      sentinel: new FakeSentinel() as unknown as Sentinel, sleep: async () => {},
      readBudget: { consume: () => ({ allowed: false, resumeAt: 77 }) } as never });
    expect((await pass(source, null)).res).toEqual({ ok: false, reason: 'read-budget', retryAt: 77, opened: false });
    expect(drawer.clicks).toBe(0);
  });

  test('a blocked sentinel and an unlocatable bell are typed, before the drawer opens', async () => {
    const blocked = build({ sentinel: new FakeSentinel(['challenge']) });
    expect((await pass(blocked.source, null)).res).toEqual({ ok: false, reason: 'sentinel:challenge', opened: false });
    const { drawer, source } = build();
    drawer.clickNotifications = async () => false;
    expect((await pass(source, null)).res).toMatchObject({ ok: false, reason: 'control-not-located', opened: false });
  });

  test('no response, a drifted body and a walled body are typed after the open', async () => {
    const silent = build({ waitMs: 40 });
    expect((await pass(silent.source, null)).res).toEqual({ ok: false, reason: 'no-response', opened: true });
    const drift = build();
    drift.drawer.onOpen = () => drift.tab.emit(mkResp(GRAPHQL_URL, { status: 'fail' }, FEED_OP));
    expect((await pass(drift.source, null)).res).toMatchObject({ ok: false, reason: 'feed-shape-drift', opened: true });
    const walled = build();
    walled.drawer.onOpen = () => walled.tab.emit({ ...mkResp(GRAPHQL_URL, '<html>wait</html>', FEED_OP),
      status: 429, mimeType: 'text/html' });
    expect((await pass(walled.source, null)).res).toMatchObject({ ok: false, reason: 'walled', opened: true });
  });

  test('a drifted body beside a well-formed one still reads the good one', async () => {
    const { tab, drawer, source } = build();
    drawer.onOpen = () => {
      tab.emit(mkResp(GRAPHQL_URL, { status: 'fail' }, FEED_OP));
      tab.emit(mkResp(GRAPHQL_URL, feed([followStory('111', 2_000)]), FEED_OP));
    };
    expect((await pass(source, null)).res).toMatchObject({ ok: true, fresh: 1 });
  });
});

test('the watcher read (until the frontier sweep): one pass collected, requester rows stored', async () => {
  const store = openTestStore(':memory:');
  const { tab, drawer, source } = build({ store });
  drawer.entryExists = true;
  drawer.requestQueue = ['req_a'];
  drawer.onOpen = () => tab.emit(mkResp(GRAPHQL_URL, feed([followStory('111', 2_000)]), FEED_OP));
  drawer.onEntry = () => tab.emit(mkResp(GRAPHQL_QUERY_URL, panel([{ pk: '901', username: 'req_a' }]), PANEL_OP));
  const res = await source.fetchRecent({ acceptRequests: true });
  expect(res).toMatchObject({ ok: true, events: [{ pk: '111', username: 'u111', atMs: 2_000_000 }],
    accepted: [{ pk: '901', username: 'req_a' }], pendingRequestPks: [] });
  expect(store.getAccount('901')?.username).toBe('req_a');
  store.close();
});
