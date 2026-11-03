import { ActionAbortedError, ActionDeferredError } from '@/adapter/errors';
import { FollowbackWatcher } from '@/engine/followback-watcher';
import { REENTRY_POLICY, ReentrySupervisor } from '@/engine/reentry';
import { FakeClock } from '@/governors/clock';
import { RateGovernor } from '@/governors/rate-governor';
import { ReadBudget } from '@/governors/read-budget';
import { createMutationPolicy } from '@/main/services/mutation-policy';
import type { ProfileVisit } from '@/rim/profile-visit-port';
import { DEFAULT_SETTINGS, type Settings, toRateGovernorConfig } from '@/settings/settings';
import { KnowledgeStore } from '@/store/knowledge-store';
import { readLimits } from '../kit/read-limits';

let store: KnowledgeStore;
let clock: FakeClock;
let settings: Settings;
let rate: RateGovernor;
let budget: ReadBudget;
let reentry: ReentrySupervisor;
let controller: AbortController;
let identity: boolean;
let reciprocal: boolean | null;
let visit: jest.Mock<Promise<ProfileVisit>, [string]>;

beforeEach(() => {
  store = new KnowledgeStore(':memory:');
  store.setOwnPk('me');
  clock = new FakeClock(Date.UTC(2026, 9, 21, 12));
  settings = { ...DEFAULT_SETTINGS, dryRun: false, hourlyVelocityCap: 20,
    dailyHardCeiling: 100, dailyOperatingRate: 100, activeHoursStart: 0, activeHoursEnd: 0 };
  rate = new RateGovernor(store, clock, toRateGovernorConfig(settings));
  jest.spyOn(rate, 'nextDelayMs').mockReturnValue(1000);
  budget = new ReadBudget({ store, clock, limits: readLimits() });
  reentry = new ReentrySupervisor({ store, clock });
  reentry.prepare();
  controller = new AbortController();
  identity = true;
  reciprocal = false;
  visit = jest.fn(async (username: string): Promise<ProfileVisit> => {
    const obs = { accountPk: username === 'me' ? 'me' : 'a', observedAt: clock.now(), source: 'profile' as const,
      fields: { username, followers: 500, following: 550, bio: 'Ceramic artist' } };
    store.observe(obs);
    return { ok: true, obs, viewer: { following: true, requested: false, followsUs: reciprocal } };
  });
});
afterEach(() => store.close());

function policy() {
  return createMutationPolicy({ store, clock, ownPk: 'me', ownUsername: 'me', rate, reentry, readBudget: budget,
    profiles: () => ({ visit }), settings: () => settings, signal: () => controller.signal,
    validateIdentity: async () => identity,
    followback: () => new FollowbackWatcher({ store, clock, ownPk: 'me',
      notifications: { fetchRecent: async () => ({ ok: true, events: [] }) } }),
  });
}

test.each(['wrong-pk', 'stale', 'future', 'nan'] as const)('fresh target verification rejects %s without relationship evidence', async (kind) => {
  visit.mockResolvedValue({ ok: true, obs: { accountPk: kind === 'wrong-pk' ? 'changed-owner' : 'a', source: 'profile',
    observedAt: kind === 'stale' ? clock.now() - 1 : kind === 'future' ? clock.now() + 1 : kind === 'nan' ? NaN : clock.now(),
    fields: { username: 'alice' } }, viewer: { following: false, requested: false, followsUs: false } });
  await expect(policy().prepareProfile('alice', 'a', 'follow')).rejects.toBeInstanceOf(ActionDeferredError);
  expect(store.getEdge('a', 'me', 'follows')).toBeNull();
});

test('account switch during a profile visit cannot authorize a mutation on the new account', async () => {
  const original = visit.getMockImplementation()!;
  visit.mockImplementation(async (name) => { const seen = await original(name); identity = false; return seen; });
  await expect(policy().prepareProfile('alice', 'a', 'follow')).rejects.toBeInstanceOf(ActionAbortedError);
  expect(store.getEdge('a', 'me', 'follows')).toBeNull();
});

test('an already stopped driver does not spend another profile read', async () => {
  controller.abort();
  await expect(policy().prepareProfile('alice', 'a', 'follow')).rejects.toBeInstanceOf(ActionAbortedError);
  expect(visit).not.toHaveBeenCalled();
  expect(budget.snapshot().debits).toEqual([]);
});

test('queued candidates are rescored against the fresh profile before following', async () => {
  store.upsertFollowRecord({ accountPk: 'a', targetPk: 'seed', state: 'queued', retryCount: 0, score: 2.5 });
  settings.minFollowers = 1000;
  await expect(policy().prepareProfile('alice', 'a', 'follow')).rejects.toThrow('no longer eligible');
  expect(store.getFollowRecord('a')).toMatchObject({ state: 'queued', score: 0 });
});

test.each(['target', 'retained-role'] as const)('%s protection is enforced for every unfollow caller', async (protection) => {
  await visit('alice');
  if (protection === 'target') store.addTarget({ accountPk: 'a', source: 'discovered', status: 'active', chainIndex: 0 });
  else store.setRole('a', 'retained_target');
  await expect(policy().prepareProfile('alice', 'a', 'unfollow')).rejects.toThrow('source is protected');
});

test('unknown reciprocity blocks removal; a newly observed mutual earns a fresh hold', async () => {
  store.upsertFollowRecord({ accountPk: 'a', targetPk: 'seed', state: 'unfollow_queued', retryCount: 0, followedAt: clock.now() - 7 * 86_400_000 });
  reciprocal = null;
  await expect(policy().prepareProfile('alice', 'a', 'unfollow')).rejects.toThrow('unresolved');
  reciprocal = true;
  await expect(policy().prepareProfile('alice', 'a', 'unfollow')).rejects.toThrow('new follow-back requires hold');
  expect(store.getFollowRecord('a')).toMatchObject({ state: 'followed_back', followbackObservedAt: clock.now() });
  expect(store.getFollowRecord('a')?.holdUntil).toBeGreaterThan(clock.now());
  expect(store.getFollowRecord('a')?.followedBackAt).toBeUndefined();
});

test('bio keep policy protects a due mutual, while a confirmed nonfollower can be removed', async () => {
  store.upsertFollowRecord({ accountPk: 'a', targetPk: 'seed', state: 'unfollow_queued', retryCount: 0,
    followedBackAt: clock.now() - 1000, holdUntil: clock.now() - 1 });
  reciprocal = true;
  settings.pruneBioFilterWords = [' ARTIST '];
  await expect(policy().prepareProfile('alice', 'a', 'unfollow')).rejects.toThrow('bio keep policy');
  reciprocal = false;
  await expect(policy().prepareProfile('alice', 'a', 'unfollow')).resolves.toBeUndefined();
});

test('growth, prune and accepted requests share the same hard ceiling', async () => {
  rate.applyConfig({ ...toRateGovernorConfig(settings), dailyHardCeiling: 3 });
  store.recordAction('one', 'follow', 'ok', clock.now());
  store.recordPruneAction('two', 'ok', clock.now());
  const intent = store.beginEffectIntent({ accountPk: 'three', username: 'three', action: 'accept-request', channel: 'accept-request', at: clock.now() });
  store.markEffectDispatched(intent.id, clock.now());
  store.settleEffectIntent(intent.id, { result: 'ok', ledger: 'none', at: clock.now() });
  expect(await policy().canAccept()).toBe(false);
  await expect(policy().beforeMutation()).rejects.toThrow('budget exhausted');
});

test('the shared hourly ceiling and durable action delay also govern request acceptance', async () => {
  settings.hourlyVelocityCap = 1;
  store.recordAction('one', 'follow', 'ok', clock.now());
  expect(await policy().canAccept()).toBe(false);
  clock.advance(3_600_001);
  reentry.noteProgress(clock.now());
  await policy().beforeMutation();
  expect(await policy().canAccept()).toBe(false);
  await expect(policy().beforeMutation()).rejects.toThrow('shared mutation delay');
  clock.advance(1000);
  expect(await policy().canAccept()).toBe(true);
});

test('return reconciliation permits a bounded restorative accept but no new follow or unfollow', async () => {
  clock.advance(7 * 86_400_000);
  reentry.prepare();
  expect(reentry.requiresReconciliation()).toBe(true);
  expect(await policy().canAccept()).toBe(true);
  await expect(policy().beforeMutation()).rejects.toThrow('reconciliation required');
  policy().onAccepted();
  expect(await policy().canAccept()).toBe(false);
  clock.advance(1000);
  reentry.noteReconciled({ outcome: 'complete' }, clock.now());
  reentry.noteAction(clock.now());
  reentry = new ReentrySupervisor({ store, clock });
  expect(await policy().canAccept()).toBe(false);
  await expect(policy().beforeMutation()).rejects.toThrow('probation delay');
  clock.advance(REENTRY_POLICY.probationGapMs);
  await expect(policy().beforeMutation()).resolves.toBeUndefined();
});

test('unsettled dispatched effects block additional acceptance', async () => {
  const intent = store.beginEffectIntent({ accountPk: 'a', username: 'alice', action: 'follow', channel: 'growth', at: clock.now() });
  store.markEffectDispatched(intent.id, clock.now());
  expect(await policy().canAccept()).toBe(false);
});

test.each(['gone', 'wrong-pk', 'stale', 'missing-counts'] as const)('own-header %s cannot certify a census', async (kind) => {
  const original = visit.getMockImplementation()!;
  visit.mockImplementation(async (name): Promise<ProfileVisit> => {
    if (kind === 'gone') return { ok: false, kind: 'gone', detail: {} };
    const seen = await original(name);
    if (!seen.ok) return seen;
    if (kind === 'wrong-pk') seen.obs.accountPk = 'someone-else';
    if (kind === 'stale') seen.obs.observedAt -= 1;
    if (kind === 'missing-counts') delete seen.obs.fields.followers;
    return seen;
  });
  expect(await policy().refreshOwnStats()).toEqual({ ok: false, reason: 'fresh-header-unavailable' });
});

test('own-header success is fresh and budget deferral carries a restart-stable retry time', async () => {
  expect(await policy().refreshOwnStats()).toEqual({ ok: true });
  budget.consume('profile', 'reconciliation', readLimits()().profiles - 1); // the rest of the derived allowance
  const calls = visit.mock.calls.length;
  expect(await policy().refreshOwnStats()).toEqual({ ok: false, reason: 'read-budget', retryAt: clock.now() + 86_400_000 });
  expect(visit).toHaveBeenCalledTimes(calls);
});

test('manual identity resolution spends the same durable profile allowance and refuses after exhaustion', async () => {
  expect(await policy().resolveIdentity('new-person')).toBe('a');
  budget.consume('profile', 'reconciliation', readLimits()().profiles - 1); // the rest of the derived allowance
  expect(await policy().resolveIdentity('another-person')).toBeNull();
  expect(visit).toHaveBeenCalledTimes(1);
});

test('manual identity resolution rejects a result from a replaced driver', async () => {
  const original = visit.getMockImplementation()!;
  visit.mockImplementation(async (name) => { const result = await original(name); controller = new AbortController(); return result; });
  expect(await policy().resolveIdentity('new-person')).toBeNull();
});

test('a replaced profile-read generation cannot alter mutation policy evidence', async () => {
  const original = visit.getMockImplementation()!;
  visit.mockImplementation(async (name) => { const result = await original(name); controller = new AbortController(); return result; });
  await expect(policy().prepareProfile('alice', 'a', 'unfollow')).rejects.toBeInstanceOf(ActionAbortedError);
  expect(store.getEdge('a', 'me', 'follows')).toBeNull();
});
