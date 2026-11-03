/**
 * Checkpoint (spec §20.3, green from UD-b through RO-b): a due lifecycle unfollow executes end to end and no
 * reconcile phase wedges admission, over the production unfollow wiring, a real store, a fake clock and a fake tab.
 */
import { prepareAction } from '@/adapter/action-admission';
import { ActionDeferredError } from '@/adapter/errors';
import { SURFACE } from '@/adapter/ig-surface';
import type { InstagramAdapter } from '@/adapter/instagram-adapter';
import { Engine } from '@/engine/engine';
import { FollowbackWatcher } from '@/engine/followback-watcher';
import { UNCONFIGURED_PROTECTION } from '@/engine/protection-port';
import { ReentrySupervisor } from '@/engine/reentry';
import type { SourceFrontier } from '@/engine/source-frontier';
import { FakeClock, type SystemClock } from '@/governors/clock';
import { RateGovernor } from '@/governors/rate-governor';
import { ReadBudget } from '@/governors/read-budget';
import type { GraphBuildDeps } from '@/main/services/graph-types';
import { journalSettler, wireChurn, wireMutationPolicy } from '@/main/services/unfollow-wiring';
import { AdapterBackedChurnActions } from '@/rim/churn-actions';
import type { TabProfileVisitor } from '@/rim/profile-visit';
import type { ProfileVisit } from '@/rim/profile-visit-port';
import { DEFAULT_SETTINGS, toRateGovernorConfig } from '@/settings/settings';
import { DelayManager } from '@/timing/delay-manager';
import { setLevel } from '@/utils/logger';
import { ok } from '@/utils/result';
import { FakeSentinel, kitStore, testDeps } from '../kit/engine-harness';
import { readLimits } from '../kit/read-limits';

const DAY = 86_400_000;
const START = Date.UTC(2026, 10, 1, 12);

/** Pages by username: a readable non-follower, a deleted account, or an unanswered one. */
type Page = 'non-follower' | 'gone' | 'unreadable';

/** The production unfollow composition after a week away, with a follow-back read that keeps failing. */
function rig(accounts: Record<string, { pk: string; page: Page; record?: boolean }>) {
  setLevel('error');
  const store = kitStore();
  store.setOwnPk('me');
  const clock = new FakeClock(START);
  const settings = { ...DEFAULT_SETTINGS, seed: 'hub', lowWaterCandidates: 0, activeHoursStart: 0, activeHoursEnd: 24 };
  store.observe({ accountPk: 'hub', observedAt: START, source: 'profile', fields: { username: 'hub', followers: 200, following: 200 } });
  store.addTarget({ accountPk: 'hub', source: 'seed', status: 'active', chainIndex: 0 });
  Object.entries(accounts).forEach(([username, a], i) => {
    store.observe({ accountPk: a.pk, observedAt: START, source: 'profile', fields: { username, followers: 200, following: 200 } });
    if (a.record) store.upsertFollowRecord({ accountPk: a.pk, targetPk: 'hub', state: 'pending_followback', followedAt: START + i, retryCount: 0 });
  });
  new ReentrySupervisor({ store, clock }).prepare(START);
  clock.advance(9 * DAY);
  const reentry = new ReentrySupervisor({ store, clock });
  reentry.prepare(clock.now());

  let url = '';
  const visit = jest.fn(async (username: string): Promise<ProfileVisit> => {
    url = SURFACE.profileUrl(username);
    const a = accounts[username];
    if (a === undefined || a.page !== 'non-follower') return { ok: false, kind: a?.page === 'gone' ? 'gone' : 'unanswered', detail: {} };
    return { ok: true, obs: { accountPk: a.pk, observedAt: clock.now(), source: 'profile', fields: { username } },
      viewer: { following: true, requested: false, followsUs: false } };
  });
  const d = { resolveSettings: () => settings, driverSignal: () => undefined,
    protection: { index: () => UNCONFIGURED_PROTECTION, setCapabilities: () => undefined } } as unknown as GraphBuildDeps;
  const rate = new RateGovernor(store, clock, toRateGovernorConfig(settings));
  const readBudget = new ReadBudget({ store, clock, limits: readLimits() });
  const profiles = { visit } as unknown as TabProfileVisitor;
  const followback = new FollowbackWatcher({ store, clock, ownPk: 'me',
    notifications: { fetchRecent: async () => ({ ok: false, events: [] }) } });
  const policy = wireMutationPolicy(d, { store, ownPk: 'me', ownUsername: 'me', clock: clock as unknown as SystemClock,
    rate, reentry, readBudget, profiles: () => profiles, followback: () => followback });
  const presses: string[] = [];
  const tab = { currentUrl: () => url, goto: async (to: string) => { url = to; } };
  const actor = {
    follow: async () => ok({ clicked: true }),
    unfollow: async (username: string, expectedPk?: string, onDispatch?: () => void) => {
      const dispatch = await prepareAction({ tab: tab as never, prepareProfile: policy.prepareProfile,
        beforeMutation: policy.beforeMutation, abortSignal: () => undefined }, 'unfollow', username, expectedPk, onDispatch);
      await dispatch();
      presses.push(username);
      return ok({ clicked: true });
    },
  };
  const adapter = { sentinel: new FakeSentinel(), actor } as unknown as InstagramAdapter;
  const churnActions = new AdapterBackedChurnActions({ adapter, store, ownPk: 'me', dryRun: false, clock });
  const churn = wireChurn(d, { frontier: { pickQueued: () => null } as unknown as SourceFrontier, store,
    clock: clock as unknown as SystemClock, rate, churnActions, ownPk: 'me', settings });
  const engine = new Engine(testDeps({ store, clock, rate, churn, reentry, followback, settings,
    delays: new DelayManager({ clock, sleep: async (ms) => { clock.advance(ms); } }),
    settleJournal: journalSettler(d, { store, profiles, ownPk: 'me', clock, readBudget }) }));
  const stepUntilPressed = async (n: number, maxSteps = 10): Promise<void> => {
    for (let step = 0; step < maxSteps && presses.length < n; step++) await engine.stepOnce();
  };
  return { store, clock, reentry, visit, presses, engine, stepUntilPressed, policy, tab };
}

test('a due lifecycle unfollow executes end to end while the return phase, a failing sweep and a stuck write all persist', async () => {
  const r = rig({ alice: { pk: 'a', page: 'non-follower', record: true }, xavier: { pk: 'x', page: 'unreadable' } });
  const stuck = r.store.beginEffectIntent({ accountPk: 'x', username: 'xavier', action: 'unfollow', channel: 'manual', at: r.clock.now() });
  r.store.markEffectUncertain(stuck.id, r.clock.now());
  await r.stepUntilPressed(1);
  expect(r.presses).toEqual(['alice']);
  expect(r.store.getFollowRecord('a')?.state).toBe('unfollowed');
  expect(r.store.getEdge('me', 'a', 'follows')?.status).toBe('removed');
  expect(r.engine.status().state).not.toBe('halted');
  // The conditions that used to wedge admission are all still there.
  expect(r.reentry.requiresReconciliation(r.clock.now())).toBe(true);
  expect(r.store.getEffectIntent(stuck.id)).toMatchObject({ state: 'uncertain', attempts: 1 });
  expect(r.visit.mock.calls.map(([name]) => name)).toEqual(['xavier', 'alice']);
});

test('on proceed the dispatch closure admits once; a refusal there marks no dispatch, so nothing is pressed', async () => {
  const r = rig({ alice: { pk: 'a', page: 'non-follower', record: true } });
  r.store.setActionDelayDeadline(r.clock.now() + 60_000);
  const onDispatch = jest.fn();
  const dispatch = await prepareAction({ tab: r.tab as never, prepareProfile: r.policy.prepareProfile,
    beforeMutation: r.policy.beforeMutation, abortSignal: () => undefined }, 'unfollow', 'alice', 'a', onDispatch);
  expect(r.visit).toHaveBeenCalledWith('alice');
  await expect(dispatch()).rejects.toBeInstanceOf(ActionDeferredError);
  expect(onDispatch).not.toHaveBeenCalled();
  r.store.setActionDelayDeadline(null);
  await dispatch();
  expect(onDispatch).toHaveBeenCalledTimes(1);
});

test('I5: a deleted account at the queue head parks to a new plan-day and the next record proceeds', async () => {
  const r = rig({ deleted: { pk: 'd', page: 'gone', record: true }, bob: { pk: 'b', page: 'non-follower', record: true } });
  await r.stepUntilPressed(1);
  expect(r.presses).toEqual(['bob']);
  expect(r.store.getFollowRecord('d')).toMatchObject({ state: 'unfollow_queued', parkReason: 'unreachable', checkFailures: 1 });
  expect(r.store.getFollowRecord('d')?.recheckAt).toBeGreaterThan(r.clock.now());
  expect(r.store.getFollowRecord('b')?.state).toBe('unfollowed');
  expect(r.visit.mock.calls.map(([name]) => name)).toEqual(['deleted', 'bob']);
});
