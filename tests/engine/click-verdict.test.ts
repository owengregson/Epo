/**
 * What a click verdict does to the record (spec §9.7): the churn scheduler's one writer of the review
 * columns. Re-holds, the not-due return, an account already gone, and the plan-derived parks with their
 * honest terminals; the verdicts that leave the record alone return it unchanged.
 */
import { applyClickVerdict } from '@/engine/click-verdict';
import type { ParkSlots } from '@/kernel/derive-parks';
import type { ClickVerdict } from '@/shared/click-verdict';
import type { FollowRecord } from '@/store/types';

const DAY = 86_400_000;
const T = Date.UTC(2026, 10, 3, 12);
const slots: ParkSlots = { nextSessionAt: T + 3_600_000, planDayStartAfter: (k) => T + k * DAY };
const ctx = { now: T, holdMs: 2 * DAY, followbackAfter: T - 5 * DAY, slots };
const queued = (over: Partial<FollowRecord> = {}): FollowRecord => ({
  accountPk: 'a', targetPk: 'seed', state: 'unfollow_queued', retryCount: 0, followedAt: T - 9 * DAY,
  unfollowReason: 'no-followback', ...over,
});

test('reheld: a follow-back seen at the click earns a fresh hold from now, dated by its best lower bound', () => {
  expect(applyClickVerdict(queued(), { kind: 'reheld' }, ctx)).toMatchObject({
    state: 'followed_back', followbackObservedAt: T, followbackAfter: T - 5 * DAY, holdUntil: T + 2 * DAY, reconciledAt: T,
  });
});

test('not-due goes back to followed_back with its hold; already-gone closes the record', () => {
  expect(applyClickVerdict(queued({ holdUntil: T + DAY }), { kind: 'not-due' }, ctx))
    .toMatchObject({ state: 'followed_back', holdUntil: T + DAY, reconciledAt: T });
  expect(applyClickVerdict(queued(), { kind: 'already-gone' }, ctx)).toMatchObject({ state: 'external', reconciledAt: T });
});

test('a readable verdict clears an earlier park', () => {
  const parked = queued({ parkReason: 'unreadable', checkFailures: 2, recheckAt: T - 1 });
  expect(applyClickVerdict(parked, { kind: 'already-gone' }, ctx))
    .toMatchObject({ parkReason: undefined, checkFailures: 0, recheckAt: undefined });
});

test('unavailable parks on the plan schedule and ends in its terminal', () => {
  expect(applyClickVerdict(queued(), { kind: 'unavailable', evidence: 'absent' }, ctx))
    .toMatchObject({ state: 'unfollow_queued', parkReason: 'unreachable', checkFailures: 1, recheckAt: T + DAY });
  expect(applyClickVerdict(queued({ checkFailures: 1 }), { kind: 'unavailable', evidence: 'renamed' }, ctx))
    .toMatchObject({ state: 'external', parkReason: 'unreachable', checkFailures: 2, recheckAt: undefined });
  expect(applyClickVerdict(queued(), { kind: 'unavailable', evidence: 'unreadable' }, ctx))
    .toMatchObject({ parkReason: 'unreadable', checkFailures: 1, recheckAt: T + 3_600_000 });
  expect(applyClickVerdict(queued({ checkFailures: 3 }), { kind: 'unavailable', evidence: 'unreadable' }, ctx))
    .toMatchObject({ state: 'abandoned', abandonedAt: T, checkFailures: 4 });
});

test('proceed, a pending request, protection and a deferral leave the record exactly as it was', () => {
  const rec = queued();
  const same: ClickVerdict[] = [
    { kind: 'proceed' }, { kind: 'request-pending' }, { kind: 'protected', by: 'account', match: 'a' },
    { kind: 'protection-unknown', missing: 'bio' }, { kind: 'protection-paused', state: 'needs-review' },
    { kind: 'deferred', reason: 'hourly-cap', until: T + 1 },
  ];
  for (const v of same) expect(applyClickVerdict(rec, v, ctx)).toBe(rec);
});
