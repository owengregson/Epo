/**
 * Pure conductor decisions — no store, no clock, no fake ports beyond a tiny
 * literal store slice. Each rule the loop used to inline is asserted directly.
 */

import {
  acquireFailureVerdict,
  type DecisionStore,
  pickAction,
  queuedCountFor,
  unenrichedUsernames,
} from '@/engine/decisions';
import { planDayStartBefore, weeklyCycleSince } from '@/engine/exploration-policy';
import type { AccountState, FollowRecord, FollowState } from '@/store/types';

const rec = (over: Partial<FollowRecord> & { accountPk: string }): FollowRecord => ({
  targetPk: null,
  state: 'queued',
  retryCount: 0,
  ...over,
});

const acc = (over: Partial<AccountState> & { pk: string }): AccountState => ({
  enrichment: 'stub',
  firstSeenAt: 0,
  lastSeenAt: 0,
  ...over,
});

/** The smallest object satisfying {@link DecisionStore} — literals, no SQLite. */
const store = (opts: {
  records?: Partial<Record<FollowState, FollowRecord[]>>;
  pool?: Record<string, string[]>;
  accounts?: AccountState[];
}): DecisionStore => ({
  followRecordsByState: (state) => opts.records?.[state] ?? [],
  candidatePksForTarget: (targetPk) => opts.pool?.[targetPk] ?? [],
  getAccount: (pk) => opts.accounts?.find((a) => a.pk === pk) ?? null,
});

describe('queuedCountFor', () => {
  test('counts only queued records aimed at the given target', () => {
    const s = store({
      records: {
        queued: [
          rec({ accountPk: 'a', targetPk: 't1' }),
          rec({ accountPk: 'b', targetPk: 't2' }),
          rec({ accountPk: 'c', targetPk: 't1' }),
          rec({ accountPk: 'd', targetPk: null }),
        ],
      },
    });
    expect(queuedCountFor(s, 't1')).toBe(2);
    expect(queuedCountFor(s, 't2')).toBe(1);
    expect(queuedCountFor(s, 't3')).toBe(0);
  });
});

describe('unenrichedUsernames', () => {
  const s = store({
    pool: { t1: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'] },
    accounts: [
      acc({ pk: 'p1', username: 'one' }), // enrichable
      acc({ pk: 'p2', username: 'two', enrichment: 'profiled' }), // already profiled
      acc({ pk: 'p3' }), // no username → no profile fetch possible
      acc({ pk: 'p4', username: 'four', enrichFailedAt: 123 }), // permanently un-enrichable
      acc({ pk: 'p5', username: 'five' }),
      // p6 has no account row at all
    ],
  });

  test('selects only enrichable candidates with a known username', () => {
    expect(unenrichedUsernames(s, 't1', 10)).toEqual(['one', 'five']);
  });

  test('respects the cap', () => {
    expect(unenrichedUsernames(s, 't1', 1)).toEqual(['one']);
    expect(unenrichedUsernames(s, 't1', 0)).toEqual([]);
  });

  test('an unknown target yields nothing', () => {
    expect(unenrichedUsernames(s, 'nope', 10)).toEqual([]);
  });

  test('a profile or a failure observed before the freshness window opens is worth one more fetch', () => {
    const since = 5_000;
    const w = store({
      pool: { t1: ['old', 'new', 'failedOld', 'failedNew'] },
      accounts: [
        acc({ pk: 'old', username: 'old', enrichment: 'profiled', statsObservedAt: since - 1 }),
        acc({ pk: 'new', username: 'new', enrichment: 'profiled', statsObservedAt: since }),
        acc({ pk: 'failedOld', username: 'failedold', enrichFailedAt: since - 1 }),
        acc({ pk: 'failedNew', username: 'failednew', enrichFailedAt: since }),
      ],
    });
    expect(unenrichedUsernames(w, 't1', 10, since)).toEqual(['old', 'failedold']);
    expect(unenrichedUsernames(w, 't1', 10)).toEqual([]);
  });
});

describe('the weekly cycle of plan-days (spec §5.16)', () => {
  /** Plan-days of 24 h starting at 03:00 UTC, the shape a quiet-minute boundary has. */
  const windowOf = (t: number) => {
    const startsAt = Math.floor((t - 3 * 3_600_000) / 86_400_000) * 86_400_000 + 3 * 3_600_000;
    return { key: String(startsAt), startsAt, endsAt: startsAt + 86_400_000, quietMinute: 180 };
  };
  const now = Date.parse('2026-11-12T15:00:00Z');

  test('steps back through the plan-day boundary, never a calendar day of its own', () => {
    expect(planDayStartBefore(windowOf, now, 0)).toBe(Date.parse('2026-11-12T03:00:00Z'));
    expect(planDayStartBefore(windowOf, now, 2)).toBe(Date.parse('2026-11-10T03:00:00Z'));
  });

  test('a fact stays fresh through today and the six plan-days before it', () => {
    expect(weeklyCycleSince(windowOf, now)).toBe(Date.parse('2026-11-06T03:00:00Z'));
    // Observed on the 6th, so it lapses when the 7th plan-day after that day begins (the 13th, 03:00).
    expect(weeklyCycleSince(windowOf, Date.parse('2026-11-13T02:59:00Z'))).toBe(Date.parse('2026-11-06T03:00:00Z'));
    expect(weeklyCycleSince(windowOf, Date.parse('2026-11-13T03:00:00Z'))).toBe(Date.parse('2026-11-07T03:00:00Z'));
  });
});

describe('pickAction', () => {
  const opts = (draw: number | null, fraction = 0.3): Parameters<typeof pickAction>[2] => ({
    unfollowFraction: fraction,
    draw,
  });
  const cand = { pk: 'c', username: 'cand' };

  test('null when neither stream has work', () => {
    expect(pickAction(null, null, opts(0))).toBeNull();
  });

  test('the only available stream wins', () => {
    expect(pickAction(rec({ accountPk: 'a' }), null, opts(0))).toBe('lifecycle');
    expect(pickAction(null, cand, opts(0.99))).toBe('prune');
  });

  test('a DUE lifecycle unfollow is never displaced by the weave', () => {
    const due = rec({ accountPk: 'a', state: 'unfollow_queued' });
    expect(pickAction(due, cand, opts(0))).toBe('lifecycle'); // even on the lowest draw
  });

  test('a follow interleaves with the prune only inside the fraction', () => {
    const due = rec({ accountPk: 'a', state: 'queued' });
    expect(pickAction(due, cand, opts(0.29, 0.3))).toBe('prune');
    expect(pickAction(due, cand, opts(0.3, 0.3))).toBe('lifecycle'); // boundary is exclusive
    expect(pickAction(due, cand, opts(0.9, 0.3))).toBe('lifecycle');
  });

  test('a zero fraction never weaves', () => {
    const due = rec({ accountPk: 'a', state: 'queued' });
    expect(pickAction(due, cand, opts(0, 0))).toBe('lifecycle');
  });

  test('no draw taken means no weave — the decision consumes no randomness', () => {
    const due = rec({ accountPk: 'a', state: 'queued' });
    expect(pickAction(due, cand, opts(null))).toBe('lifecycle');
  });
});

describe('acquireFailureVerdict', () => {
  test('the first walled cycles back off, counting up', () => {
    expect(acquireFailureVerdict(0, 'fetch-failed', 3)).toEqual({
      action: 'backoff',
      walledCycles: 1,
    });
    expect(acquireFailureVerdict(1, 'fetch-failed', 3)).toEqual({
      action: 'backoff',
      walledCycles: 2,
    });
  });

  test('the threshold-th failure in a row enters the ladder as rate-limited', () => {
    expect(acquireFailureVerdict(2, 'fetch-failed', 3)).toEqual({
      action: 'recover',
      kind: 'rate-limited',
    });
  });

  test('shape drift carries drift evidence into the ladder', () => {
    expect(acquireFailureVerdict(2, 'shape-mismatch', 3)).toEqual({
      action: 'recover',
      kind: 'drift',
    });
    // …but only at the escalation point; earlier drift still just backs off.
    expect(acquireFailureVerdict(0, 'shape-mismatch', 3)).toEqual({
      action: 'backoff',
      walledCycles: 1,
    });
  });
});
