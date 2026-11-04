import { Reader } from '@/adapter/reader';
import { captureFeed } from '@/rim/feed-capture';
import { FakeTab, mkResp } from '../kit/fakes';

test.each([200, 429])('drawer consumers share the observed memo, including status %s', async (status) => {
  const tab = new FakeTab();
  const reader = new Reader();
  const body = { data: { xdt_activity_inbox: { new_stories: [], old_stories: [] } }, extensions: { is_final: true } };
  const original = mkResp('https://www.instagram.com/api/graphql', body,
    { 'x-fb-friendly-name': 'PolarisActivityFeedStoriesViewQuery' });
  const getBody = jest.fn(original.getBody);
  const resp = { ...original, status, getBody };
  const capture = captureFeed({ tab, reader, now: () => 100 }, { onFeed: jest.fn(), onRequests: jest.fn() });
  const shared = reader.observed.read(resp, 100);
  tab.emit(resp);
  await shared;
  await Promise.all(capture.pendingReads);
  expect(getBody).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
  expect(capture.state.feedWalled).toBe(status === 429);
  expect(capture.state.feedBodies).toBe(status === 200 ? 1 : 0);
  capture.unsubscribe();
});
