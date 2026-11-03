/**
 * I2 (spec §20.3): a write the plan or the gates refuse spends no read. The preflight runs BEFORE the
 * visit, over the production mutation policy, a real plan and store: the ceiling, a closed session, a
 * spent kind, an owed deadline, probation, this account's journal, a paused surface and paused protection.
 */
import { FollowbackWatcher } from '@/engine/followback-watcher';
import { UNCONFIGURED_PROTECTION } from '@/engine/protection-port';
import { ReadBudget } from '@/governors/read-budget';
import { createMutationPolicy } from '@/main/services/mutation-policy';
import type { PlanWiring } from '@/main/services/plan-wiring';
import type { ProfileVisit } from '@/rim/profile-visit-port';
import { DEFAULT_SETTINGS, type Settings } from '@/settings/settings';
import type { SurfaceGate } from '@/shared/surface-gate';
import { compileProtection, type ProtectionIndex } from '@/shared/unfollow-protection';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { fakePlanHost, idealDay, PLAN_TEST_RNG, type PlanClock, planClock, storePlanWiring } from '../kit/harness-plan';
import { readLimits } from '../kit/read-limits';
import { openTestStore } from '../kit/store';

const FROM = Date.parse('2026-11-09T12:00:00');
const open: { plan: PlanWiring; store: KnowledgeStore }[] = [];
afterEach(() => {
  while (open.length > 0) {
    const o = open.pop();
    o?.plan.dispose();
    o?.store.close();
  }
});

interface Rig {
  store: KnowledgeStore;
  clock: PlanClock;
  plan: PlanWiring;
  reads: ReadBudget;
  visit: jest.Mock<Promise<ProfileVisit>, [string]>;
  policy: ReturnType<typeof createMutationPolicy>;
}

/** The policy over a plan whose clock stands at the busy day's first kept session; `before` seeds the store first. */
function rig(o: { settings?: Partial<Settings>; before?: (store: KnowledgeStore, at: number) => void;
  gate?: SurfaceGate; protection?: ProtectionIndex } = {}): Rig {
  const settings = { ...DEFAULT_SETTINGS, dryRun: false, ...o.settings };
  const day = idealDay(FROM, 3, settings);
  const first = day.plan.sessions.find((s) => s.budget > 0);
  if (first === undefined) throw new Error('no kept session');
  const store = openTestStore(':memory:', { rng: PLAN_TEST_RNG });
  store.setOwnPk('me');
  const clock = planClock(first.startAt);
  o.before?.(store, clock.now());
  const plan = storePlanWiring(store, clock, fakePlanHost(settings));
  open.push({ plan, store });
  const reads = new ReadBudget({ store, clock, limits: readLimits() });
  const visit = jest.fn(async (username: string): Promise<ProfileVisit> => ({ ok: true,
    obs: { accountPk: 'a', observedAt: clock.now(), source: 'profile', fields: { username, followers: 500, following: 500 } },
    viewer: { following: true, requested: false, followsUs: false } }));
  const policy = createMutationPolicy({ store, clock, ownPk: 'me', ownUsername: 'me', cadence: plan.cadence, readBudget: reads,
    profiles: () => ({ visit }), settings: () => settings, protection: () => o.protection ?? UNCONFIGURED_PROTECTION,
    signal: () => undefined, surfaceGate: o.gate,
    followback: () => new FollowbackWatcher({ store, clock, ownPk: 'me', notifications: { fetchRecent: async () => ({ ok: true, events: [] }) } }) });
  return { store, clock, plan, reads, visit, policy };
}

const write = (store: KnowledgeStore, pk: string, at: number, action: 'follow' | 'unfollow' = 'follow') => {
  const i = store.beginEffectIntent({ accountPk: pk, username: pk, action, channel: 'growth', at });
  store.markEffectDispatched(i.id, at);
  store.settleEffectIntent(i.id, { at, result: 'ok', ledger: 'growth' });
};
const due = (store: KnowledgeStore, at: number) => store.upsertFollowRecord({ accountPk: 'a', targetPk: 'seed',
  state: 'unfollow_queued', retryCount: 0, followedAt: at - 7 * 86_400_000 });

/** The refusal reached before the visit: no profile was read and no read was debited. */
async function refusedWithoutReading(r: Rig, action: 'follow' | 'unfollow', reason: string | { kind: string }): Promise<void> {
  const shape = typeof reason === 'string' ? { reason } : { verdict: reason };
  await expect(r.policy.prepareProfile('alice', 'a', action)).rejects.toMatchObject(shape);
  expect(r.visit).not.toHaveBeenCalled();
  expect(r.reads.snapshot().debits).toEqual([]);
}

describe('I2 — zero reads on refused mutations', () => {
  test('the ceiling', async () => {
    const r = rig({ settings: { dailyHardCeiling: 2 }, before: (s, at) => { write(s, 'x', at - 1); write(s, 'y', at - 1); } });
    await refusedWithoutReading(r, 'follow', 'ceiling');
  });

  test('a closed session', async () => {
    const r = rig();
    const v = r.plan.service.view(r.clock.now());
    r.clock.t = (v.sessions[v.open?.idx ?? 0].closesAt ?? 0) + 1;
    await refusedWithoutReading(r, 'follow', 'session-closed');
  });

  test('a spent kind: the day holds no unfollow', async () => {
    const r = rig();
    expect(r.plan.service.view(r.clock.now()).plan.kinds.unfollow).toBe(0);
    await refusedWithoutReading(r, 'unfollow', 'kind-spent');
  });

  test('an owed deadline', async () => {
    const r = rig();
    r.store.setActionDelayDeadline(r.clock.now() + 60_000);
    await refusedWithoutReading(r, 'follow', 'deadline');
  });

  test("probation: the first session after the upgrade runs one caution rung down", async () => {
    // A ledger with no plan_state is an upgrade: the first kept session is a probation session.
    const r = rig({ settings: { hourlyVelocityCap: 5 }, before: (s, at) => {
      for (const pk of ['p', 'q', 'r']) write(s, pk, at - 30 * 60_000);
    } });
    expect(r.plan.service.view(r.clock.now()).open?.probation).toBe(true);
    await refusedWithoutReading(r, 'follow', 'probation');
  });

  test("this account's journal", async () => {
    const r = rig({ before: (s, at) => {
      const i = s.beginEffectIntent({ accountPk: 'a', username: 'alice', action: 'follow', channel: 'growth', at });
      s.markEffectUncertain(i.id, at);
    } });
    await refusedWithoutReading(r, 'follow', 'journal');
  });

  test('the surface gate pauses unfollows', async () => {
    const r = rig({ before: due, gate: { paused: (a) => a === 'unfollows' } });
    await refusedWithoutReading(r, 'unfollow', 'surface-paused');
  });

  test('paused protection', async () => {
    const paused = compileProtection({ accounts: [], words: [], wordMatch: 'anywhere', keepVerified: true }, 'needs-review', 1);
    const r = rig({ before: due, protection: paused });
    await refusedWithoutReading(r, 'unfollow', { kind: 'protection-paused' });
  });

  test('an admitted write reads exactly once, after the preflight', async () => {
    const r = rig();
    await r.policy.prepareProfile('alice', 'a', 'follow');
    expect(r.visit).toHaveBeenCalledTimes(1);
    expect(r.reads.snapshot().debits).toMatchObject([{ kind: 'profile', count: 1, use: 'verify' }]);
  });
});
