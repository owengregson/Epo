import { ChurnScheduler } from '@/engine/churn-scheduler';
import { FollowbackWatcher } from '@/engine/followback-watcher';
import { REENTRY_POLICY, ReentrySupervisor } from '@/engine/reentry';
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

test('week away: a follow-back recorded first, or an open follower edge, keeps the record from the timer', async () => {
  pending();
  const churn = scheduler();
  const feed = jest.fn(async () => ({ ok: true, events: [{ pk: 'a', username: 'alice', atMs: clock.now() - 3_600_000 }] }));
  const watcher = new FollowbackWatcher({ store, clock, ownPk: 'me', notifications: { fetchRecent: feed },
    followers: { fetchAllPks: async () => ({ pks: ['a'], complete: true, authoritative: true }) } });
  expect((await watcher.check({ requireFresh: true })).outcome).toBe('complete');
  churn.advanceTimers();
  expect(store.getFollowRecord('a')).toMatchObject({ state: 'followed_back', followedBackAt: clock.now() - 3_600_000 });
  expect(churn.nextDue()).toBeNull();
  store.upsertFollowRecord({ accountPk: 'a', targetPk: null, state: 'pending_followback', followedAt: START, retryCount: 0 });
  churn.advanceTimers();
  expect(store.getFollowRecord('a')?.state).toBe('pending_followback');
});

test('complete current absence authorizes timeout at its original deadline', async () => {
  pending();
  const watcher = new FollowbackWatcher({ store, clock, ownPk: 'me',
    notifications: { fetchRecent: async () => ({ ok: true, events: [] }) },
    followers: { fetchAllPks: async () => ({ pks: [], complete: true, authoritative: true }) },
  });
  expect((await watcher.check({ requireFresh: true })).outcome).toBe('complete');
  scheduler().advanceTimers();
  expect(store.getFollowRecord('a')).toMatchObject({ state: 'unfollow_queued', unfollowDueAt: START + 3 * DAY, unfollowReason: 'no-followback' });
});

test.each([false, true])('partial or uncovered census cannot prove absence (complete=%s)', async (complete) => {
  pending();
  const watcher = new FollowbackWatcher({ store, clock, ownPk: 'me',
    notifications: { fetchRecent: async () => ({ ok: true, events: [] }) },
    followers: { fetchAllPks: async () => ({ pks: [], complete }) },
  });
  expect(await watcher.check({ requireFresh: true })).toMatchObject({ outcome: 'partial', reconciledAt: null, unresolved: 1 });
  scheduler().advanceTimers();
  // No absence is concluded here: the queued unfollow reads the fresh relationship at its click.
  expect(store.getEdge('a', 'me', 'follows')).toBeNull();
  expect(store.getFollowRecord('a')?.state).toBe('unfollow_queued');
});

test('unknown historical follow-back gets an observed hold, not a fabricated timing sample', async () => {
  pending();
  const watcher = new FollowbackWatcher({ store, clock, ownPk: 'me',
    notifications: { fetchRecent: async () => ({ ok: true, events: [] }) },
    followers: { fetchAllPks: async () => ({ pks: ['a'], complete: true, authoritative: true }) },
  });
  await watcher.check({ requireFresh: true });
  const record = store.getFollowRecord('a');
  expect(record?.state).toBe('followed_back');
  expect(record?.followedBackAt).toBeUndefined();
  expect(record?.followbackObservedAt).toBe(clock.now());
  expect(record?.holdUntil).toBe(clock.now() + 2 * DAY);
});

test('old notification cannot reverse a newer absence or promote the record', async () => {
  pending();
  store.observeEdge('a', 'me', 'follows', false, clock.now());
  const watcher = new FollowbackWatcher({ store, clock, ownPk: 'me', notifications: {
    fetchRecent: async () => ({ ok: true, events: [{ pk: 'a', username: 'alice', atMs: START + DAY }] }),
  } });
  await watcher.check();
  expect(store.getEdge('a', 'me', 'follows')).toMatchObject({ status: 'removed', lastConfirmedAt: clock.now() });
  expect(store.getFollowRecord('a')?.state).toBe('pending_followback');
});

test.each([null, START + 20 * DAY])('undated or invalid notification cannot invent current membership (%s)', async (atMs) => {
  pending();
  store.observeEdge('a', 'me', 'follows', false, clock.now() - 1);
  const watcher = new FollowbackWatcher({ store, clock, ownPk: 'me', notifications: {
    fetchRecent: async () => ({ ok: true, events: [{ pk: 'a', username: 'alice', atMs }] }),
  } });
  expect(await watcher.check({ requireFresh: true })).toMatchObject({ outcome: 'partial', unresolved: 1 });
  expect(store.getEdge('a', 'me', 'follows')).toMatchObject({ status: 'removed', lastConfirmedAt: clock.now() - 1 });
  expect(store.getFollowRecord('a')?.state).toBe('pending_followback');
});

test('a week away creates reconciliation then bounded probation, never catch-up quota', () => {
  clock.set(START);
  const first = new ReentrySupervisor({ store, clock });
  first.prepare();
  first.noteProgress(START);
  clock.advance(7 * DAY);
  const restored = new ReentrySupervisor({ store, clock });
  expect(restored.prepare().phase).toBe('reconcile');
  restored.noteReconciled({ outcome: 'partial' }, clock.now());
  expect(restored.requiresReconciliation(clock.now())).toBe(true);
  restored.noteReconciled({ outcome: 'complete' }, clock.now());
  expect(restored.snapshot().phase).toBe('probation');
  restored.noteAction(clock.now());
  expect(restored.mutationWaitUntil(clock.now())).toBe(clock.now() + REENTRY_POLICY.probationGapMs);
  for (let i = 1; i < REENTRY_POLICY.probationActions; i++) {
    clock.advance(REENTRY_POLICY.probationGapMs);
    restored.noteAction(clock.now());
  }
  expect(restored.snapshot().phase).toBe('ready');
});

test('new uncertain effect and backward clock independently require reconciliation', () => {
  const supervisor = new ReentrySupervisor({ store, clock });
  supervisor.prepare();
  const intent = store.beginEffectIntent({ accountPk: 'a', username: 'alice', action: 'follow', channel: 'growth', at: clock.now() });
  store.markEffectDispatched(intent.id, clock.now());
  expect(supervisor.requiresReconciliation(clock.now())).toBe(true);
  supervisor.noteReconciled({ outcome: 'complete' }, clock.now());
  expect(supervisor.snapshot().phase).toBe('reconcile');
  store.settleEffectIntent(intent.id, { at: clock.now(), result: 'external' });
  supervisor.noteReconciled({ outcome: 'complete' }, clock.now());
  clock.advance(-DAY);
  expect(supervisor.requiresReconciliation(clock.now())).toBe(true);
  expect(supervisor.snapshot().reason).toBe('clock-change');
});

test('routine sweeps preserve the owed probation gap and never restart a completed return', () => {
  pending();
  const supervisor = new ReentrySupervisor({ store, clock });
  supervisor.prepare();
  supervisor.noteReconciled({ outcome: 'complete' }, clock.now());
  expect(supervisor.snapshot().phase).toBe('probation');
  supervisor.noteAction(clock.now());
  const owed = supervisor.mutationWaitUntil(clock.now());
  supervisor.noteReconciled({ outcome: 'complete' }, clock.now());
  expect(supervisor.mutationWaitUntil(clock.now())).toBe(owed);
  for (let i = 1; i < REENTRY_POLICY.probationActions; i++) {
    clock.advance(REENTRY_POLICY.probationGapMs);
    supervisor.noteAction(clock.now());
  }
  const finalOwed = supervisor.mutationWaitUntil(clock.now());
  supervisor.noteReconciled({ outcome: 'complete' }, clock.now());
  expect(supervisor.snapshot().phase).toBe('ready');
  expect(supervisor.mutationWaitUntil(clock.now())).toBe(finalOwed);
});

test.each(['invalid JSON', '{"v":1,"phase":"ready"}'])('corrupt return metadata requires observation (%s)', (raw) => {
  store.setLifecycleState(raw);
  const supervisor = new ReentrySupervisor({ store, clock });
  expect(supervisor.prepare()).toMatchObject({ phase: 'reconcile', reason: 'legacy-state' });
});

test('targeted reads resume after a daily budget pause and process restart without restarting the cohort', async () => {
  for (const pk of ['a', 'b']) {
    store.observe({ accountPk: pk, observedAt: START, source: 'profile', fields: { username: pk } });
    store.upsertFollowRecord({ accountPk: pk, targetPk: null, state: 'pending_followback', followedAt: START, retryCount: 0 });
  }
  const first = new ReentrySupervisor({ store, clock });
  first.prepare();
  const epoch = first.snapshot().reconciliationStartedAt!;
  const read = jest.fn(async (pk: string) => pk === 'b'
    ? { ok: false as const, reason: 'read-budget' as const, retryAt: clock.now() + DAY }
    : { ok: true as const, followsUs: false, observedAt: clock.now() });
  const watcher = new FollowbackWatcher({ store, clock, ownPk: 'me',
    notifications: { fetchRecent: async () => ({ ok: true, events: [] }) }, relationships: { read } });
  expect(await watcher.check({ requireFresh: true, freshSinceAt: epoch }))
    .toMatchObject({ outcome: 'partial', deferred: 'read-budget', unresolved: 1 });
  clock.advance(DAY + 1000);
  const restarted = new ReentrySupervisor({ store, clock });
  expect(restarted.prepare().reconciliationStartedAt).toBe(epoch);
  read.mockImplementation(async () => ({ ok: true as const, followsUs: false, observedAt: clock.now() }));
  expect(await watcher.check({ requireFresh: true, freshSinceAt: restarted.snapshot().reconciliationStartedAt! }))
    .toMatchObject({ outcome: 'complete', unresolved: 0 });
  expect(read.mock.calls.map(([pk]) => pk)).toEqual(['a', 'b', 'b']);
});
