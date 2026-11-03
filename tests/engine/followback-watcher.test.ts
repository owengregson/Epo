import { type ChannelEvidence, FollowbackWatcher } from '@/engine/followback-watcher';
import { FakeClock } from '@/governors/clock';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { setLevel } from '@/utils/logger';
import { rec } from '../kit/engine-harness';
import { openTestStore } from '../kit/store';

const DAY = 86_400_000;
const HOLD = 2 * DAY;
const NOW = Date.UTC(2026, 10, 3, 12);
let store: KnowledgeStore;
let clock: FakeClock;
let heard: ChannelEvidence[];

beforeEach(() => {
  setLevel('error');
  store = openTestStore(':memory:');
  store.setOwnPk('ME');
  store.ensureFollowersBaseline(NOW - 30 * DAY);
  clock = new FakeClock(NOW);
  heard = [];
});
afterEach(() => store.close());

const watcher = () => new FollowbackWatcher({ store, clock, ownPk: 'ME', cfg: { holdAfterFollowbackMs: HOLD, autoAcceptRequests: true },
  settleChannels: (e) => heard.push(e) });
const pending = (pk: string, followedAt = NOW - 3 * DAY) =>
  store.upsertFollowRecord(rec({ accountPk: pk, state: 'pending_followback', followedAt }));

describe('the appliers write each fact the moment it arrives', () => {
  test('a dated event: an exact change row, the managed record at the exact time, the accept channel told', () => {
    pending('a');
    watcher().applyEvent({ pk: 'a', username: 'alice', atMs: NOW - DAY });
    expect(store.getFollowRecord('a')).toMatchObject({ state: 'followed_back', followedBackAt: NOW - DAY,
      followbackObservedAt: NOW, holdUntil: NOW - DAY + HOLD });
    expect(store.growth.latestGain('a')).toMatchObject({ lo: NOW - DAY, hi: NOW - DAY, source: 'feed' });
    expect(store.getAccount('a')?.username).toBe('alice');
    expect(heard).toEqual([{ follower: { pk: 'a', atMs: NOW - DAY } }]);
  });

  test('an event that predates our follow holds from our follow, never before', () => {
    pending('a', NOW - DAY);
    watcher().applyEvent({ pk: 'a', username: null, atMs: NOW - 2 * DAY });
    expect(store.getFollowRecord('a')?.holdUntil).toBe(NOW - DAY + HOLD);
  });

  test('an old event cannot reverse a newer absence', () => {
    pending('a');
    store.observeEdge('a', 'ME', 'follows', false, NOW);
    watcher().applyEvent({ pk: 'a', username: null, atMs: NOW - DAY });
    expect(store.getFollowRecord('a')?.state).toBe('pending_followback');
    expect(store.getEdge('a', 'ME', 'follows')?.status).toBe('removed');
  });

  test('an undated event writes its name; a record moves only without a seen removal, with no fabricated time', () => {
    pending('a');
    pending('b');
    store.observeEdge('b', 'ME', 'follows', false, NOW - 1);
    const w = watcher();
    w.applyUndated({ pk: 'a', username: 'alice', atMs: null });
    w.applyUndated({ pk: 'b', username: 'bob', atMs: null });
    expect(store.getFollowRecord('a')).toMatchObject({ state: 'followed_back', followbackObservedAt: NOW, holdUntil: NOW + HOLD });
    expect(store.getFollowRecord('a')?.followedBackAt).toBeUndefined();
    expect(store.getFollowRecord('b')?.state).toBe('pending_followback');
    expect(store.getAccount('a')?.username).toBe('alice');
  });

  test('a requester row opens its requests edge and tells the accept channel it is still listed', () => {
    watcher().applyRequester({ pk: 'r', observation: { accountPk: 'r', observedAt: NOW, source: 'friend-requests',
      fields: { username: 'req' } } }, NOW);
    expect(store.hasActiveRequest('r')).toBe(true);
    expect(store.getAccount('r')?.username).toBe('req');
    expect(heard).toEqual([{ stillRequesting: { pk: 'r', at: NOW } }]);
  });

  test('an accepted request: an exact accept row, the requester followed back at the accept', () => {
    pending('r');
    store.observeEdge('r', 'ME', 'requests', true, NOW - 10);
    watcher().applyAccepted({ pk: 'r', username: 'req', at: NOW });
    expect(store.growth.latestGain('r')).toMatchObject({ lo: NOW, hi: NOW, source: 'accept' });
    expect(store.hasActiveRequest('r')).toBe(false);
    expect(store.getFollowRecord('r')).toMatchObject({ state: 'followed_back', followedBackAt: NOW });
  });

  test('an accepted request with no resolved pk writes nothing', () => {
    watcher().applyAccepted({ pk: null, username: 'ghost', at: NOW });
    expect(store.pkByUsername('ghost')).toBeNull();
  });
});

describe('the consistency pass (store-only)', () => {
  const gain = (pk: string, lo: number, at: number) => store.observeEdge(pk, 'ME', 'follows', true, at, { source: 'head-walk', lo });

  test('a managed record whose follower edge and gain the graph holds moves, held from the gain\'s end', () => {
    pending('a', NOW - 3 * DAY);
    gain('a', NOW - 2 * DAY, NOW - DAY);
    expect(watcher().consistencyPass(NOW)).toBe(1);
    expect(store.getFollowRecord('a')).toMatchObject({ state: 'followed_back', followbackAfter: NOW - 2 * DAY,
      followbackObservedAt: NOW, holdUntil: NOW - DAY + HOLD });
  });

  test('a gain that ended before our follow, or no active edge, moves nothing', () => {
    pending('a', NOW - DAY);
    gain('a', NOW - 3 * DAY, NOW - 2 * DAY);
    pending('b');
    expect(watcher().consistencyPass(NOW)).toBe(0);
    expect(store.getFollowRecord('a')?.state).toBe('pending_followback');
  });

  test('a no-follow-back queue moves back; a hold-expired one and a kept one are not re-held (kept is only stamped)', () => {
    store.upsertFollowRecord(rec({ accountPk: 'q', state: 'unfollow_queued', unfollowReason: 'no-followback', followedAt: NOW - 5 * DAY }));
    store.upsertFollowRecord(rec({ accountPk: 'h', state: 'unfollow_queued', unfollowReason: 'hold-expired', followedAt: NOW - 5 * DAY }));
    store.upsertFollowRecord(rec({ accountPk: 'k', state: 'kept', followedAt: NOW - 5 * DAY }));
    for (const pk of ['q', 'h', 'k']) store.observeOwnFollowerEvent(pk, 'ME', NOW - DAY);
    watcher().consistencyPass(NOW);
    expect(store.getFollowRecord('q')?.state).toBe('followed_back');
    expect(store.getFollowRecord('h')?.state).toBe('unfollow_queued');
    expect(store.getFollowRecord('k')).toMatchObject({ state: 'kept', followedBackAt: NOW - DAY, followbackObservedAt: NOW });
  });
});
