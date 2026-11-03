/**
 * The protection port (spec §7.5, Appendix B.8): the index is read live on every call, and an
 * unreadable record's re-check waits the plan-day's own length × 1, 2, 4, 8.
 */
import { createProtectionPort, UNCONFIGURED_PROTECTION, unconfiguredProtection } from '@/engine/protection-port';
import { FakeClock } from '@/governors/clock';
import type { PlanDayClock } from '@/kernel/plan';
import { compileProtection, protectionVerdict } from '@/shared/unfollow-protection';
import { MS_PER_DAY, MS_PER_HOUR } from '@/timing/units';

const T0 = Date.UTC(2026, 10, 3, 12);

/** Plan-days of a fixed length starting at T0's day; `length` may be a DST day. */
const fixedDays = (length: number): PlanDayClock => ({
  window: (t) => {
    const startsAt = T0 - MS_PER_HOUR + Math.floor((t - T0 + MS_PER_HOUR) / length) * length;
    return { key: String(startsAt), startsAt, endsAt: startsAt + length, quietMinute: 0 };
  },
  dayKey: (t) => String(t),
  onRoll: () => () => undefined,
});

test('the re-check waits the plan-day length x 1, 2, 4, 8, then 8', () => {
  const port = createProtectionPort({ index: () => UNCONFIGURED_PROTECTION, clock: new FakeClock(T0), dayClock: fixedDays(MS_PER_DAY) });
  expect([1, 2, 3, 4, 5].map((n) => port.recheckDelayMs(n) / MS_PER_DAY)).toEqual([1, 2, 4, 8, 8]);
});

test('a 23-hour plan-day (DST) scales the re-check by its own length', () => {
  const day = 23 * MS_PER_HOUR;
  const port = createProtectionPort({ index: () => UNCONFIGURED_PROTECTION, clock: new FakeClock(T0), dayClock: fixedDays(day) });
  expect(port.recheckDelayMs(1)).toBe(day);
  expect(port.recheckDelayMs(3)).toBe(4 * day);
});

test('the index is live: a change behind the provider is seen on the next call', () => {
  let rev = 1;
  const port = createProtectionPort({
    index: () => compileProtection({ accounts: [], words: [], wordMatch: 'anywhere', keepVerified: rev > 1 }, 'ready', rev),
    clock: new FakeClock(T0), dayClock: fixedDays(MS_PER_DAY),
  });
  expect(port.index().keepVerified).toBe(false);
  rev = 2;
  expect(port.index().keepVerified).toBe(true);
});

test('an unconfigured rig protects no one and pauses nothing', () => {
  const idx = unconfiguredProtection(new FakeClock(T0)).index();
  expect(idx.state).toBe('ready');
  expect(protectionVerdict({ pk: '1', username: 'a', bio: undefined, isVerified: undefined }, idx)).toEqual({ kind: 'clear' });
});
