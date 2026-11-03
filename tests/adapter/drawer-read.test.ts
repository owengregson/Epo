/**
 * The drawer-read seam (F2a step 7): one pure read per notifications-drawer
 * body, delegating to today's extractors — lenient, canonical, never partial.
 * The parse stream makes it strict in place.
 */
import { readDrawerBody } from '@/adapter/drawer-read';
import { Reader } from '@/adapter/reader';
import type { FollowEvent, FollowersListResult } from '@/adapter/surface-types';
import { setLevel } from '@/utils/logger';

beforeAll(() => setLevel('error'));

const row = (pk: string) => ({ accountPk: pk, observedAt: 7, source: 'friend-requests' as const, fields: { username: `u${pk}` } });

/** A reader stub that records what each extractor was handed. */
const stub = (events: FollowEvent[] | null, list: FollowersListResult) => {
  const calls: unknown[][] = [];
  return {
    calls,
    reader: {
      parseActivityFeedStrict: (body: unknown) => { calls.push(['feed', body]); return events; },
      parsePendingRequests: (body: unknown, at: number) => { calls.push(['requests', body, at]); return list; },
    },
  };
};

test('a feed body yields its events through today\'s strict feed parse', () => {
  const events: FollowEvent[] = [{ pk: '1', username: 'u1', atMs: 5 }];
  const s = stub(events, { observations: [], cursor: null, hasMore: false });
  const read = readDrawerBody({ kind: 'activity-feed', body: { b: 1 } }, { reader: s.reader, now: 99 });
  expect(read).toEqual({ events, pendingPreview: [], requests: { rows: [], pendingComplete: false },
    tier: 'canonical', partial: false });
  expect(s.calls).toEqual([['feed', { b: 1 }]]);
});

test('a drifted feed body reads as a shape mismatch, never as an empty feed', () => {
  const s = stub(null, { observations: [], cursor: null, hasMore: false });
  const read = readDrawerBody({ kind: 'activity-feed', body: {} }, { reader: s.reader, now: 99 });
  expect(read.events).toBeNull();
  expect(read.failure).toBe('shape-mismatch');
});

test('a requests body yields its rows, read at `now`, complete as today\'s lenient read assumes', () => {
  const rows = [row('7'), row('8')];
  const s = stub([], { observations: rows, cursor: null, hasMore: false });
  const read = readDrawerBody({ kind: 'friend-requests', body: { r: 1 } }, { reader: s.reader, now: 1_234 });
  expect(read).toEqual({ events: null, pendingPreview: [], requests: { rows, pendingComplete: true },
    tier: 'canonical', partial: false });
  expect(s.calls).toEqual([['requests', { r: 1 }, 1_234]]);
});

test('over the real reader, a well-formed inbox body reads its follow events', () => {
  const body = { counts: {}, new_stories: [{ story_type: 101, args: { profile_id: '42', profile_name: 'u42',
    timestamp: 1_000, text: 'u42 started following you.' } }], old_stories: [] };
  const read = readDrawerBody({ kind: 'activity-feed', body }, { reader: new Reader(), now: 1 });
  expect(read.events?.map((e) => e.pk)).toEqual(['42']);
});
