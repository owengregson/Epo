import { Reader } from '@/adapter/reader';
import type { Sentinel } from '@/adapter/sentinel';
import type { FeedPassOptions, NotificationsActor } from '@/rim/feed-source';
import { AdapterBackedFollowNotifications } from '@/rim/follow-notifications';
import { FakeSentinel, FakeTab, mkResp } from '../kit/fakes';

const story = { story_type: 101, args: { profile_id: '42', profile_name: 'u42', text: 'u42 started following you.' } };
const feed = { data: { xdt_activity_inbox: { new_stories: [story], old_stories: [] } } };
const request = { pk: '55', id: '55', username: 'u55', friendship_status: { incoming_request: true } };
const response = (op: string, body: unknown) => {
  const base = mkResp('https://www.instagram.com/api/graphql', body, { 'x-fb-friendly-name': op });
  return { ...base, getBody: jest.fn(base.getBody) };
};

function harness(onOpen: (tab: FakeTab) => void, onEntry?: (tab: FakeTab) => void) {
  const tab = new FakeTab();
  let now = 1_700_000_000_000;
  const actor: NotificationsActor = {
    clickNotifications: async () => { onOpen(tab); return true; },
    clickNotificationsFollowsFilter: async () => false,
    scrollNotificationsList: async () => false,
    clickNotificationsClose: async () => true,
    clickFollowRequestsEntry: async () => { onEntry?.(tab); return onEntry !== undefined; },
    confirmNextFollowRequest: async () => ({ clicked: false, username: null, remaining: 0 }),
    probeFollowRequestHead: async () => ({ found: false, username: null, remaining: 0 }),
  };
  const source = new AdapterBackedFollowNotifications({ tab, actor, reader: new Reader(),
    sentinel: new FakeSentinel() as unknown as Sentinel, responseWaitMs: 1,
    now: () => now, sleep: async (ms) => { now += ms; } });
  const options: FeedPassOptions = { use: 'check', signal: new AbortController().signal,
    panel: onEntry === undefined ? null : { mode: 'verify' }, onEvent: jest.fn(), onUndated: jest.fn(), onRequester: jest.fn() };
  return { source, options };
}

test('a renamed feed operation is read only when the armed drawer reaches its unanswered deadline', async () => {
  const candidate = response('FutureActivityFeedQuery', { data: { inbox_v2: { new_stories: [story], old_stories: [] } } });
  const { source, options } = harness((tab) => {
    tab.emit(candidate);
    expect(candidate.getBody).not.toHaveBeenCalled();
  });
  const result = await source.fetchSince(null, options);
  expect(result).toMatchObject({ ok: true, bodies: 1 });
  expect(options.onUndated).toHaveBeenCalledWith(expect.objectContaining({ pk: '42' }));
  expect(candidate.getBody).toHaveBeenCalledTimes(1);
});

test('request recovery is armed by opening the panel and never claims a complete pending set', async () => {
  const canonical = response('PolarisActivityFeedStoriesViewQuery', feed);
  const beforePanel = response('FutureFollowRequestsQuery', { data: { rows: [request] } });
  const candidate = response('FutureFollowRequestsQuery', { data: { rows: [request] } });
  const { source, options } = harness((tab) => { tab.emit(beforePanel); tab.emit(canonical); },
    (tab) => { tab.emit(candidate); expect(candidate.getBody).not.toHaveBeenCalled(); });
  const result = await source.fetchSince(null, options);
  expect(result).toMatchObject({ ok: true, requesters: { source: 'panel', count: 1, complete: false } });
  expect(options.onRequester).toHaveBeenCalledWith(expect.objectContaining({ pk: '55' }));
  expect(beforePanel.getBody).not.toHaveBeenCalled();
  expect(candidate.getBody).toHaveBeenCalledTimes(1);
});

test('healthy canonical reads never pay for unknown drawer candidates', async () => {
  const canonical = response('PolarisActivityFeedStoriesViewQuery', feed);
  const candidate = response('FutureActivityFeedQuery', feed);
  const { source, options } = harness((tab) => { tab.emit(candidate); tab.emit(canonical); });
  expect(await source.fetchSince(null, options)).toMatchObject({ ok: true, bodies: 1 });
  expect(canonical.getBody).toHaveBeenCalledTimes(1);
  expect(candidate.getBody).not.toHaveBeenCalled();
});
