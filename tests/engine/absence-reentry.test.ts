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

