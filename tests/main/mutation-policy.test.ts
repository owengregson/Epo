import { ActionAbortedError } from '@/adapter/errors';
import { FollowbackWatcher } from '@/engine/followback-watcher';
import { UNCONFIGURED_PROTECTION } from '@/engine/protection-port';
import { ReadBudget } from '@/governors/read-budget';
import { createMutationPolicy } from '@/main/services/mutation-policy';
import type { ProfileVisit } from '@/rim/profile-visit-port';
import { DEFAULT_SETTINGS, type Settings } from '@/settings/settings';
import { compileProtection, type ProtectionIndex } from '@/shared/unfollow-protection';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { type PlanClock, type SessionPlanRig, sessionPlanRig } from '../kit/harness-plan';
import { readLimits } from '../kit/read-limits';

let rig: SessionPlanRig;
let store: KnowledgeStore;
let clock: PlanClock;
let settings: Settings;
let budget: ReadBudget;
let controller: AbortController;
let identity: boolean;
let reciprocal: boolean | null;
let visit: jest.Mock<Promise<ProfileVisit>, [string]>;
let protection: ProtectionIndex;

/** A plan inside an open session over `over` settings: the store, clock and settings every test reads. */
function plan(over: Partial<Settings> = {}): void {
  rig?.dispose();
  settings = { ...DEFAULT_SETTINGS, dryRun: false, ...over };
  rig = sessionPlanRig(settings);
  store = rig.store;
  clock = rig.clock;
  budget = new ReadBudget({ store, clock, limits: readLimits() });
}

beforeEach(() => {
  protection = UNCONFIGURED_PROTECTION;
  plan();
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
afterEach(() => rig.dispose());

function policy() {
  return createMutationPolicy({ store, clock, ownPk: 'me', ownUsername: 'me', cadence: rig.plan.cadence, readBudget: budget,
    profiles: () => ({ visit }), settings: () => settings, protection: () => protection, signal: () => controller.signal,
    validateIdentity: async () => identity,
    followback: () => new FollowbackWatcher({ store, clock, ownPk: 'me',
      cfg: { holdAfterFollowbackMs: 0, autoAcceptRequests: false } }),
  });
}

/** The profile reads an account may spend outside the click's verify reserve (spec §5.8). */
const nonVerifyRoom = (): number => readLimits()().profiles - readLimits()().verifyReserve;

/** An unfollow record the plan's demand counts: the day's kinds re-derive with it (the census re-plan). */
function queued(over: Partial<Parameters<KnowledgeStore['upsertFollowRecord']>[0]> = {}): void {
  store.upsertFollowRecord({ accountPk: 'a', targetPk: 'seed', state: 'unfollow_queued', retryCount: 0,
    followedAt: clock.now() - 7 * 86_400_000, ...over });
  rig.plan.demandChanged();
  // Click-review cases need the session allocation as well as the day's unfollow demand.
  const session = rig.plan.service.view(clock.now()).plan.sessions.find((s) => s.startAt >= clock.now() && s.mix.unfollow > 0);
  if (session === undefined) throw new Error('the mutation-policy fixture has no allocated unfollow session');
  clock.t = session.startAt;
}

test.each(['wrong-pk', 'stale', 'future', 'nan'] as const)('fresh target verification rejects %s without relationship evidence', async (kind) => {
  visit.mockResolvedValue({ ok: true, obs: { accountPk: kind === 'wrong-pk' ? 'changed-owner' : 'a', source: 'profile',
    observedAt: kind === 'stale' ? clock.now() - 1 : kind === 'future' ? clock.now() + 1 : kind === 'nan' ? NaN : clock.now(),
    fields: { username: 'alice' } }, viewer: { following: false, requested: false, followsUs: false } });
  // A consuming verdict (spec §9.7 steps 2 and 4): the record parks instead of re-offering the same visit.
  await expect(policy().prepareProfile('alice', 'a', 'follow')).rejects.toMatchObject({
    verdict: { kind: 'unavailable', evidence: kind === 'wrong-pk' ? 'renamed' : 'unreadable' } });
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

test.each(['target', 'retained-role'] as const)('%s protection is enforced for every unfollow caller', async (kind) => {
  queued();
  await visit('alice');
  if (kind === 'target') store.addTarget({ accountPk: 'a', source: 'discovered', status: 'active', chainIndex: 0 });
  else store.setRole('a', 'retained_target');
  // A consuming verdict (spec §7.1), no longer a deferral that re-offers the same unfollow.
  await expect(policy().prepareProfile('alice', 'a', 'unfollow'))
    .rejects.toMatchObject({ verdict: { kind: 'protected', by: 'source', match: 'a' } });
});

test('unknown reciprocity blocks removal; a newly observed mutual is re-held by the churn', async () => {
  queued();
  reciprocal = null;
  await expect(policy().prepareProfile('alice', 'a', 'unfollow'))
    .rejects.toMatchObject({ verdict: { kind: 'unavailable', evidence: 'unreadable' } });
  reciprocal = true;
  // The verdict consumes the work; the churn's applyClickVerdict writes the hold (spec §9.7).
  await expect(policy().prepareProfile('alice', 'a', 'unfollow')).rejects.toMatchObject({ verdict: { kind: 'reheld' } });
  expect(store.getFollowRecord('a')?.state).toBe('unfollow_queued');
});

test('bio words protect at the click whether or not they follow back; without them a non-follower goes', async () => {
  queued({ followedBackAt: clock.now() - 1000, holdUntil: clock.now() - 1 });
  protection = compileProtection({ accounts: [], words: [{ text: ' ARTIST ', addedAt: 0 }], wordMatch: 'anywhere',
    keepVerified: false }, 'ready', 1);
  const kept = { verdict: { kind: 'protected', by: 'bio-word', match: 'artist' } };
  reciprocal = true;
  await expect(policy().prepareProfile('alice', 'a', 'unfollow')).rejects.toMatchObject(kept);
  reciprocal = false;
  await expect(policy().prepareProfile('alice', 'a', 'unfollow')).rejects.toMatchObject(kept);
  protection = UNCONFIGURED_PROTECTION;
  await expect(policy().prepareProfile('alice', 'a', 'unfollow')).resolves.toBeUndefined();
});

test('growth, prune and accepted requests share the plan ceiling; a refused write spends no read', async () => {
  plan({ dailyHardCeiling: 3 });
  store.recordAction('one', 'follow', 'ok', clock.now());
  store.recordPruneAction('two', 'ok', clock.now());
  const intent = store.beginEffectIntent({ accountPk: 'three', username: 'three', action: 'accept-request', channel: 'accept-request', at: clock.now() });
  store.markEffectDispatched(intent.id, clock.now());
  store.settleEffectIntent(intent.id, { result: 'ok', ledger: 'none', at: clock.now() });
  expect(await policy().canAccept()).toBe(false);
  await expect(policy().prepareProfile('alice', 'a', 'follow')).rejects.toMatchObject({ reason: 'ceiling' });
  await expect(policy().beforeMutation()).rejects.toMatchObject({ reason: 'ceiling' });
  expect(visit).not.toHaveBeenCalled();
  expect(budget.snapshot().debits).toEqual([]);
});

test('the deadline armed at dispatch refuses the next write before its visit, then admits it once served', async () => {
  const p = policy();
  await p.prepareProfile('alice', 'a', 'follow');
  await p.beforeMutation();
  const owed = store.getActionDelayDeadline() ?? 0;
  expect(owed).toBeGreaterThan(clock.now());
  expect(await p.canAccept()).toBe(false);
  const visits = visit.mock.calls.length;
  await expect(p.prepareProfile('alice', 'a', 'follow')).rejects.toMatchObject({ reason: 'deadline', until: owed });
  expect(visit).toHaveBeenCalledTimes(visits);
  clock.t = owed;
  await expect(p.prepareProfile('alice', 'a', 'follow')).resolves.toBeUndefined();
});

test('the hourly cap governs request acceptance with the other writes (the trailing hour stays under H − 1)', async () => {
  plan({ hourlyVelocityCap: 5 });
  for (const pk of ['one', 'two', 'three', 'four']) store.recordAction(pk, 'follow', 'ok', clock.now() - 3_540_000);
  expect(await policy().canAccept()).toBe(false);
  clock.advance(60_001);
  expect(await policy().canAccept()).toBe(true);
});

test("an account's own unsettled write refuses only its next write, before the visit; accepts and others proceed", async () => {
  const intent = store.beginEffectIntent({ accountPk: 'a', username: 'alice', action: 'follow', channel: 'growth', at: clock.now() });
  store.markEffectDispatched(intent.id, clock.now());
  await expect(policy().prepareProfile('alice', 'a', 'follow')).rejects.toMatchObject({ reason: 'journal' });
  expect(visit).not.toHaveBeenCalled();
  expect(await policy().canAccept()).toBe(true);
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
  expect(await policy().refreshOwnStats()).toMatchObject({ ok: true, header: { followers: 500, following: 550 } });
  budget.consume('profile', 'reconciliation', nonVerifyRoom() - 1); // the rest of the room outside the verify reserve
  const calls = visit.mock.calls.length;
  expect(await policy().refreshOwnStats()).toEqual({ ok: false, reason: 'read-budget', retryAt: clock.now() + 86_400_000 });
  expect(visit).toHaveBeenCalledTimes(calls);
});

test('manual identity resolution spends the same durable profile allowance and refuses after exhaustion', async () => {
  expect(await policy().resolveIdentity('new-person')).toBe('a');
  budget.consume('profile', 'reconciliation', nonVerifyRoom() - 1); // the rest of the room outside the verify reserve
  expect(await policy().resolveIdentity('another-person')).toBeNull();
  expect(visit).toHaveBeenCalledTimes(1);
});

test('manual identity resolution rejects a result from a replaced driver', async () => {
  const original = visit.getMockImplementation()!;
  visit.mockImplementation(async (name) => { const result = await original(name); controller = new AbortController(); return result; });
  expect(await policy().resolveIdentity('new-person')).toBeNull();
});

test('a replaced profile-read generation cannot alter mutation policy evidence', async () => {
  queued();
  const original = visit.getMockImplementation()!;
  visit.mockImplementation(async (name) => { const result = await original(name); controller = new AbortController(); return result; });
  await expect(policy().prepareProfile('alice', 'a', 'unfollow')).rejects.toBeInstanceOf(ActionAbortedError);
  expect(store.getEdge('a', 'me', 'follows')).toBeNull();
});


test.each(['catch-up', 'check'] as const)('the sweep own-header visit debits its %s bucket and anchors the own pk', async (use) => {
  expect(await policy().refreshOwnStats(use)).toMatchObject({ ok: true });
  expect(budget.snapshot().debits.at(-1)).toMatchObject({ use });
  expect(visit).toHaveBeenCalledWith('me', { pk: 'me' });
});
