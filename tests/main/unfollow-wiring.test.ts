/**
 * The unfollow wiring (spec §7): the protection port reads the settings service's index live,
 * the churn scheduler runs on it, and the graph-open pass re-judges the kept records at build.
 */
import type { SourceFrontier } from '@/engine/source-frontier';
import { FakeClock } from '@/governors/clock';
import type { RateGovernor } from '@/governors/rate-governor';
import type { BuiltGraph, GraphBuildDeps } from '@/main/services/graph-types';
import { unfollowWiringParts, wireChurn, wireProtection } from '@/main/services/unfollow-wiring';
import type { AdapterBackedChurnActions } from '@/rim/churn-actions';
import { DEFAULT_SETTINGS } from '@/settings/settings';
import type { ProtectionSettings } from '@/shared/settings-model';
import { compileProtection } from '@/shared/unfollow-protection';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { FakeActions } from '../kit/engine-harness';
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

const churnFor = (clock: FakeClock) => wireChurn(deps(), {
  frontier: { pickQueued: () => null } as unknown as SourceFrontier, store, clock, rate: {} as RateGovernor,
  churnActions: new FakeActions() as unknown as AdapterBackedChurnActions, ownPk: 'me', settings: DEFAULT_SETTINGS,
});

test('the port reads the settings index live', () => {
  const { port } = wireProtection(deps(), new FakeClock(T0));
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

test('the graph-open pass releases a record no rule protects anymore', () => {
  store.observe({ accountPk: '1', observedAt: T0, source: 'profile', fields: { username: 'u1', bio: 'photographer' } });
  store.upsertFollowRecord({ accountPk: '1', targetPk: null, state: 'kept', retryCount: 0, followedAt: T0,
    keptReason: 'bio-word', keptMatch: 'cafe', keptAt: T0 });
  churnFor(new FakeClock(T0));
  expect(store.getFollowRecord('1')?.state).toBe('pending_followback');
});
