/**
 * The unconfirmed-actions breaker (spec §11.1 F7): two writes of a kind Instagram answered with nothing
 * hold that kind for the rest of the session; the next session allows one attempt; the third enters the
 * ladder; any confirmed write of the kind resets it. The other kind is never held.
 */
import { UnconfirmedBreaker } from '@/engine/unconfirmed-breaker';
import { blockedStreakThreshold, driftConfirmThreshold } from '@/kernel/derive';

const T0 = 1_000_000;
const NEXT_SESSION = T0 + 3_600_000;

test('the thresholds are the derived ones: hold at two, the ladder at three', () => {
  expect(driftConfirmThreshold()).toBe(2);
  expect(blockedStreakThreshold()).toBe(3);
});

test('two unverified unfollows hold unfollows until the next session; follows are never held', () => {
  const b = new UnconfirmedBreaker();
  expect(b.note('unfollow', true, T0, NEXT_SESSION)).toBe(1);
  expect(b.held(T0)).toBeNull();
  expect(b.note('unfollow', true, T0 + 1, NEXT_SESSION)).toBe(2);
  expect(b.held(T0 + 2)).toEqual({ kind: 'unfollow', streak: 2 });
  expect(b.note('follow', false, T0 + 3, NEXT_SESSION)).toBe(0);
  expect(b.held(T0 + 3)).toEqual({ kind: 'unfollow', streak: 2 });
  // The next session allows one attempt.
  expect(b.held(NEXT_SESSION)).toBeNull();
});

test('the third unverified after the hold enters the ladder; a confirmed write resets the kind', () => {
  const b = new UnconfirmedBreaker();
  b.note('unfollow', true, T0, NEXT_SESSION);
  b.note('unfollow', true, T0 + 1, NEXT_SESSION);
  const third = b.note('unfollow', true, NEXT_SESSION + 1, NEXT_SESSION + 3_600_000);
  expect(UnconfirmedBreaker.entersLadder(third)).toBe(true);
  expect(b.note('unfollow', false, NEXT_SESSION + 2, NEXT_SESSION + 3_600_000)).toBe(0);
  expect(b.held(NEXT_SESSION + 3)).toBeNull();
  expect(UnconfirmedBreaker.entersLadder(b.note('unfollow', true, NEXT_SESSION + 4, NEXT_SESSION + 3_600_000))).toBe(false);
});
