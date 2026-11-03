/**
 * The store reads the plan service consumes (spec §16.3, Appendix A `PlanStore`):
 * the raw plan state, the write-budget tally over the rate governor's ledger
 * union, the recent mutation times, whether any write exists, and the repo
 * skeletons the facade exposes.
 */

import { FakeClock } from '@/governors/clock';
import type { PlanStore } from '@/governors/plan-types';
import { RateGovernor } from '@/governors/rate-governor';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { META_KEYS } from '@/store/repos/meta';
import { withStore } from '../kit/store';

const NOON = Date.parse('2026-08-12T12:00:00');
const cfg = { dailyHardCeiling: 50, dailyOperatingRate: 25, minDelayMs: 1000, maxDelayMs: 2000,
  jitterPercent: 0, activeHoursStart: 8, activeHoursEnd: 22 };

/** Journal fixtures covering every leg of the union, plus rows outside the window. */
function seedJournal(s: KnowledgeStore, t: number): void {
  s.recordAction('old', 'follow', 'ok', t - 20 * 3_600_000);                // before the cycle
  s.recordAction('f1', 'follow', 'ok', t - 60_000);
  s.recordAction('u1', 'unfollow', 'fail', t - 50_000);
  s.recordPruneAction('p1', 'ok', t - 40_000);
  s.recordPruneAction('p2', 'simulated', t - 35_000);                       // never counts
  const manual = s.beginEffectIntent({ accountPk: 'm1', username: 'm1', action: 'unfollow', channel: 'manual', at: t - 30_000 });
  s.markEffectDispatched(manual.id, t - 30_000);
  s.settleEffectIntent(manual.id, { at: t - 29_000, result: 'ok', ledger: 'growth' });
  const uncertain = s.beginEffectIntent({ accountPk: 'g1', username: 'g1', action: 'follow', channel: 'growth', at: t - 20_000 });
  s.markEffectUncertain(uncertain.id, t - 20_000);
  const accept = s.beginEffectIntent({ accountPk: 'r1', username: 'r1', action: 'accept-request', channel: 'accept-request', at: t - 10_000 });
  s.markEffectDispatched(accept.id, t - 10_000);
  s.settleEffectIntent(accept.id, { at: t - 9_000, result: 'ok' });
  const expired = s.beginEffectIntent({ accountPk: 'e1', username: 'e1', action: 'unfollow', channel: 'manual', at: t - 8_000 });
  s.markEffectDispatched(expired.id, t - 8_000);
  s.settleEffectIntent(expired.id, { at: t - 7_000, result: 'expired' });
  const cancelled = s.beginEffectIntent({ accountPk: 'c1', username: 'c1', action: 'follow', channel: 'growth', at: t - 5_000 });
  s.settleEffectIntent(cancelled.id, { at: t - 4_000, result: 'cancelled' });  // never dispatched
}

test('the plan-state key round-trips raw, and null clears it', () => {
  return withStore((s) => {
    expect(s.getPlanState()).toBeNull();
    s.setPlanState('{"v":1}');
    expect(s.getPlanState()).toBe('{"v":1}');
    s.setPlanState(null);
    expect(s.getPlanState()).toBeNull();
  });
});

test('the new meta keys name their rows exactly once', () => {
  expect(META_KEYS).toMatchObject({
    planState: 'plan_state', reopenState: 'reopen_state',
    followerChangesBackfilledAt: 'follower_changes_backfilled_at', surfaceMeter: 'surface_meter',
  });
});

test('tallySince over the ledger union equals the governor actionsToday on journal fixtures', () => {
  return withStore((s) => {
    const clock = new FakeClock(NOON);
    const g = new RateGovernor(s, clock, cfg);
    seedJournal(s, NOON);
    const since = g.dayStart();
    const tally = s.tallySince(since);
    expect(tally.all).toBe(g.actionsToday());
    expect(tally).toEqual({ all: 7, auto: 5, manual: 2, follow: 2, unfollow: 4, accept: 1 });
  });
});

test('recentMutationTimes lists the same writes, oldest first', () => {
  return withStore((s) => {
    seedJournal(s, NOON);
    const since = NOON - 3_600_000;
    const times = s.recentMutationTimes(since);
    expect(times).toHaveLength(s.tallySince(since).all);
    expect([...times]).toEqual([...times].sort((a, b) => a - b));
    expect(times[0]).toBe(NOON - 60_000);
  });
});

test("the facade is the plan service's PlanStore; hasAnyMutation sees any write in the union, however old", () => {
  const anyAfter = (seed: (s: KnowledgeStore) => void) => withStore((s) => {
    const port: PlanStore = s;
    seed(s);
    return port.hasAnyMutation();
  });
  return Promise.all([
    anyAfter(() => undefined),
    anyAfter((s) => s.recordPruneAction('p0', 'simulated', 1)),
    anyAfter((s) => s.recordAction('a0', 'follow', 'ok', 1)),
    anyAfter((s) => s.recordPruneAction('p1', 'fail', 1)),
    anyAfter((s) => s.markEffectUncertain(s.beginEffectIntent({ accountPk: 'g', username: 'g', action: 'follow',
      channel: 'growth', at: 1 }).id, 1)),
  ]).then((seen) => expect(seen).toEqual([false, false, true, true, true]));
});

test('the facade exposes the journal, record and new repo skeletons as public fields', () => {
  return withStore((s) => {
    expect(s.followRecords).toBeDefined();
    expect(s.effectIntents).toBeDefined();
    expect([s.reopen, s.feed, s.surface, s.protectionFacts, s.growth].every(Boolean)).toBe(true);
    s.reopen.setRaw('{"v":1}');
    expect(s.reopen.raw()).toBe('{"v":1}');
  });
});
