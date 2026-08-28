import {
  FollowbackWatcher,
  FOLLOWBACK_DEFAULTS,
  type FollowbackEvent,
  type FollowbackNotifications,
} from '@/engine/followback-watcher';
import { KnowledgeStore } from '@/store/knowledge-store';
import { FakeClock } from '@/governors/clock';
import type { FollowRecord } from '@/store/types';
import { setLevel } from '@/utils/logger';

beforeAll(() => setLevel('error'));

const OWN = 'me';
const NOW = 1_000_000;

type FetchResult = { ok: boolean; events: FollowbackEvent[]; reason?: string };

/** A scripted notifications source that counts how many reads happened. */
class FakeNotifications implements FollowbackNotifications {
  calls = 0;
  constructor(private readonly result: FetchResult) {}
  async fetchRecent(): Promise<FetchResult> {
    this.calls += 1;
    return this.result;
  }
}

const follow = (pk: string, atMs: number | null = null): FollowbackEvent => ({
  pk,
  username: `u${pk}`,
  atMs,
});

let store: KnowledgeStore;
let clock: FakeClock;
beforeEach(() => {
  store = new KnowledgeStore(':memory:');
  clock = new FakeClock(NOW);
});
afterEach(() => store.close());

const rec = (over: Partial<FollowRecord> & { accountPk: string }): FollowRecord => ({
  targetPk: null,
  state: 'pending_followback',
  followedAt: NOW - 5000,
  retryCount: 0,
  ...over,
});

const watcher = (notifications: FollowbackNotifications): FollowbackWatcher =>
  new FollowbackWatcher({ store, clock, ownPk: OWN, notifications });

test('a pending follow seen in the notifications feed transitions to followed_back', async () => {
  store.upsertFollowRecord(rec({ accountPk: 'A' }));
  store.upsertFollowRecord(rec({ accountPk: 'B' }));

  const src = new FakeNotifications({ ok: true, events: [follow('A'), follow('X')] });
  const { detected } = await watcher(src).check();

  expect(detected).toEqual(['A']);
  const a = store.getFollowRecord('A')!;
  expect(a.state).toBe('followed_back');
  expect(a.followedBackAt).toBe(NOW);
  expect(a.holdUntil).toBe(NOW + FOLLOWBACK_DEFAULTS.holdAfterFollowbackMs);

  // Their follow-of-us edge is recorded active (X's too — free data).
  expect(store.getEdge('A', OWN, 'follows')!.status).toBe('active');
  expect(store.getEdge('X', OWN, 'follows')!.status).toBe('active');

  // B remains pending.
  expect(store.getFollowRecord('B')!.state).toBe('pending_followback');
});

test('empty pending → does not read notifications at all (request-minimal)', async () => {
  store.upsertFollowRecord(rec({ accountPk: 'Z', state: 'queued' }));

  const src = new FakeNotifications({ ok: true, events: [follow('A')] });
  const { detected } = await watcher(src).check();

  expect(detected).toEqual([]);
  expect(src.calls).toBe(0);
});

test('a follow-back already recorded in the graph resolves with ZERO requests', async () => {
  store.upsertFollowRecord(rec({ accountPk: 'A' }));
  store.observeEdge('A', OWN, 'follows', true, NOW - 10_000);

  const src = new FakeNotifications({ ok: true, events: [] });
  const { detected } = await watcher(src).check();

  expect(detected).toEqual(['A']);
  expect(store.getFollowRecord('A')!.state).toBe('followed_back');
  expect(src.calls).toBe(0); // resolved from knowledge already paid for
});

test('an event timestamp anchors the edge AND the hold at the event time', async () => {
  const followedAt = NOW - 3 * 24 * 3600 * 1000;
  const eventAt = NOW - 2 * 24 * 3600 * 1000; // they followed back 2 days ago
  store.upsertFollowRecord(rec({ accountPk: 'A', followedAt }));

  const src = new FakeNotifications({ ok: true, events: [follow('A', eventAt)] });
  await watcher(src).check();

  const a = store.getFollowRecord('A')!;
  // The hold anchors at the EVENT time — they have already served 2 days.
  expect(a.followedBackAt).toBe(eventAt);
  expect(a.holdUntil).toBe(eventAt + FOLLOWBACK_DEFAULTS.holdAfterFollowbackMs);
  // The edge is first seen at the event's own day (net-growth truthfulness).
  expect(store.getEdge('A', OWN, 'follows')!.firstSeenAt).toBe(eventAt);
});

test('an event that PREDATES our follow anchors the hold at our follow, never before', async () => {
  const followedAt = NOW - 1000;
  const eventAt = NOW - 10 * 24 * 3600 * 1000; // they followed us long before we followed them
  store.upsertFollowRecord(rec({ accountPk: 'A', followedAt }));

  const src = new FakeNotifications({ ok: true, events: [follow('A', eventAt)] });
  await watcher(src).check();

  const a = store.getFollowRecord('A')!;
  expect(a.followedBackAt).toBe(followedAt);
  expect(a.holdUntil).toBe(followedAt + FOLLOWBACK_DEFAULTS.holdAfterFollowbackMs);
});

test('a FUTURE/garbage feed timestamp is clamped to now', async () => {
  store.upsertFollowRecord(rec({ accountPk: 'A' }));

  const src = new FakeNotifications({ ok: true, events: [follow('A', NOW + 999_999)] });
  await watcher(src).check();

  expect(store.getFollowRecord('A')!.followedBackAt).toBe(NOW);
});

test('a failed notifications read changes NOTHING (pending stays pending)', async () => {
  store.upsertFollowRecord(rec({ accountPk: 'A' }));

  const src = new FakeNotifications({ ok: false, events: [], reason: 'no-response' });
  const { detected } = await watcher(src).check();

  expect(detected).toEqual([]);
  expect(store.getFollowRecord('A')!.state).toBe('pending_followback');
  expect(store.getEdge('A', OWN, 'follows')).toBeNull();
});

test('a fetchRecent rejection propagates (no silent catch) and leaves records untouched', async () => {
  store.upsertFollowRecord(rec({ accountPk: 'A' }));

  const boom: FollowbackNotifications = {
    fetchRecent: async () => {
      throw new Error('tab gone');
    },
  };
  await expect(watcher(boom).check()).rejects.toThrow('tab gone');
  expect(store.getFollowRecord('A')!.state).toBe('pending_followback');
});

test('an ACCEPTED follow request counts as a follow-back (private-account path)', async () => {
  store.upsertFollowRecord(rec({ accountPk: 'R' }));

  const src: FollowbackNotifications = {
    fetchRecent: async (opts) => {
      expect(opts?.acceptRequests).toBe(true); // defaults pass auto-accept through
      return { ok: true, events: [], accepted: [{ pk: 'R', username: 'req_r' }] };
    },
  };
  const { detected } = await watcher(src).check();

  expect(detected).toEqual(['R']);
  const r = store.getFollowRecord('R')!;
  expect(r.state).toBe('followed_back');
  expect(store.getEdge('R', OWN, 'follows')!.status).toBe('active');
  expect(store.getAccount('R')?.username).toBe('req_r');
});

test('the FIRST check anchors the followers baseline: backlog is stock, later events chart', async () => {
  store.setOwnPk(OWN);
  store.upsertFollowRecord(rec({ accountPk: 'A' }));

  // First sweep: the feed's backlog carries events from before measurement.
  const first = new FakeNotifications({
    ok: true,
    events: [follow('A', NOW - 5000), follow('X', NOW - 9000)],
  });
  await watcher(first).check();
  expect(store.followersBaselineAt()).toBe(NOW);
  expect(store.netFollowersSince(0)).toBe(0); // backlog = pre-existing stock

  // A later sweep observes a genuinely new event → it charts as growth.
  store.upsertFollowRecord(rec({ accountPk: 'B' }));
  clock.advance(3_600_000);
  const second = new FakeNotifications({ ok: true, events: [follow('B', NOW + 1_800_000)] });
  await watcher(second).check();
  expect(store.followersBaselineAt()).toBe(NOW); // set-once: never moved
  expect(store.netFollowersSince(0)).toBe(1);
});

test('a check with nothing pending still anchors the baseline (collection has begun)', async () => {
  store.setOwnPk(OWN);
  const src = new FakeNotifications({ ok: true, events: [follow('A')] });
  await watcher(src).check();
  expect(src.calls).toBe(0); // request-minimal path unchanged
  expect(store.followersBaselineAt()).toBe(NOW);
});

test('an accepted request with an unresolved pk is warned and skipped (no phantom record)', async () => {
  store.upsertFollowRecord(rec({ accountPk: 'S' }));

  const src: FollowbackNotifications = {
    fetchRecent: async () => ({
      ok: true,
      events: [],
      accepted: [{ pk: null, username: 'mystery' }],
    }),
  };
  const { detected } = await watcher(src).check();

  expect(detected).toEqual([]);
  expect(store.getFollowRecord('S')!.state).toBe('pending_followback');
});
