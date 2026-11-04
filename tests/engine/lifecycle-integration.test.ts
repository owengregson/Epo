import { ChurnScheduler } from '@/engine/churn-scheduler';
import { Engine, type EngineFollowback } from '@/engine/engine';
import { FollowbackWatcher } from '@/engine/followback-watcher';
import { ReentrySupervisor } from '@/engine/reentry';
import { FakeClock } from '@/governors/clock';
import { settleNextIntent } from '@/rim/journal-settlement';
import type { ProfileVisitor } from '@/rim/profile-visit-port';
import { DEFAULT_SETTINGS } from '@/settings/settings';
import { DelayManager } from '@/timing/delay-manager';
import { setLevel } from '@/utils/logger';
import { DEFAULT_CONFIGS } from '../kit/configs';
import { FakeFollowback, kitStore, testDeps } from '../kit/engine-harness';

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
    make: (followback: EngineFollowback, extra: Partial<Parameters<typeof testDeps>[0]> = {}) =>
      new Engine(testDeps({ ...base, churn, reentry, settings, delays, sweepCadence: cadence, followback, ...extra })),
    settler: (profiles: ProfileVisitor) => () => settleNextIntent({ store, profiles, ownPk: 'me', clock,
      readBudget: { consume: () => ({ allowed: true, resumeAt: null }) }, maxRetries: () => 3, signal: () => undefined,
      slots: () => ({ nextSessionAt: null, planDayStartAfter: (k) => clock.now() + k * DAY }) }) };
}

test('graph prepare plus real start preserves week-away reconciliation; no mutation precedes it', async () => {
  const f = fixture();
  f.store.upsertFollowRecord({ accountPk: 'old', targetPk: 'hub', state: 'pending_followback', followedAt: START, retryCount: 0 });
  // The sweep's drawer step hands its dated event to the appliers.
  const watcher = new FollowbackWatcher({ store: f.store, clock: f.clock, ownPk: 'me', cfg: { holdAfterFollowbackMs: 2 * DAY, autoAcceptRequests: true } });
  const followback = new FakeFollowback();
  followback.onRun = async () => watcher.applyEvent({ pk: 'old', username: 'old', atMs: f.clock.now() - 60_000 });
  let stopped = false;
  const engine = f.make(followback, { onStatus: (status) => {
    if (status.lastStep === 'swept-followback' && !stopped) { stopped = true; engine.stop(); }
  } });
  await engine.start();
  expect(followback.checks).toBe(1);
  expect(f.reentry.snapshot()).toMatchObject({ phase: 'probation', absentMs: 7 * DAY });
  expect(f.store.getFollowRecord('old')?.state).toBe('followed_back');
  expect(f.actions.follow).not.toHaveBeenCalled();
  expect(f.actions.unfollow).not.toHaveBeenCalled();
  expect(f.lastSweep()).not.toBeNull();
});

test('a failed notification read ends its sweep only: the return phase stays and the queued unfollow goes on', async () => {
  const f = fixture();
  f.store.upsertFollowRecord({ accountPk: 'old', targetPk: 'hub', state: 'unfollow_queued', followedAt: START, retryCount: 0 });
  // A sweep whose drawer step failed still ends: the failure ends that step only (spec §9.12).
  const engine = f.make(new FakeFollowback());
  expect(await engine.stepOnce()).toBe('swept-followback');
  expect(f.lastSweep()).not.toBeNull();
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
  const followback = new FakeFollowback();
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

test('cleanup obligations survive source rotation; the plan mix (not the churn) shares the session with follows', async () => {
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
  // The reclaimed slots stay first; each kind's best is asked for separately by the plan's mix (spec §5.7).
  expect(f.churn.nextDue()?.accountPk).toBe('u3');
  expect(f.churn.nextDue(f.clock.now(), 'follow')?.accountPk).toBe('new');
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
  const sweep = new FakeFollowback();
  const engine = f.make(sweep, { settleJournal: f.settler(profiles) });
  expect(await engine.stepOnce()).toBe('swept-followback');
  expect(profiles.visit).toHaveBeenCalledTimes(1);
  expect(await engine.stepOnce()).toBe('swept-followback');
  expect(profiles.visit).toHaveBeenCalledTimes(2);
  expect(sweep.checks).toBe(0);
  // Both unreadable intents parked to their next re-check; the sweep is never wedged behind them.
  expect(await engine.stepOnce()).toBe('swept-followback');
  expect(sweep.checks).toBe(1);
  expect(profiles.visit).not.toHaveBeenCalledWith('hub');
  expect(engine.status().state).not.toBe('halted');
  expect(f.store.pendingEffectIntents().map((i) => [i.accountPk, i.attempts]).sort()).toEqual([['hub', 0], ['new', 1], ['old', 1]]);
});

test('a notification-budget pause ends its sweep without escalation or a halt, and never gates growth', async () => {
  const f = fixture();
  f.store.upsertFollowRecord({ accountPk: 'old', targetPk: 'hub', state: 'pending_followback', followedAt: START, retryCount: 0 });
  // The drawer's budget was refused: the step ends, the sweep ends, nothing waits on it.
  const sweep = new FakeFollowback();
  const engine = f.make(sweep);
  expect(await engine.stepOnce()).toBe('swept-followback');
  expect(f.lastSweep()).not.toBeNull();
  for (let i = 0; i < 5; i++) {
    await engine.stepOnce();
    expect(engine.status().state).not.toBe('halted');
  }
  // One read per sweep; the queued unfollow went on (the click verifies it, spec §9.7).
  expect(sweep.checks).toBe(1);
  expect(f.actions.unfollow).toHaveBeenCalled();
});

test('an already-following observation cannot spend a return probation action', async () => {
  const f = fixture();
  f.store.upsertFollowRecord({ accountPk: 'old', targetPk: 'hub', state: 'queued', retryCount: 0, score: 1 });
  f.actions.follow.mockImplementation(async () => ({ status: 'ok', alreadyInState: true }));
  const followback = new FakeFollowback();
  const engine = f.make(followback);
  expect(await engine.stepOnce()).toBe('swept-followback');
  expect(await engine.stepOnce()).toBe('acted');
  expect(f.store.getFollowRecord('old')?.state).toBe('external');
  expect(f.reentry.snapshot()).toMatchObject({ phase: 'probation', probationActions: 0 });
  expect(f.store.actionCountSince(0)).toBe(0);
});

