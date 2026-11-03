/**
 * The journal (spec §9.8): the per-account gate, what is due, and the settlement table row by row —
 * including U06 F6 (an unfollow that did not land stays managed) and the follow mirror — with the
 * laws L5 (an unavailable account ends in a terminal, never a wedge) and L6 (journal per account).
 */
import fc from 'fast-check';
import {
  accountJournalGate, type IntentObservation, journalBlocks, journalDue, planDaySlots, type Settlement, settlementFor,
} from '@/engine/journal';
import { calendarPlanDayClock } from '@/governors/plan-day-clock';
import type { ParkSlots } from '@/kernel/derive-parks';
import type { EffectIntent, EffectState, FollowRecord, MutationAction } from '@/store/types';

const DAY = 86_400_000;
const T = Date.UTC(2026, 10, 3, 12);
const SLOTS: ParkSlots = { nextSessionAt: T + 3_600_000, planDayStartAfter: (k) => T + k * DAY };
const CTX = { ownPk: 'me', slots: SLOTS, maxRetries: 3 };

const intent = (over: Partial<EffectIntent> = {}): EffectIntent => ({
  id: 'i1', accountPk: 'a', username: 'alice', action: 'unfollow', channel: 'growth', state: 'uncertain',
  createdAt: T - DAY, dispatchedAt: T - DAY, settledAt: null, result: null, attempts: 0, nextAttemptAt: null, ...over,
});
const record = (over: Partial<FollowRecord> = {}): FollowRecord => ({
  accountPk: 'a', targetPk: 'seed', state: 'unfollow_queued', retryCount: 0, followedAt: T - 9 * DAY, ...over,
});
const seen = (following: boolean | null, requested: boolean | null, followsUs: boolean | null = null): IntentObservation =>
  ({ kind: 'ok', following, requested, followsUs, at: T });

const settled = (s: Settlement) => {
  if (!('settle' in s)) throw new Error(`expected a settlement, got ${JSON.stringify(s)}`);
  return s.settle;
};

describe('the per-account gate', () => {
  test('an open write (dispatched or uncertain) blocks its own account only', () => {
    const open = [intent({ id: 'x', accountPk: 'x', state: 'uncertain' }), intent({ id: 'p', accountPk: 'y', state: 'prepared' })];
    expect(journalBlocks('x', open)).toBe(true);
    expect(journalBlocks('y', open)).toBe(false);
    expect(journalBlocks('z', open)).toBe(false);
    expect(journalBlocks('x', open, 'x')).toBe(false);
  });

  test('due: an open intent with no next attempt, or one whose time has come', () => {
    expect(journalDue(intent({ nextAttemptAt: null }), T)).toBe(true);
    expect(journalDue(intent({ nextAttemptAt: T }), T)).toBe(true);
    expect(journalDue(intent({ nextAttemptAt: T + 1 }), T)).toBe(false);
    expect(journalDue(intent({ state: 'prepared' }), T)).toBe(false);
    expect(journalDue(intent({ state: 'settled' }), T)).toBe(false);
  });

  test('the wired gate has no global block: it answers only for a named account', () => {
    const all = [intent({ id: 'x', accountPk: 'x', state: 'uncertain' })];
    const gate = accountJournalGate(() => all);
    expect(gate.requiresReconciliation(T)).toBe(false);
    expect(gate.requiresReconciliation(T, { pk: 'x' })).toBe(true);
    expect(gate.requiresReconciliation(T, { pk: 'x', intentId: 'x' })).toBe(false);
    expect(gate.requiresReconciliation(T, { pk: 'y' })).toBe(false);
  });

  test('park slots sit on the plan-day boundary: the start of each later plan-day', () => {
    const clock = calendarPlanDayClock({ now: () => T });
    const s = planDaySlots(clock, T);
    const today = clock.window(T);
    expect(s.nextSessionAt).toBeNull();
    expect(s.planDayStartAfter(1)).toBe(today.endsAt);
    expect(s.planDayStartAfter(2)).toBe(clock.window(today.endsAt).endsAt);
    expect(planDaySlots(clock, T, T + 60_000).nextSessionAt).toBe(T + 60_000);
  });

  test('law L6: an unsettled intent on X never blocks Y, and always blocks a second write on X', () => {
    const states: EffectState[] = ['prepared', 'dispatched', 'uncertain', 'settled'];
    const arbIntent = fc.record({ id: fc.string({ minLength: 1, maxLength: 3 }), accountPk: fc.constantFrom('x', 'y', 'z'),
      state: fc.constantFrom(...states) }).map((o) => intent(o));
    fc.assert(fc.property(fc.array(arbIntent, { maxLength: 8 }), fc.constantFrom('x', 'y', 'z'), fc.option(fc.string(), { nil: undefined }),
      (all, pk, except) => {
        const open = all.filter((i) => i.accountPk === pk && i.id !== except && (i.state === 'dispatched' || i.state === 'uncertain'));
        expect(journalBlocks(pk, all, except)).toBe(open.length > 0);
      }), { numRuns: 400 });
  });
});

describe('the settlement table (spec §9.8)', () => {
  test('F6: an unfollow still following or requested is cancelled and the record stays queued for unfollow', () => {
    for (const [following, requested] of [[true, false], [false, true]] as const) {
      const s = settled(settlementFor(intent(), seen(following, requested), record(), CTX));
      expect(s).toMatchObject({ result: 'cancelled', at: T, record: { state: 'unfollow_queued', reconciledAt: T } });
      expect(s.edge).toEqual({ srcPk: 'me', dstPk: 'a', active: true, observedAt: T });
    }
  });

  test('an unfollow that landed: external, the record unfollowed, our follow edge removed', () => {
    const s = settled(settlementFor(intent(), seen(false, false), record(), CTX));
    expect(s).toMatchObject({ result: 'external', ledger: 'none', record: { state: 'unfollowed', reconciledAt: T } });
    expect(s.edge).toEqual({ srcPk: 'me', dstPk: 'a', active: false, observedAt: T });
  });

  test('the follow mirror: a follow that landed waits for a follow-back from its dispatch, never leaking to external', () => {
    const queued = record({ state: 'queued', followedAt: undefined });
    const s = settled(settlementFor(intent({ action: 'follow', dispatchedAt: T - 5_000 }), seen(false, true), queued, CTX));
    expect(s).toMatchObject({ result: 'external', ledger: 'none',
      record: { state: 'pending_followback', followedAt: T - 5_000, reconciledAt: T } });
    expect(s.edge).toMatchObject({ srcPk: 'me', dstPk: 'a', active: true });
  });

  test('a follow that did not land is cancelled and its record spends one retry, abandoning past the limit', () => {
    const once = settled(settlementFor(intent({ action: 'follow' }), seen(false, false), record({ state: 'queued' }), CTX));
    expect(once).toMatchObject({ result: 'cancelled', record: { state: 'queued', retryCount: 1 } });
    const last = settled(settlementFor(intent({ action: 'follow' }), seen(false, false), record({ state: 'queued', retryCount: 3 }), CTX));
    expect(last).toMatchObject({ result: 'cancelled', record: { state: 'abandoned', retryCount: 4, abandonedAt: T } });
  });

  test('an accepted request that landed closes the request and opens the follower edge; one that did not changes nothing', () => {
    const accept = intent({ action: 'accept-request', channel: 'accept-request' });
    const yes = settlementFor(accept, seen(null, null, true), null, CTX);
    expect(settled(yes)).toMatchObject({ result: 'external', ledger: 'none', edge: { srcPk: 'a', dstPk: 'me', active: true } });
    expect(yes).toMatchObject({ closesRequest: true });
    const no = settled(settlementFor(accept, seen(null, null, false), null, CTX));
    expect(no).toEqual({ at: T, result: 'cancelled', ledger: 'none' });
  });

  test('records move only for the growth channel and never out of a terminal state', () => {
    const manual = settled(settlementFor(intent({ channel: 'manual' }), seen(false, false), record(), CTX));
    expect(manual.record).toBeUndefined();
    const done = settled(settlementFor(intent(), seen(false, false), record({ state: 'external' }), CTX));
    expect(done.record).toBeUndefined();
  });

  test('gone or renamed parks to a new plan-day; the second sighting expires the intent and closes the record', () => {
    for (const kind of ['absent', 'renamed'] as const) {
      const first = settlementFor(intent(), { kind, at: T }, record(), CTX);
      expect(first).toEqual({ park: { attempts: 1, nextAttemptAt: T + DAY }, recordPark: 'unreachable',
        record: { ...record(), parkReason: 'unreachable', checkFailures: 1, recheckAt: T + DAY } });
      const second = settlementFor(intent({ attempts: 1 }), { kind, at: T }, record(), CTX);
      expect(second).toMatchObject({ expire: { at: T, result: 'expired', ledger: 'none',
        record: { state: 'external', parkReason: 'unreachable', checkFailures: 2 } }, recordTerminal: 'external' });
    }
  });

  test('unreadable (or flags absent) parks to the next session, then plan-days; past the retries it expires and abandons', () => {
    expect(settlementFor(intent(), { kind: 'unreadable', at: T }, record(), CTX))
      .toMatchObject({ park: { attempts: 1, nextAttemptAt: T + 3_600_000 }, recordPark: 'unreadable' });
    expect(settlementFor(intent(), seen(null, false), record(), CTX))
      .toMatchObject({ park: { attempts: 1, nextAttemptAt: T + 3_600_000 }, recordPark: 'unreadable' });
    expect(settlementFor(intent({ attempts: 2 }), { kind: 'unreadable', at: T }, record(), CTX))
      .toMatchObject({ park: { attempts: 3, nextAttemptAt: T + 2 * DAY } });
    expect(settlementFor(intent({ attempts: 3 }), { kind: 'unreadable', at: T }, record(), CTX)).toMatchObject({
      expire: { result: 'expired', record: { state: 'abandoned', abandonedAt: T, checkFailures: 4 } }, recordTerminal: 'abandoned' });
  });

  test('a wall counts no attempt and goes to the recovery ladder; a refused read waits for the allowance', () => {
    expect(settlementFor(intent({ attempts: 2 }), { kind: 'walled', at: T }, record(), CTX)).toEqual({ ladder: true });
    expect(settlementFor(intent({ attempts: 2 }), { kind: 'read-budget', at: T, resumeAt: T + 77 }, record(), CTX))
      .toEqual({ park: { attempts: 2, nextAttemptAt: T + 77 }, recordPark: null, record: null });
  });

  test('law L5: an unavailable account always reaches a terminal within the retries, every park lies ahead', () => {
    const actions: MutationAction[] = ['follow', 'unfollow', 'accept-request'];
    fc.assert(fc.property(fc.constantFrom(...actions),
      fc.array(fc.constantFrom<IntentObservation['kind']>('absent', 'renamed', 'unreadable'), { minLength: 4, maxLength: 8 }),
      (action, kinds) => {
        let attempts = 0;
        let steps = 0;
        let expired = false;
        for (const kind of kinds) {
          steps += 1;
          const s = settlementFor(intent({ action, attempts }), { kind, at: T }, record(), CTX);
          if ('expire' in s) {
            expired = true;
            break;
          }
          if (!('park' in s)) throw new Error('an unavailable reading must park or expire');
          expect(s.park.attempts).toBe(attempts + 1);
          expect(s.park.nextAttemptAt).toBeGreaterThan(T);
          attempts = s.park.attempts;
        }
        expect(expired).toBe(true);
        expect(steps).toBeLessThanOrEqual(4);
      }), { numRuns: 300 });
  });
});
