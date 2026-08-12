import { KnowledgeStore } from '@/store/knowledge-store';
import { FakeClock } from '@/governors/clock';
import { RateGovernor, type RateGovernorConfig } from '@/governors/rate-governor';
import {
  ChurnScheduler,
  CHURN_DEFAULTS,
  type ChurnActions,
  type ChurnConfig,
} from '@/engine/churn-scheduler';
import { setLevel } from '@/utils/logger';
import type { FollowRecord } from '@/store/types';

// Keep test output quiet; the scheduler logs info/warn on every transition.
beforeAll(() => setLevel('error'));

const T0 = Date.parse('2026-08-12T12:00:00');
const OWN = 'me';

/** Records every call and returns configurable ok/fail. No browser involved. */
class FakeActions implements ChurnActions {
  followCalls: string[] = [];
  unfollowCalls: string[] = [];
  followOk = true;
  unfollowOk = true;
  async follow(username: string): Promise<{ ok: boolean }> {
    this.followCalls.push(username);
    return { ok: this.followOk };
  }
  async unfollow(username: string): Promise<{ ok: boolean }> {
    this.unfollowCalls.push(username);
    return { ok: this.unfollowOk };
  }
}

const rateCfg = (ceiling: number): RateGovernorConfig => ({
  dailyHardCeiling: ceiling,
  dailyOperatingRate: ceiling,
  minDelayMs: 0,
  maxDelayMs: 0,
  jitterPercent: 0,
  activeHoursStart: 0,
  activeHoursEnd: 24,
});

const rec = (over: Partial<FollowRecord> & { accountPk: string }): FollowRecord => ({
  targetPk: null,
  state: 'queued',
  retryCount: 0,
  ...over,
});

interface Harness {
  store: KnowledgeStore;
  clock: FakeClock;
  actions: FakeActions;
  sched: ChurnScheduler;
}

const makeHarness = (opts?: {
  ceiling?: number;
  cfg?: Partial<ChurnConfig>;
  ownPk?: string;
}): Harness => {
  const store = new KnowledgeStore(':memory:');
  const clock = new FakeClock(T0);
  const rate = new RateGovernor(store, clock, rateCfg(opts?.ceiling ?? 1000));
  const actions = new FakeActions();
  const sched = new ChurnScheduler({
    store,
    clock,
    rate,
    actions,
    ownPk: opts?.ownPk,
    cfg: { ...CHURN_DEFAULTS, ...opts?.cfg },
  });
  return { store, clock, actions, sched };
};

/** Give an account a known username so the scheduler can action it. */
const seedUsername = (store: KnowledgeStore, pk: string, username: string): void =>
  store.observe({
    accountPk: pk,
    observedAt: T0,
    source: 'profile',
    fields: { username, followers: 100, following: 100 },
  });

test('queued → tick → follow called, state pending_followback, followedAt set, ledger records follow', async () => {
  const { store, actions, sched } = makeHarness({ ownPk: OWN });
  seedUsername(store, '1', 'user1');
  store.upsertFollowRecord(rec({ accountPk: '1', targetPk: 'T', state: 'queued' }));

  await sched.tick();

  expect(actions.followCalls).toEqual(['user1']);
  const got = store.getFollowRecord('1')!;
  expect(got.state).toBe('pending_followback');
  expect(got.followedAt).toBe(T0);
  expect(store.actionCountSince(0)).toBe(1);
  // ownPk set → the follow is recorded as an active directed edge.
  expect(store.getEdge(OWN, '1', 'follows')?.status).toBe('active');
});

test('pending_followback past maxWaitForFollowbackMs → tick → unfollow_queued with unfollowDueAt', async () => {
  const { store, clock, sched } = makeHarness({ cfg: { maxWaitForFollowbackMs: 1000 } });
  // No username seeded → the timer transition is observable in isolation (action step skips).
  store.upsertFollowRecord(rec({ accountPk: '2', state: 'pending_followback', followedAt: T0 }));

  clock.advance(1000); // now - followedAt === maxWait
  await sched.tick();

  const got = store.getFollowRecord('2')!;
  expect(got.state).toBe('unfollow_queued');
  expect(got.unfollowDueAt).toBe(T0 + 1000);
});

test('followed_back with past holdUntil → tick → unfollow_queued', async () => {
  const { store, clock, sched } = makeHarness();
  // No username seeded → isolate the hold-timer transition from the unfollow action.
  store.upsertFollowRecord(
    rec({ accountPk: '3', state: 'followed_back', followedBackAt: T0, holdUntil: T0 + 500 }),
  );

  clock.advance(500); // now === holdUntil
  await sched.tick();

  const got = store.getFollowRecord('3')!;
  expect(got.state).toBe('unfollow_queued');
  expect(got.unfollowDueAt).toBe(T0 + 500);
});

test('unfollow_queued → tick → unfollow called, state unfollowed, edge removed', async () => {
  const { store, actions, sched } = makeHarness({ ownPk: OWN });
  seedUsername(store, '4', 'user4');
  store.observeEdge(OWN, '4', 'follows', true, T0); // we currently follow them
  store.upsertFollowRecord(rec({ accountPk: '4', state: 'unfollow_queued', unfollowDueAt: T0 }));

  await sched.tick();

  expect(actions.unfollowCalls).toEqual(['user4']);
  expect(store.getFollowRecord('4')!.state).toBe('unfollowed');
  expect(store.getEdge(OWN, '4', 'follows')?.status).toBe('removed');
});

test('failing follow increments retryCount and abandons once maxRetries exceeded', async () => {
  const { store, actions, sched } = makeHarness({ cfg: { maxRetries: 2 } });
  seedUsername(store, '5', 'user5');
  actions.followOk = false;
  store.upsertFollowRecord(rec({ accountPk: '5', state: 'queued' }));

  await sched.tick(); // fail → retryCount 1, still queued
  expect(store.getFollowRecord('5')).toMatchObject({ state: 'queued', retryCount: 1 });

  await sched.tick(); // fail → retryCount 2, still queued (2 > 2 is false)
  expect(store.getFollowRecord('5')).toMatchObject({ state: 'queued', retryCount: 2 });

  await sched.tick(); // fail → retryCount 3 > maxRetries → abandoned
  expect(store.getFollowRecord('5')).toMatchObject({ state: 'abandoned', retryCount: 3 });
  expect(actions.followCalls).toHaveLength(3);
});

test('at hard ceiling: no actions run and due records are NOT dropped', async () => {
  const { store, clock, actions, sched } = makeHarness({ ceiling: 3 });
  // Seed today's ledger up to the hard ceiling.
  for (let i = 0; i < 3; i++) store.recordAction(`x${i}`, 'follow', 'ok', clock.now());

  seedUsername(store, '6', 'user6');
  seedUsername(store, '7', 'user7');
  store.upsertFollowRecord(rec({ accountPk: '6', state: 'queued' }));
  store.upsertFollowRecord(rec({ accountPk: '7', state: 'unfollow_queued', unfollowDueAt: T0 }));

  await sched.tick();

  expect(actions.followCalls).toEqual([]);
  expect(actions.unfollowCalls).toEqual([]);
  // The critical invariant: nothing is silently discarded — both remain active & due.
  const active = store.activeFollowRecords().map((r) => r.accountPk).sort();
  expect(active).toEqual(['6', '7']);
  expect(store.getFollowRecord('6')!.state).toBe('queued');
  expect(store.getFollowRecord('7')!.state).toBe('unfollow_queued');
});
