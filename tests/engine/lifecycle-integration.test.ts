import { ChurnScheduler } from '@/engine/churn-scheduler';
import { Engine } from '@/engine/engine';
import { FollowbackWatcher } from '@/engine/followback-watcher';
import { ReentrySupervisor } from '@/engine/reentry';
import { FakeClock } from '@/governors/clock';
import { ReadBudget } from '@/governors/read-budget';
import { reconcileEffects } from '@/rim/effect-reconciliation';
import { settleNextIntent } from '@/rim/journal-settlement';
import type { ProfileVisitor } from '@/rim/profile-visit-port';
import { DEFAULT_SETTINGS } from '@/settings/settings';
import { DelayManager } from '@/timing/delay-manager';
import { setLevel } from '@/utils/logger';
import { DEFAULT_CONFIGS } from '../kit/configs';
import { kitStore, testDeps } from '../kit/engine-harness';
import { readLimits } from '../kit/read-limits';

const DAY = 86_400_000;
const START = Date.UTC(2026, 9, 1, 12);

function fixture() {
  setLevel('error');
  const store = kitStore();
  store.setOwnPk('me');
  const clock = new FakeClock(START);
  for (const pk of ['hub', 'old', 'new']) store.observe({ accountPk: pk, observedAt: START,
    source: 'profile', fields: { username: pk, followers: 200, following: 200, isPrivate: false } });
  store.addTarget({ accountPk: 'hub', source: 'seed', status: 'active', chainIndex: 0 });
  const history = new ReentrySupervisor({ store, clock });
  history.prepare();
  history.noteProgress(clock.now());
  clock.advance(7 * DAY);
  const reentry = new ReentrySupervisor({ store, clock });
  reentry.prepare(); // graph construction
  const actions = {
    follow: jest.fn(async (_username: string, _pk?: string, dispatched?: () => void) => {
      dispatched?.(); return { status: 'ok' as const };
    }),
    unfollow: jest.fn(async (_username: string, _pk?: string, dispatched?: () => void) => {
      dispatched?.(); return { status: 'ok' as const };
    }),
  };
  const base = testDeps({ store, clock });
  const churn = new ChurnScheduler({ store, clock, ownPk: 'me', rate: base.rate as never, actions,
    cfg: { ...DEFAULT_CONFIGS.churn, maxWaitForFollowbackMs: 3 * DAY } });
  let lastSweep: number | null = null;
  const cadence = { isDue: () => lastSweep === null, markRun: (at: number) => { lastSweep = at; } };
  const settings = { ...DEFAULT_SETTINGS, seed: 'hub', lowWaterCandidates: 0,
    activeHoursStart: 0, activeHoursEnd: 24, followbackSweepHours: 1 };
  const delays = new DelayManager({ clock, sleep: async (ms) => { clock.advance(ms); } });
  return { store, clock, reentry, actions, churn, cadence, settings, delays, lastSweep: () => lastSweep,
    rearmSweep: () => { lastSweep = null; },
    make: (followback: FollowbackWatcher, extra: Partial<Parameters<typeof testDeps>[0]> = {}) =>
      new Engine(testDeps({ ...base, churn, reentry, settings, delays, sweepCadence: cadence, followback, ...extra })),
    settler: (profiles: ProfileVisitor) => () => settleNextIntent({ store, profiles, ownPk: 'me', clock,
      readBudget: { consume: () => ({ allowed: true, resumeAt: null }) }, maxRetries: () => 3, signal: () => undefined,
      slots: () => ({ nextSessionAt: null, planDayStartAfter: (k) => clock.now() + k * DAY }) }) };
}

test('graph prepare plus real start preserves week-away reconciliation; no mutation precedes it', async () => {
  const f = fixture();
  f.store.upsertFollowRecord({ accountPk: 'old', targetPk: 'hub', state: 'pending_followback', followedAt: START, retryCount: 0 });
  const feed = jest.fn(async () => ({ ok: true, events: [{ pk: 'old', username: 'old', atMs: f.clock.now() - 60_000 }] }));
  const followback = new FollowbackWatcher({ store: f.store, clock: f.clock, ownPk: 'me',
    notifications: { fetchRecent: feed }, followers: { fetchAllPks: async () => ({ pks: ['old'], complete: true, authoritative: true }) } });
  let stopped = false;
  const engine = f.make(followback, { onStatus: (status) => {
    if (status.lastStep === 'swept-followback' && !stopped) { stopped = true; engine.stop(); }
  } });
  await engine.start();
  expect(feed).toHaveBeenCalledTimes(1);
  expect(f.reentry.snapshot()).toMatchObject({ phase: 'probation', absentMs: 7 * DAY });
  expect(f.store.getFollowRecord('old')?.state).toBe('followed_back');
  expect(f.actions.follow).not.toHaveBeenCalled();
  expect(f.actions.unfollow).not.toHaveBeenCalled();
  expect(f.lastSweep()).not.toBeNull();
});

test('a budget-interrupted census streams positives and ends its sweep only; the next sweep completes it', async () => {
  const f = fixture();
  for (const pk of ['old', 'new']) f.store.upsertFollowRecord({ accountPk: pk, targetPk: 'hub',
    state: 'pending_followback', followedAt: START, retryCount: 0 });
  let complete = false;
  const followback = new FollowbackWatcher({ store: f.store, clock: f.clock, ownPk: 'me',
    notifications: { fetchRecent: async () => ({ ok: true, events: [] }) },
    followers: { fetchAllPks: async () => ({ pks: ['old'], complete, authoritative: complete }) } });
  const engine = f.make(followback);
  expect(await engine.stepOnce()).toBe('idle');
  expect(f.store.getEdge('old', 'me', 'follows')?.status).toBe('active');
  expect(f.store.getEdge('new', 'me', 'follows')).toBeNull();
  // Verify-at-act (spec §9.7): the timer queues it; the click reads the fresh relationship before any press.
  expect(f.store.getFollowRecord('new')?.state).toBe('unfollow_queued');
  // Spec §9.12: an incomplete read ends its sweep (the next waits its interval); nothing gates growth on it.
  expect(f.lastSweep()).not.toBeNull();
  expect(f.reentry.snapshot().phase).toBe('reconcile');
  expect(f.actions.unfollow).not.toHaveBeenCalled();
  complete = true;
  f.rearmSweep();
  expect(await engine.stepOnce()).toBe('swept-followback');
  expect(f.store.getFollowRecord('new')).toMatchObject({ state: 'unfollow_queued', unfollowDueAt: START + 3 * DAY });
  expect(f.lastSweep()).not.toBeNull();
});

test('a failed notification read ends its sweep only: the return phase stays and the queued unfollow goes on', async () => {
  const f = fixture();
  f.store.upsertFollowRecord({ accountPk: 'old', targetPk: 'hub', state: 'unfollow_queued', followedAt: START, retryCount: 0 });
  const followback = new FollowbackWatcher({ store: f.store, clock: f.clock, ownPk: 'me',
    notifications: { fetchRecent: async () => ({ ok: false, events: [] }) } });
  const engine = f.make(followback);
  expect(await engine.stepOnce()).toBe('idle');
  expect(f.lastSweep()).not.toBeNull();
  expect(f.reentry.snapshot().phase).toBe('reconcile');
  expect(f.actions.unfollow).not.toHaveBeenCalled();
  // No reconcile phase gates the next action (the click verifies it, spec §9.7).
  expect(await engine.stepOnce()).toBe('acted');
  expect(f.actions.unfollow).toHaveBeenCalledTimes(1);
  expect(engine.status().state).not.toBe('halted');
});

test('an uncertain follow is observed by PK in the journal step: the follow mirror waits for its follow-back', async () => {
  const f = fixture();
  f.reentry.noteReconciled({ outcome: 'complete' }, f.clock.now());
  f.store.upsertFollowRecord({ accountPk: 'old', targetPk: 'hub', state: 'queued', retryCount: 0 });
  const intent = f.store.beginEffectIntent({ accountPk: 'old', username: 'old', action: 'follow', channel: 'growth', at: f.clock.now() });
  f.store.markEffectUncertain(intent.id, f.clock.now());
  const dispatchedAt = f.clock.now();
  const profiles: ProfileVisitor = { visit: jest.fn(async () => ({ ok: true as const,
    obs: { accountPk: 'old', observedAt: f.clock.now(), source: 'profile' as const, fields: { username: 'old' } },
    viewer: { following: true, requested: false, followsUs: false },
  })) };
  const followback = new FollowbackWatcher({ store: f.store, clock: f.clock, ownPk: 'me',
    notifications: { fetchRecent: async () => ({ ok: true, events: [] }) } });
  const engine = f.make(followback, { settleJournal: f.settler(profiles) });
  expect(await engine.stepOnce()).toBe('swept-followback');
  expect(profiles.visit).toHaveBeenCalledWith('old');
  expect(f.store.pendingEffectIntents()).toEqual([]);
  // Spec §9.8: a landed follow is ours from its dispatch, never leaked as external.
  expect(f.store.getFollowRecord('old')).toMatchObject({ state: 'pending_followback', followedAt: dispatchedAt });
  expect(f.store.actionCountSince(0)).toBe(0);
  expect(f.store.additionalMutationCountSince(0)).toBe(1);
  expect(f.actions.follow).not.toHaveBeenCalled();
});

test('effect reconciliation cannot settle a reassigned username or unresolved viewer state', async () => {
  const f = fixture();
  const intent = f.store.beginEffectIntent({ accountPk: 'old', username: 'old', action: 'follow', channel: 'growth', at: f.clock.now() });
  f.store.markEffectDispatched(intent.id, f.clock.now());
  const profiles: ProfileVisitor = { visit: async () => ({ ok: true,
    obs: { accountPk: 'replacement', observedAt: f.clock.now(), source: 'profile', fields: { username: 'old' } },
    viewer: { following: false, requested: false, followsUs: false },
  }) };
  expect(await reconcileEffects({ store: f.store, clock: f.clock, ownPk: 'me', profiles })).toMatchObject({ outcome: 'failed', remaining: 1, settled: 0 });
  expect(f.store.pendingEffectIntents()).toHaveLength(1);
});

test('cleanup obligations survive source rotation, with bounded fairness for new follows', async () => {
  const f = fixture();
  f.store.setTargetStatus('hub', 'exhausted');
  for (const pk of ['u1', 'u2', 'u3']) {
    f.store.observe({ accountPk: pk, observedAt: f.clock.now(), source: 'profile', fields: { username: pk } });
    f.store.upsertFollowRecord({ accountPk: pk, targetPk: 'hub', state: 'unfollow_queued', followedAt: START,
      unfollowDueAt: START + DAY, reconciledAt: f.clock.now(), retryCount: 0 });
  }
  f.store.upsertFollowRecord({ accountPk: 'new', targetPk: null, state: 'queued', retryCount: 0, score: 1 });
  expect(f.churn.nextDue()?.state).toBe('unfollow_queued');
  await f.churn.execute(f.churn.nextDue()!);
  await f.churn.execute(f.churn.nextDue()!);
  expect(f.churn.nextDue()?.accountPk).toBe('new');
});

test('the journal settles one open intent per step, never a batch or a halt; a prepared one is never read', async () => {
  const f = fixture();
  f.reentry.noteReconciled({ outcome: 'complete' }, f.clock.now());
  for (const pk of ['old', 'new']) {
    const open = f.store.beginEffectIntent({ accountPk: pk, username: pk, action: 'follow', channel: 'growth', at: f.clock.now() });
    f.store.markEffectUncertain(open.id, f.clock.now());
  }
  f.store.beginEffectIntent({ accountPk: 'hub', username: 'hub', action: 'follow', channel: 'growth', at: f.clock.now() });
  const profiles: ProfileVisitor = { visit: jest.fn(async () => ({ ok: false as const, kind: 'unanswered' as const, detail: {} })) };
  const check = jest.fn(async () => ({ detected: [], outcome: 'complete' as const, reconciledAt: f.clock.now(), unresolved: 0 }));
  const engine = f.make({ check } as unknown as FollowbackWatcher, { settleJournal: f.settler(profiles) });
  expect(await engine.stepOnce()).toBe('swept-followback');
  expect(profiles.visit).toHaveBeenCalledTimes(1);
  expect(await engine.stepOnce()).toBe('swept-followback');
  expect(profiles.visit).toHaveBeenCalledTimes(2);
  expect(check).not.toHaveBeenCalled();
  // Both unreadable intents parked to their next re-check; the sweep is never wedged behind them.
  expect(await engine.stepOnce()).toBe('swept-followback');
  expect(check).toHaveBeenCalledTimes(1);
  expect(profiles.visit).not.toHaveBeenCalledWith('hub');
  expect(engine.status().state).not.toBe('halted');
  expect(f.store.pendingEffectIntents().map((i) => [i.accountPk, i.attempts]).sort()).toEqual([['hub', 0], ['new', 1], ['old', 1]]);
});

test('a notification-budget pause ends its sweep without escalation or a halt, and never gates growth', async () => {
  const f = fixture();
  f.store.upsertFollowRecord({ accountPk: 'old', targetPk: 'hub', state: 'pending_followback', followedAt: START, retryCount: 0 });
  const fetchRecent = jest.fn(async () => ({ ok: false, events: [], reason: 'read-budget', retryAt: f.clock.now() + 60_000 }));
  const engine = f.make(new FollowbackWatcher({ store: f.store, clock: f.clock, ownPk: 'me', notifications: { fetchRecent } }));
  expect(await engine.stepOnce()).toBe('idle');
  expect(f.lastSweep()).not.toBeNull();
  for (let i = 0; i < 5; i++) {
    await engine.stepOnce();
    expect(engine.status().state).not.toBe('halted');
  }
  // One read per sweep; the queued unfollow went on (the click verifies it, spec §9.7).
  expect(fetchRecent).toHaveBeenCalledTimes(1);
  expect(f.actions.unfollow).toHaveBeenCalled();
});

test('effect reconciliation honors the durable read budget without touching a profile or forgetting intent', async () => {
  const f = fixture();
  const intent = f.store.beginEffectIntent({ accountPk: 'old', username: 'old', action: 'follow', channel: 'growth', at: f.clock.now() });
  f.store.markEffectUncertain(intent.id, f.clock.now());
  const readBudget = new ReadBudget({ store: f.store, clock: f.clock, limits: readLimits({ profiles: 1 }) });
  readBudget.consume('profile', 'exploration');
  const profiles: ProfileVisitor = { visit: jest.fn() };
  expect(await reconcileEffects({ store: f.store, clock: f.clock, ownPk: 'me', profiles, readBudget }))
    .toMatchObject({ outcome: 'deferred', remaining: 1, settled: 0, retryAt: f.clock.now() + DAY });
  expect(profiles.visit).not.toHaveBeenCalled();
  expect(f.store.pendingEffectIntents()).toHaveLength(1);
});

test('cached relationship evidence predating the reconciliation visit cannot settle an uncertain effect', async () => {
  const f = fixture();
  const intent = f.store.beginEffectIntent({ accountPk: 'old', username: 'old', action: 'follow', channel: 'growth', at: f.clock.now() });
  f.store.markEffectDispatched(intent.id, f.clock.now());
  const profiles: ProfileVisitor = { visit: async () => ({ ok: true,
    obs: { accountPk: 'old', observedAt: f.clock.now() - 1, source: 'profile', fields: { username: 'old' } },
    viewer: { following: true, requested: false, followsUs: false },
  }) };
  expect(await reconcileEffects({ store: f.store, clock: f.clock, ownPk: 'me', profiles }))
    .toMatchObject({ outcome: 'failed', remaining: 1 });
  expect(f.store.getEdge('me', 'old', 'follows')).toBeNull();
});

test('a paced acceptance backlog ends a sweep without an absence verdict; the next sweep records the accepted one', async () => {
  const f = fixture();
  for (const accountPk of ['old', 'new']) f.store.upsertFollowRecord({ accountPk, targetPk: 'hub',
    state: 'pending_followback', followedAt: START, retryCount: 0 });
  let round = 0;
  const census = jest.fn(async () => ({ pks: ['old', 'new'], complete: true, authoritative: true }));
  const followback = new FollowbackWatcher({ store: f.store, clock: f.clock, ownPk: 'me', notifications: {
    fetchRecent: async () => {
      round++;
      return { ok: true, events: [], accepted: [{ pk: round === 1 ? 'old' : 'new', username: round === 1 ? 'old' : 'new' }],
        pendingRequestPks: round === 1 ? ['old', 'new'] : [], retryAt: f.clock.now() + 180_000 };
    },
  }, followers: { fetchAllPks: census } });
  const engine = f.make(followback);
  expect(await engine.stepOnce()).toBe('idle');
  expect(f.store.getFollowRecord('old')?.state).toBe('followed_back');
  // Queued for the click, which returns request-pending on the fresh flag (and records the request edge).
  expect(f.store.getFollowRecord('new')?.state).toBe('unfollow_queued');
  expect(f.store.getEdge('new', 'me', 'follows')).toBeNull();
  expect(f.lastSweep()).not.toBeNull();
  expect(census).not.toHaveBeenCalled();
  f.rearmSweep();
  expect(await engine.stepOnce()).toBe('swept-followback');
  expect(f.store.getFollowRecord('new')?.state).toBe('followed_back');
  expect(f.actions.unfollow).not.toHaveBeenCalled();
});

test('an already-following observation cannot spend a return probation action', async () => {
  const f = fixture();
  f.store.upsertFollowRecord({ accountPk: 'old', targetPk: 'hub', state: 'queued', retryCount: 0, score: 1 });
  f.actions.follow.mockImplementation(async () => ({ status: 'ok', alreadyInState: true }));
  const followback = new FollowbackWatcher({ store: f.store, clock: f.clock, ownPk: 'me',
    notifications: { fetchRecent: async () => ({ ok: true, events: [] }) } });
  const engine = f.make(followback);
  expect(await engine.stepOnce()).toBe('swept-followback');
  expect(await engine.stepOnce()).toBe('acted');
  expect(f.store.getFollowRecord('old')?.state).toBe('external');
  expect(f.reentry.snapshot()).toMatchObject({ phase: 'probation', probationActions: 0 });
  expect(f.store.actionCountSince(0)).toBe(0);
});

test('targeted return batches finish a managed cohort without reading the whole follower audience', async () => {
  const f = fixture();
  for (let i = 0; i < 25; i++) {
    const accountPk = `managed${i}`;
    f.store.observe({ accountPk, observedAt: START, source: 'profile', fields: { username: accountPk } });
    f.store.upsertFollowRecord({ accountPk, targetPk: 'hub', state: 'pending_followback', followedAt: START, retryCount: 0 });
  }
  const epoch = f.reentry.snapshot().reconciliationStartedAt;
  const read = jest.fn(async () => ({ ok: true as const, followsUs: false, observedAt: f.clock.now() }));
  const census = jest.fn(async () => ({ pks: [], complete: false, reason: 'read-budget' }));
  const followback = new FollowbackWatcher({ store: f.store, clock: f.clock, ownPk: 'me',
    notifications: { fetchRecent: async () => ({ ok: true, events: [] }) },
    relationships: { read }, followers: { fetchAllPks: census } });
  const engine = f.make(followback);
  expect(await engine.stepOnce()).toBe('idle');
  expect(read).toHaveBeenCalledTimes(10);
  expect(f.reentry.snapshot().reconciliationStartedAt).toBe(epoch);
  expect(f.lastSweep()).toBeNull();
  expect(await engine.stepOnce()).toBe('idle');
  expect(read).toHaveBeenCalledTimes(20);
  expect(await engine.stepOnce()).toBe('swept-followback');
  expect(read).toHaveBeenCalledTimes(25);
  expect(census).not.toHaveBeenCalled();
  expect(f.reentry.snapshot().phase).toBe('probation');
  expect(f.store.activeFollowRecords().every((r) => r.state === 'unfollow_queued')).toBe(true);
});

test('replacing the driver during effect reconciliation stops the entire old batch', async () => {
  const f = fixture();
  for (const accountPk of ['old', 'new']) {
    const intent = f.store.beginEffectIntent({ accountPk, username: accountPk, action: 'follow', channel: 'growth', at: f.clock.now() });
    f.store.markEffectDispatched(intent.id, f.clock.now());
  }
  let token = new AbortController().signal;
  const visit = jest.fn(async (username: string) => {
    token = new AbortController().signal;
    return { ok: true as const, obs: { accountPk: username, observedAt: f.clock.now(), source: 'profile' as const, fields: { username } },
      viewer: { following: true, requested: false, followsUs: false } };
  });
  expect(await reconcileEffects({ store: f.store, clock: f.clock, ownPk: 'me', profiles: { visit }, signal: () => token }))
    .toMatchObject({ outcome: 'deferred', settled: 0, remaining: 2 });
  expect(visit).toHaveBeenCalledTimes(1);
  expect(f.store.getEdge('me', 'old', 'follows')).toBeNull();
});

test('replacing the driver during managed relationship reads cannot continue under the new token', async () => {
  const f = fixture();
  for (const accountPk of ['old', 'new']) f.store.upsertFollowRecord({ accountPk, targetPk: 'hub',
    state: 'pending_followback', followedAt: START, retryCount: 0 });
  let token = new AbortController().signal;
  const read = jest.fn(async () => {
    token = new AbortController().signal;
    return { ok: true as const, followsUs: false, observedAt: f.clock.now() };
  });
  const watcher = new FollowbackWatcher({ store: f.store, clock: f.clock, ownPk: 'me', signal: () => token,
    notifications: { fetchRecent: async () => ({ ok: true, events: [] }) }, relationships: { read } });
  expect(await watcher.check({ requireFresh: true })).toMatchObject({ outcome: 'partial', deferred: 'reconciliation-progress' });
  expect(read).toHaveBeenCalledTimes(1);
  expect(f.store.getEdge('old', 'me', 'follows')).toBeNull();
  expect(f.store.getEdge('new', 'me', 'follows')).toBeNull();
});
