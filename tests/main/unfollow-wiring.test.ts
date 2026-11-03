/**
 * The unfollow wiring (spec §7): the protection port reads the settings service's index live,
 * the churn scheduler runs on it, and the graph-open pass re-judges the kept records at build.
 */
import type { FollowbackWatcher } from '@/engine/followback-watcher';
import { ReentrySupervisor } from '@/engine/reentry';
import type { SourceFrontier } from '@/engine/source-frontier';
import { FakeClock, type SystemClock } from '@/governors/clock';
import { calendarPlanDayClock } from '@/governors/plan-day-clock';
import { RateGovernor } from '@/governors/rate-governor';
import { ReadBudget } from '@/governors/read-budget';
import type { BuiltGraph, GraphBuildDeps } from '@/main/services/graph-types';
import { unfollowWiringParts, wireChurn, wireMutationPolicy, wireProtection } from '@/main/services/unfollow-wiring';
import type { AdapterBackedChurnActions } from '@/rim/churn-actions';
import type { TabProfileVisitor } from '@/rim/profile-visit';
import type { ProfileVisit, ProfileVisitor } from '@/rim/profile-visit-port';
import { DEFAULT_SETTINGS, toRateGovernorConfig } from '@/settings/settings';
import type { ProtectionSettings } from '@/shared/settings-model';
import { compileProtection } from '@/shared/unfollow-protection';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { FakeActions } from '../kit/engine-harness';
import { readLimits } from '../kit/read-limits';
import { memoryStore } from '../kit/store';

const T0 = Date.parse('2026-11-03T12:00:00');
let store: KnowledgeStore;
let rules: ProtectionSettings;
let rev: number;
beforeEach(() => {
  store = memoryStore();
  store.setOwnPk('me');
  rules = { accounts: [], words: [{ text: 'cafe', addedAt: 0 }], wordMatch: 'anywhere', keepVerified: false };
  rev = 1;
});
afterEach(() => store.close());

const deps = (): GraphBuildDeps => ({
  resolveSettings: () => DEFAULT_SETTINGS,
  protection: { index: () => compileProtection(rules, 'ready', rev), setCapabilities: () => undefined },
}) as unknown as GraphBuildDeps;

/** The kit's plan-day boundary: local midnight over the fake clock (the graph build hands the plan's). */
const dayOf = (clock: FakeClock) => calendarPlanDayClock({ now: () => clock.now() });

const churnFor = (clock: FakeClock) => wireChurn(deps(), {
  frontier: { pickQueued: () => null } as unknown as SourceFrontier, store, clock, rate: {} as RateGovernor,
  churnActions: new FakeActions() as unknown as AdapterBackedChurnActions, ownPk: 'me', settings: DEFAULT_SETTINGS,
  dayClock: dayOf(clock),
});

test('the port reads the settings index live', () => {
  const clock = new FakeClock(T0);
  const { port } = wireProtection(deps(), clock, dayOf(clock));
  expect(port.index().words).toEqual(['cafe']);
  rules = { ...rules, words: [] };
  rev = 2;
  expect(port.index().words).toEqual([]);
});

test('the churn runs on the settings index: a protected record is kept at selection', () => {
  const clock = new FakeClock(T0);
  const churn = churnFor(clock);
  store.observe({ accountPk: '1', observedAt: T0, source: 'profile', fields: { username: 'u1', bio: 'my cafe' } });
  store.upsertFollowRecord({ accountPk: '1', targetPk: null, state: 'pending_followback', retryCount: 0, followedAt: T0 });
  clock.advance(DEFAULT_SETTINGS.maxWaitForFollowbackDays * 86_400_000);
  churn.advanceTimers();
  expect(store.getFollowRecord('1')).toMatchObject({ state: 'kept', keptReason: 'bio-word' });
});

test('building the churn marks protection as wired on every path', () => {
  const setCapabilities = jest.fn();
  wireChurn({ ...deps(), protection: { index: () => compileProtection(rules, 'ready', rev), setCapabilities } } as GraphBuildDeps, {
    frontier: { pickQueued: () => null } as unknown as SourceFrontier, store, clock: new FakeClock(T0), rate: {} as RateGovernor,
    churnActions: new FakeActions() as unknown as AdapterBackedChurnActions, ownPk: 'me', settings: DEFAULT_SETTINGS,
    dayClock: dayOf(new FakeClock(T0)),
  });
  expect(setCapabilities).toHaveBeenCalledWith({ protectionEverywhere: true });
});

test('the unfollowsPaused contributor names a paused index, and nothing before the graph exists', () => {
  const [contributor] = unfollowWiringParts().statusContributors;
  expect(contributor?.name).toBe('unfollowsPaused');
  const graphWith = (state: 'ready' | 'needs-review' | 'unavailable') =>
    ({ churn: { protectionState: () => state } }) as unknown as BuiltGraph;
  expect(contributor?.contribute(graphWith('ready'), T0)).toEqual({ unfollowsPaused: null });
  expect(contributor?.contribute(graphWith('needs-review'), T0)).toEqual({ unfollowsPaused: 'protection-needs-review' });
  expect(contributor?.contribute(graphWith('unavailable'), T0)).toEqual({ unfollowsPaused: 'protection-unavailable' });
  expect(contributor?.contribute(null, T0)).toEqual({});
});

test('the churn reports the live protection state', () => {
  const churn = churnFor(new FakeClock(T0));
  expect(churn.protectionState()).toBe('ready');
});

describe('the wired journal (spec §9.8)', () => {
  const policyFor = (clock: FakeClock, visit: ProfileVisitor['visit']) => {
    const reentry = new ReentrySupervisor({ store, clock });
    reentry.prepare(clock.now());
    const rate = new RateGovernor(store, clock, toRateGovernorConfig(DEFAULT_SETTINGS));
    const policy = wireMutationPolicy({ ...deps(), driverSignal: () => undefined } as GraphBuildDeps, {
      store, ownPk: 'me', ownUsername: 'me', clock: clock as unknown as SystemClock, rate, reentry,
      readBudget: new ReadBudget({ store, clock, limits: readLimits() }), dayClock: dayOf(clock),
      profiles: () => ({ visit }) as unknown as TabProfileVisitor,
      followback: () => ({ check: async () => ({ detected: [], outcome: 'complete' }) }) as unknown as FollowbackWatcher,
    });
    return { policy, reentry };
  };
  const stuck = (pk: string, at: number) => {
    const i = store.beginEffectIntent({ accountPk: pk, username: pk, action: 'unfollow', channel: 'growth', at });
    store.markEffectUncertain(i.id, at);
    return i;
  };

  test('admission has no global block: an absence or another account\'s unsettled write never stops a write', async () => {
    const clock = new FakeClock(T0);
    const { policy, reentry } = policyFor(clock, async () => ({ ok: false, kind: 'tab', detail: {} }));
    stuck('x', clock.now());
    clock.advance(7 * 86_400_000);
    expect(reentry.requiresReconciliation(clock.now())).toBe(true);
    await expect(policy.beforeMutation()).resolves.toBeUndefined();
  });

  test('a standalone write first settles the due journal on the plan-day slots (F6: still following stays queued)', async () => {
    const clock = new FakeClock(T0);
    store.upsertFollowRecord({ accountPk: 'a', targetPk: null, state: 'unfollow_queued', retryCount: 0, followedAt: T0 });
    const i = stuck('a', clock.now());
    const visit = jest.fn(async (username: string): Promise<ProfileVisit> => ({ ok: true,
      obs: { accountPk: 'a', observedAt: clock.now(), source: 'profile', fields: { username } },
      viewer: { following: true, requested: false, followsUs: false } }));
    const { policy } = policyFor(clock, visit);
    await policy.prepareMutation();
    expect(store.getEffectIntent(i.id)).toMatchObject({ state: 'settled', result: 'cancelled' });
    expect(store.getFollowRecord('a')).toMatchObject({ state: 'unfollow_queued', reconciledAt: T0 });
  });
});

test('the graph-open pass cancels the prepared intents an earlier run left, with no read (spec §9.8)', () => {
  const interrupted = store.beginEffectIntent({ accountPk: '1', username: 'u1', action: 'unfollow', channel: 'growth', at: T0 - 1 });
  const open = store.beginEffectIntent({ accountPk: '2', username: 'u2', action: 'unfollow', channel: 'growth', at: T0 - 1 });
  store.markEffectUncertain(open.id, T0 - 1);
  churnFor(new FakeClock(T0));
  expect(store.getEffectIntent(interrupted.id)).toMatchObject({ state: 'settled', result: 'cancelled' });
  expect(store.getEffectIntent(open.id)?.state).toBe('uncertain');
});

test('the graph-open pass releases a record no rule protects anymore', () => {
  store.observe({ accountPk: '1', observedAt: T0, source: 'profile', fields: { username: 'u1', bio: 'photographer' } });
  store.upsertFollowRecord({ accountPk: '1', targetPk: null, state: 'kept', retryCount: 0, followedAt: T0,
    keptReason: 'bio-word', keptMatch: 'cafe', keptAt: T0 });
  churnFor(new FakeClock(T0));
  expect(store.getFollowRecord('1')?.state).toBe('pending_followback');
});
