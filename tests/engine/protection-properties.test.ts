/**
 * Properties P-PROT-1…5 (spec §20.1, G4): no non-clear verdict ever yields an unfollow on P1–P7, P9,
 * P10; a protected or unknown head never blocks a queued follow; at most one visit per unreadable
 * record per re-check window; a paused index emits no unfollow while follows continue; mutuals kept
 * never queue P2. The fake click judges the fresh fields exactly as the click review does.
 */
import fc from 'fast-check';
import { ChurnScheduler } from '@/engine/churn-scheduler';
import type { Facts, RunCtx } from '@/engine/facts';
import { freshSubject, selectionVerdict } from '@/engine/protection-gate';
import { ProtectionReconciler } from '@/engine/protection-reconciler';
import { PruneEngine } from '@/engine/prune-engine';
import { PRUNE_RULES } from '@/engine/rules-prune';
import { FakeClock } from '@/governors/clock';
import { calendarPlanDayClock } from '@/governors/plan-day-clock';
import { RateGovernor } from '@/governors/rate-governor';
import { keptRecheckPlanDays } from '@/kernel/derive-parks';
import { type ClickVerdict, protectionClickVerdict } from '@/shared/click-verdict';
import { type ProtectionVerdict, protectionVerdict } from '@/shared/unfollow-protection';
import type { KnowledgeStore } from '@/store/knowledge-store';
import type { AccountFields, FollowState } from '@/store/types';
import { MS_PER_DAY, MS_PER_HOUR } from '@/timing/units';
import { DEFAULT_CONFIGS } from '../kit/configs';
import {
  FakeActions, FakeListSource, FakePruneActions, FakeSentinel, kitStore, OWN_PK, PRUNE_CFG, T0,
} from '../kit/engine-harness';
import { ProtectionRig } from '../kit/harness-journal';

const WAIT = MS_PER_HOUR;
const PKS = ['1', '2', '3', '4', '5'];
type Facts4 = Pick<AccountFields, 'bio' | 'isVerified'>;

const factsArb: fc.Arbitrary<Facts4> = fc.record({
  bio: fc.constantFrom(undefined, '', 'cafe owner', 'photographer', 'dog mom'),
  isVerified: fc.constantFrom(undefined, true, false),
}, { requiredKeys: [] });
const rulesArb = fc.record({
  words: fc.subarray(['cafe', 'dog']),
  keepVerified: fc.boolean(),
  people: fc.subarray(PKS),
  paused: fc.constantFrom(false, false, false, true),
});
type Rules = { words: string[]; keepVerified: boolean; people: string[]; paused: boolean };

function applyRules(rig: ProtectionRig, r: Rules): void {
  if (r.words.length > 0) rig.words(...r.words);
  rig.verified(r.keepVerified);
  for (const pk of r.people) rig.account(pk, `user${pk}`);
  if (r.paused) rig.pause('needs-review');
}

/** The click review's protection steps over THIS body's fields (fail-closed when paused). */
function clickVerdict(rig: ProtectionRig, pk: string, fields: Facts4, now: number): ClickVerdict | null {
  const obs = { accountPk: pk, observedAt: now, source: 'profile' as const, fields: { username: `user${pk}`, ...fields } };
  return protectionClickVerdict(protectionVerdict(freshSubject(obs, `user${pk}`), rig.port.index()));
}

const observe = (store: KnowledgeStore, pk: string, fields: Facts4): void =>
  store.observe({ accountPk: pk, observedAt: T0 - 1, source: 'profile', fields: { username: `user${pk}`, ...fields } });

/** A churn over a protection rig whose fake click judges the fresh fields; records every press. */
function churnRig(r: Rules, fresh: Map<string, Facts4>, rotateMutuals = true) {
  const store = kitStore();
  const clock = new FakeClock(T0);
  const rig = new ProtectionRig(clock);
  applyRules(rig, r);
  const rate = new RateGovernor(store, clock, { dailyHardCeiling: 1000 });
  const actions = new FakeActions();
  const presses: string[] = [];
  const violations: string[] = [];
  actions.unfollow = async (username: string) => {
    actions.unfollowCalls.push(username);
    const pk = username.slice('user'.length);
    const atSelection = selectionVerdict(store, pk, rig.port.index()).kind;
    if (atSelection === 'protected' || atSelection === 'paused') violations.push(`${pk} reached the click while ${atSelection}`);
    const verdict = clickVerdict(rig, pk, fresh.get(pk) ?? {}, clock.now());
    if (verdict !== null) return { status: 'reviewed', verdict };
    presses.push(pk);
    return { status: 'ok' };
  };
  const dayClock = calendarPlanDayClock({ now: () => clock.now() });
  const reconciler = new ProtectionReconciler({ store, port: rig.port, clock, dayClock });
  const sched = new ChurnScheduler({ store, clock, rate, actions, protection: rig.port, reconciler,
    cfg: { ...DEFAULT_CONFIGS.churn, maxWaitForFollowbackMs: WAIT, rotateMutuals } });
  const step = async (): Promise<void> => {
    sched.advanceTimers();
    const due = sched.nextDue(clock.now());
    if (due !== null) await sched.execute(due);
  };
  return { store, clock, rig, actions, presses, violations, sched, step };
}

const recordArb = fc.record({
  state: fc.constantFrom<FollowState>('pending_followback', 'followed_back', 'unfollow_queued', 'queued'),
  stored: factsArb,
  fresh: factsArb,
});

test('the rigs press what is clear (the properties below are not vacuous)', async () => {
  const t = churnRig({ words: ['cafe'], keepVerified: true, people: [], paused: false }, new Map([['1', { bio: 'x', isVerified: false }]]));
  observe(t.store, '1', { bio: 'x', isVerified: false });
  t.store.upsertFollowRecord({ accountPk: '1', targetPk: null, state: 'unfollow_queued', retryCount: 0, unfollowDueAt: T0 - 1 });
  await t.step();
  expect(t.presses).toEqual(['1']);
});

test('P-PROT-1 (P1–P4): nothing protected or paused reaches the click, and nothing non-clear is pressed', async () => {
  await fc.assert(fc.asyncProperty(rulesArb, fc.array(recordArb, { minLength: 1, maxLength: PKS.length }), async (rules, recs) => {
    const fresh = new Map(recs.map((x, i) => [PKS[i], x.fresh] as const));
    const t = churnRig(rules, fresh);
    recs.forEach((x, i) => {
      observe(t.store, PKS[i], x.stored);
      t.store.upsertFollowRecord({ accountPk: PKS[i], targetPk: null, state: x.state, retryCount: 0, score: 1,
        followedAt: T0 - 2 * WAIT, holdUntil: T0 - 1, unfollowDueAt: T0 - 1 });
    });
    for (let i = 0; i < 2 * recs.length + 2; i++) { t.clock.advance(WAIT); await t.step(); }
    expect(t.violations).toEqual([]);
    for (const pk of t.presses) expect(clickVerdict(t.rig, pk, fresh.get(pk) ?? {}, t.clock.now())).toBeNull();
    for (const [i, x] of recs.entries()) {
      if (clickVerdict(t.rig, PKS[i], x.fresh, t.clock.now()) !== null) expect(t.store.getFollowRecord(PKS[i])?.state).not.toBe('unfollowed');
    }
  }), { numRuns: 120 });
});

test('P-PROT-1 (P5–P7): a prune run and the woven feed press only what is clear at selection and at the click', async () => {
  await fc.assert(fc.asyncProperty(rulesArb, fc.array(fc.record({ stored: factsArb, fresh: factsArb }), { minLength: 1, maxLength: PKS.length }),
    fc.boolean(), async (rules, rows, woven) => {
      const store = kitStore();
      store.setOwnPk(OWN_PK);
      const clock = new FakeClock(T0);
      const rig = new ProtectionRig(clock);
      applyRules(rig, rules);
      const pks = PKS.slice(0, rows.length);
      for (const [i, x] of rows.entries()) observe(store, pks[i], x.stored);
      const churn = new FakePruneActions();
      const pressed: string[] = [];
      churn.unfollow = async (username: string) => {
        const pk = username.slice('user'.length);
        const atSelection = selectionVerdict(store, pk, rig.port.index()).kind;
        expect(atSelection === 'protected' || atSelection === 'paused').toBe(false);
        const verdict = clickVerdict(rig, pk, rows[pks.indexOf(pk)].fresh, clock.now());
        if (verdict !== null) return { status: 'reviewed', verdict };
        pressed.push(pk);
        return { status: 'ok' };
      };
      const engine = new PruneEngine({ store, clock, ownPk: OWN_PK, ownFollowing: new FakeListSource(pks),
        ownFollowers: new FakeListSource([]), churnActions: churn, sentinel: new FakeSentinel(), cfg: PRUNE_CFG,
        sleep: async () => {}, rng: () => 0.5, protection: rig.port });
      await engine.scan();
      if (woven) {
        for (let cand = engine.nextCandidate(clock.now()); cand !== null; cand = engine.nextCandidate(clock.now())) {
          await engine.executeUnfollow(cand, clock.now());
          if (rules.paused) break;
        }
      } else await engine.run();
      for (const pk of pressed) expect(clickVerdict(rig, pk, rows[pks.indexOf(pk)].fresh, clock.now())).toBeNull();
      expect(store.pruneCountSince(0)).toBe(pressed.length);
      if (rules.paused) expect(pressed).toEqual([]);
    }), { numRuns: 120 });
});

test('P-PROT-1 (P10): the prune-run mode rule never runs an unfollow over a protected or paused verdict', () => {
  const rule = PRUNE_RULES.find((r) => r.id === 'prune-candidate');
  const verdictArb = fc.constantFrom<ProtectionVerdict>({ kind: 'clear' }, { kind: 'protected', by: 'account', match: 'c' },
    { kind: 'protected', by: 'bio-word', match: 'cafe' }, { kind: 'unknown', missing: 'bio' }, { kind: 'paused', state: 'unavailable' });
  fc.assert(fc.property(verdictArb, fc.boolean(), fc.option(fc.constant('cand'), { nil: null }), (protection, followsUsNow, username) => {
    const facts = { clock: { now: T0 }, prune: { candidate: { pk: 'c', username }, followsUsNow, protection, atDailyCap: false } };
    const v = rule?.decide(facts as unknown as Facts, {} as RunCtx);
    if (protection.kind === 'protected' || protection.kind === 'paused') expect(v).toEqual({ do: 'yield' });
  }), { numRuns: 200 });
});

test('P-PROT-2: a protected or unknown unfollow head never blocks a queued follow', async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom('protected', 'unknown'), { minLength: 1, maxLength: 4 }), async (heads) => {
    const fresh = new Map<string, Facts4>();
    const t = churnRig({ words: ['cafe'], keepVerified: false, people: [], paused: false }, fresh);
    heads.forEach((kind, i) => {
      observe(t.store, PKS[i], kind === 'protected' ? { bio: 'cafe owner' } : {});
      fresh.set(PKS[i], {});
      t.store.upsertFollowRecord({ accountPk: PKS[i], targetPk: null, state: 'unfollow_queued', retryCount: 0, unfollowDueAt: T0 - 1 });
    });
    observe(t.store, 'f', {});
    t.store.upsertFollowRecord({ accountPk: 'f', targetPk: null, state: 'queued', retryCount: 0, score: 1 });
    for (let i = 0; i <= heads.length; i++) await t.step();
    expect(t.actions.followCalls).toEqual(['userf']);
    expect(t.presses).toEqual([]);
  }), { numRuns: 50 });
});

test('P-PROT-3: an unreadable record is read at most once per re-check window (1, 2, 4, 8 plan-days)', async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 3, max: 30 }), async (days) => {
    const fresh = new Map<string, Facts4>([['1', {}]]);
    const t = churnRig({ words: ['cafe'], keepVerified: false, people: [], paused: false }, fresh);
    observe(t.store, '1', {});
    t.store.upsertFollowRecord({ accountPk: '1', targetPk: null, state: 'unfollow_queued', retryCount: 0, unfollowDueAt: T0 - 1 });
    const visits: number[] = [];
    const visit = t.actions.unfollow.bind(t.actions);
    t.actions.unfollow = async (username: string) => { visits.push(t.clock.now()); return visit(username); };
    for (let h = 0; h < days * 24; h++) { await t.step(); t.clock.advance(MS_PER_HOUR); }
    expect(t.presses).toEqual([]);
    expect(visits.length).toBeGreaterThanOrEqual(2);
    for (let k = 1; k < visits.length; k++) {
      expect(visits[k] - visits[k - 1]).toBeGreaterThanOrEqual((keptRecheckPlanDays(k) - 1 / 24) * MS_PER_DAY);
    }
    expect(visits.length).toBeLessThanOrEqual(1 + Math.ceil(Math.log2(days + 1)) + Math.floor(days / 8));
  }), { numRuns: 15 });
});

test('P-PROT-4: a paused index emits no unfollow while follows continue', async () => {
  await fc.assert(fc.asyncProperty(fc.array(recordArb, { minLength: 1, maxLength: PKS.length }), async (recs) => {
    const fresh = new Map(recs.map((x, i) => [PKS[i], x.fresh] as const));
    const t = churnRig({ words: ['cafe'], keepVerified: true, people: [], paused: true }, fresh);
    recs.forEach((x, i) => {
      observe(t.store, PKS[i], x.stored);
      t.store.upsertFollowRecord({ accountPk: PKS[i], targetPk: null, state: x.state, retryCount: 0, score: 1,
        followedAt: T0 - 2 * WAIT, holdUntil: T0 - 1, unfollowDueAt: T0 - 1 });
    });
    for (let i = 0; i < 2 * recs.length + 2; i++) { t.clock.advance(WAIT); await t.step(); }
    expect(t.actions.unfollowCalls).toEqual([]);
    const queued = recs.filter((x) => x.state === 'queued').length;
    expect(t.actions.followCalls.length).toBe(queued);
  }), { numRuns: 80 });
});

test('P-PROT-5: with mutuals kept a held mutual is never queued (P2 never runs)', () => {
  fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: 30 * 24 }), { minLength: 1, maxLength: PKS.length }), fc.integer({ min: 1, max: 60 }), (holds, hours) => {
    const t = churnRig({ words: [], keepVerified: false, people: [], paused: false }, new Map(), false);
    holds.forEach((h, i) => {
      observe(t.store, PKS[i], {});
      t.store.upsertFollowRecord({ accountPk: PKS[i], targetPk: null, state: 'followed_back', retryCount: 0,
        followedBackAt: T0 - 1, holdUntil: T0 - h * MS_PER_HOUR });
    });
    for (let i = 0; i < hours; i++) { t.clock.advance(MS_PER_DAY); t.sched.advanceTimers(); }
    for (const pk of PKS.slice(0, holds.length)) expect(t.store.getFollowRecord(pk)?.state).toBe('followed_back');
  }), { numRuns: 100 });
});
