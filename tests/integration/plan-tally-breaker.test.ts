/**
 * I10 and I13 (spec §20.3) over the production plan wiring and a real store. I10: the plan's tally
 * (`tallySince`) equals the rate governor's `actionsToday` on journal fixtures of every channel and result.
 * I13 (spec §11.1 F7): two unverified unfollows hold unfollows for the rest of the session (follows go on),
 * the next session allows one attempt, and the third unverified in a row enters the recovery ladder.
 */
import { UnconfirmedBreaker } from '@/engine/unconfirmed-breaker';
import type { PlanWiring } from '@/main/services/plan-wiring';
import { DEFAULT_SETTINGS, toRateGovernorConfig } from '@/settings/settings';
import type { KnowledgeStore } from '@/store/knowledge-store';
import type { EffectChannel, EffectResult, MutationAction } from '@/store/types';
import { MS_PER_DAY, MS_PER_MINUTE } from '@/timing/units';
import { fakePlanHost, intoSession, PLAN_TEST_RNG, type PlanClock, planClock, storePlanWiring } from '../kit/harness-plan';
import { openTestStore } from '../kit/store';

const FROM = Date.parse('2026-11-09T12:00:00');
const SETTINGS = { ...DEFAULT_SETTINGS, dryRun: false };
let store: KnowledgeStore;
let plan: PlanWiring;
let clock: PlanClock;
beforeEach(() => {
  store = openTestStore(':memory:', { rng: PLAN_TEST_RNG });
  store.setOwnPk('me');
  clock = planClock(FROM);
  plan = storePlanWiring(store, clock, fakePlanHost(SETTINGS));
});
afterEach(() => {
  plan.dispose();
  store.close();
});

const settable = { set: (t: number) => { clock.t = t; }, now: () => clock.now() };

/** One journal fixture: begun, optionally dispatched, optionally settled with a result into a ledger. */
function write(pk: string, o: { action?: MutationAction; channel?: EffectChannel; at?: number; dispatched?: boolean;
  result?: EffectResult; ledger?: 'growth' | 'prune' | 'none' }): void {
  const at = o.at ?? clock.now();
  const intent = store.beginEffectIntent({ accountPk: pk, username: pk, action: o.action ?? 'follow', channel: o.channel ?? 'growth', at });
  if (o.dispatched !== false) store.markEffectDispatched(intent.id, at);
  if (o.result !== undefined) store.settleEffectIntent(intent.id, { at, result: o.result, ledger: o.ledger ?? 'none' });
}

describe('I10: tallySince equals actionsToday on journal fixtures', () => {
  test('every channel and result, settled or open, counts the same in both', () => {
    intoSession(plan, settable);
    const rate = plan.rateGovernor(toRateGovernorConfig(SETTINGS));
    const agree = (): void => expect(store.tallySince(rate.dayStart()).all).toBe(rate.actionsToday());
    const day = rate.dayStart();
    write('before', { at: day - MS_PER_MINUTE, result: 'ok', ledger: 'growth' });
    agree();
    const fixtures: Parameters<typeof write>[1][] = [
      { result: 'ok', ledger: 'growth' },
      { action: 'unfollow', result: 'fail', ledger: 'growth' },
      { action: 'unfollow', channel: 'prune', result: 'ok', ledger: 'prune' },
      { action: 'unfollow', channel: 'prune', result: 'fail', ledger: 'prune' },
      { channel: 'manual', result: 'ok', ledger: 'growth' },
      { action: 'accept-request', channel: 'accept-request', result: 'ok', ledger: 'none' },
      { dispatched: true },
      { result: 'simulated', ledger: 'none' },
      { dispatched: false, result: 'cancelled' },
      { result: 'expired', ledger: 'none' },
    ];
    fixtures.forEach((f, i) => {
      clock.t += MS_PER_MINUTE;
      write(`p${i}`, f);
      agree();
    });
    expect(rate.actionsToday()).toBeGreaterThan(0);
  });
});

/** Follows old enough to be due for unfollow, so the plan sizes an unfollow budget (spec §5.7). */
function dueUnfollows(n: number): void {
  for (let i = 0; i < n; i += 1) {
    const pk = `old${i}`;
    store.observe({ accountPk: pk, observedAt: FROM - 9 * MS_PER_DAY, source: 'profile', fields: { username: pk, followers: 200, following: 200 } });
    store.upsertFollowRecord({ accountPk: pk, targetPk: 'hub', state: 'pending_followback', followedAt: FROM - 9 * MS_PER_DAY + i, retryCount: 0 });
  }
}

describe('I13: the unconfirmed-actions breaker through the plan', () => {
  test('two unverified unfollows hold unfollows for the session; follows go on; the third enters the ladder', () => {
    dueUnfollows(6);
    intoSession(plan, settable, (v) => v.plan.kinds.unfollow >= 3 && v.plan.sessions.filter((x) => x.budget > 0).length >= 2);
    const at = (): number => clock.now();
    expect(plan.pacing.noteOutcome('unfollow', true, at())).toBe(1);
    expect(plan.cadence.preflight('unfollow', 'growth', at(), { pk: 'u' })).toEqual({ ok: true });
    clock.t += MS_PER_MINUTE;
    const second = plan.pacing.noteOutcome('unfollow', true, at());
    expect(UnconfirmedBreaker.entersLadder(second)).toBe(false);
    const next = plan.service.view(at()).nextSessionAt;
    expect(plan.cadence.preflight('unfollow', 'growth', at(), { pk: 'u' })).toMatchObject({ ok: false, reason: 'unconfirmed' });
    expect(plan.cadence.preflight('follow', 'growth', at(), { pk: 'f' })).toEqual({ ok: true });
    expect(plan.breaker.held(at())).toEqual({ kind: 'unfollow', streak: 2 });

    // The next session allows one attempt; a third unverified in a row is a wall.
    clock.t = next ?? plan.service.view(at()).window.endsAt;
    plan.pacing.ensureIfProvisional(at());
    expect(plan.breaker.held(at())).toBeNull();
    expect(UnconfirmedBreaker.entersLadder(plan.pacing.noteOutcome('unfollow', true, at()))).toBe(true);
  });

  test('a confirmed unfollow resets the streak and lifts the hold', () => {
    intoSession(plan, settable);
    plan.pacing.noteOutcome('unfollow', true, clock.now());
    plan.pacing.noteOutcome('unfollow', true, clock.now());
    expect(plan.breaker.held(clock.now())).not.toBeNull();
    expect(plan.pacing.noteOutcome('unfollow', false, clock.now())).toBe(0);
    expect(plan.breaker.held(clock.now())).toBeNull();
  });
});
