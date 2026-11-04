import { ChurnScheduler } from '@/engine/churn-scheduler';
import { FollowbackWatcher } from '@/engine/followback-watcher';
import { FakeClock } from '@/governors/clock';
import type { RateGovernor } from '@/governors/rate-governor';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { setLevel } from '@/utils/logger';
import { DEFAULT_CONFIGS } from '../kit/configs';
import { openTestStore } from '../kit/store';

const DAY = 86_400_000;
const START = Date.UTC(2026, 9, 1, 12);
let store: KnowledgeStore;
let clock: FakeClock;
beforeEach(() => {
  setLevel('error');
  store = openTestStore(':memory:');
  store.setOwnPk('me');
  clock = new FakeClock(START + 7 * DAY);
  store.observe({ accountPk: 'a', observedAt: START, source: 'profile', fields: { username: 'alice' } });
});
afterEach(() => store.close());

const scheduler = () => new ChurnScheduler({
  store, clock, ownPk: 'me', rate: {} as RateGovernor,
  cfg: { ...DEFAULT_CONFIGS.churn, maxWaitForFollowbackMs: 3 * DAY },
  actions: { follow: jest.fn(async () => ({ status: 'ok' as const })), unfollow: jest.fn(async () => ({ status: 'ok' as const })) },
});
const watcher = () => new FollowbackWatcher({ store, clock, ownPk: 'me',
  cfg: { holdAfterFollowbackMs: 2 * DAY, autoAcceptRequests: true } });
const pending = () => store.upsertFollowRecord({
  accountPk: 'a', targetPk: null, state: 'pending_followback', followedAt: START, retryCount: 0,
});

test('week away: the timer queues the unfollow and the click verifies it once (verify-at-act, spec §9.7)', () => {
  pending();
  const churn = scheduler();
  churn.advanceTimers();
  expect(store.getFollowRecord('a')).toMatchObject({ state: 'unfollow_queued', unfollowReason: 'no-followback' });
  expect(churn.nextDue()?.accountPk).toBe('a');
});

test('week away: a follow-back recorded first, or an open follower edge, keeps the record from the timer', () => {
  pending();
  const churn = scheduler();
  watcher().applyEvent({ pk: 'a', username: 'alice', atMs: clock.now() - 3_600_000 });
  churn.advanceTimers();
  expect(store.getFollowRecord('a')).toMatchObject({ state: 'followed_back', followedBackAt: clock.now() - 3_600_000 });
  expect(churn.nextDue()).toBeNull();
  store.upsertFollowRecord({ accountPk: 'a', targetPk: null, state: 'pending_followback', followedAt: START, retryCount: 0 });
  churn.advanceTimers();
  expect(store.getFollowRecord('a')?.state).toBe('pending_followback');
});

test('an undated follow-back the graph holds gets an observed hold from its interval, not a fabricated time', () => {
  pending();
  store.ensureFollowersBaseline(START - DAY);
  store.observeEdge('a', 'me', 'follows', true, clock.now(), { source: 'head-walk', lo: START + DAY });
  expect(watcher().consistencyPass(clock.now())).toBe(1);
  const record = store.getFollowRecord('a');
  expect(record?.state).toBe('followed_back');
  expect(record?.followedBackAt).toBeUndefined();
  expect(record?.followbackAfter).toBe(START + DAY);
  expect(record?.followbackObservedAt).toBe(clock.now());
  expect(record?.holdUntil).toBe(clock.now() + 2 * DAY);
});

test('old notification cannot reverse a newer absence or promote the record', () => {
  pending();
  store.observeEdge('a', 'me', 'follows', false, clock.now());
  watcher().applyEvent({ pk: 'a', username: 'alice', atMs: START + DAY });
  expect(store.getEdge('a', 'me', 'follows')).toMatchObject({ status: 'removed', lastConfirmedAt: clock.now() });
  expect(store.getFollowRecord('a')?.state).toBe('pending_followback');
});

test('an undated notification cannot invent current membership', () => {
  pending();
  store.observeEdge('a', 'me', 'follows', false, clock.now() - 1);
  watcher().applyUndated({ pk: 'a', username: 'alice', atMs: null });
  expect(store.getEdge('a', 'me', 'follows')).toMatchObject({ status: 'removed', lastConfirmedAt: clock.now() - 1 });
  expect(store.getFollowRecord('a')?.state).toBe('pending_followback');
});
