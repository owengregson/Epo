/**
 * The kept re-check schedule (spec §7.5): an unreadable record waits 1, 2, 4, then 8 plan-days
 * between reads, never longer, so at most one visit per record per window. And the park schedule
 * of an unavailable record or intent (spec §9.9), with law L13.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { retryLimit } from '@/kernel/derive-lifecycle';
import {
  goneConfirmations, keptRecheckPlanDays, type ParkKind, type ParkSlots, parkTerminal, parkUntil,
} from '@/kernel/derive-parks';
import { SETTINGS_POLICY } from '@/kernel/settings-policy';

test('1/2/4/8 plan-days, then capped at 2^KEEP_RECHECK_DOUBLINGS', () => {
  expect([1, 2, 3, 4, 5, 9].map(keptRecheckPlanDays)).toEqual([1, 2, 4, 8, 8, 8]);
  expect(keptRecheckPlanDays(99)).toBe(2 ** SETTINGS_POLICY.KEEP_RECHECK_DOUBLINGS);
});

test('a count below one reads as the first re-check', () => {
  expect(keptRecheckPlanDays(0)).toBe(1);
  expect(keptRecheckPlanDays(-3)).toBe(1);
});

test('law: monotone non-decreasing, a whole number of plan-days, within [1, 2^doublings]', () => {
  const cap = 2 ** SETTINGS_POLICY.KEEP_RECHECK_DOUBLINGS;
  fc.assert(fc.property(fc.integer({ min: -5, max: 60 }), fc.integer({ min: 0, max: 10 }), (n, step) => {
    const a = keptRecheckPlanDays(n);
    const b = keptRecheckPlanDays(n + step);
    expect(Number.isInteger(a)).toBe(true);
    expect(a).toBeGreaterThanOrEqual(1);
    expect(a).toBeLessThanOrEqual(cap);
    expect(b).toBeGreaterThanOrEqual(a);
  }), { numRuns: 300 });
});

describe('the park schedule of an unavailable record or intent (spec §9.9)', () => {
  const DAY = 86_400_000;
  /** Plan-days starting at `start` + k days; the next session at `session` (null: none left today). */
  const slotsAt = (start: number, session: number | null): ParkSlots => ({
    nextSessionAt: session,
    planDayStartAfter: (k) => start + k * DAY,
  });

  test('two gone readings end it; three unreadable re-reads, the fourth ends it', () => {
    expect(goneConfirmations()).toBe(2);
    expect([1, 2, 3].map((k) => parkTerminal('unreachable', k))).toEqual([false, true, true]);
    expect([1, 2, 3, 4, 5].map((k) => parkTerminal('unreadable', k))).toEqual([false, false, false, true, true]);
  });

  test("the unreadable re-reads are the plan core's retryLimit(): one derivation (spec C18)", () => {
    expect([parkTerminal('unreadable', retryLimit()), parkTerminal('unreadable', retryLimit() + 1)]).toEqual([false, true]);
    expect(readFileSync(join(__dirname, '..', '..', 'src', 'kernel', 'derive-parks.ts'), 'utf8')).not.toMatch(/RETRY_CONFIDENCE/);
  });

  test('unreachable waits for a new plan-day each time; unreadable first for the next session', () => {
    const s = slotsAt(1_000, 500);
    expect([1, 2, 3].map((k) => parkUntil('unreachable', k, s))).toEqual([1_000 + DAY, 1_000 + 2 * DAY, 1_000 + 3 * DAY]);
    expect([1, 2, 3].map((k) => parkUntil('unreadable', k, s))).toEqual([500, 1_000 + DAY, 1_000 + 2 * DAY]);
  });

  test('with no session left the first unreadable park waits for the next plan-day', () => {
    expect(parkUntil('unreadable', 1, slotsAt(1_000, null))).toBe(1_000 + DAY);
  });

  test('law L13: non-decreasing in k, an unreachable park always crosses a plan-day boundary', () => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 2_000_000_000 }), fc.option(fc.integer({ min: 1, max: 3 * DAY }), { nil: null }),
      fc.constantFrom<ParkKind>('unreachable', 'unreadable'), fc.integer({ min: -2, max: 30 }),
      (start, offset, kind, k) => {
        const s = slotsAt(start, offset === null ? null : start - DAY + offset);
        expect(parkUntil(kind, k + 1, s)).toBeGreaterThanOrEqual(parkUntil(kind, k, s));
        if (kind === 'unreachable') expect(parkUntil(kind, k, s)).toBeGreaterThanOrEqual(s.planDayStartAfter(1));
        expect(parkTerminal(kind, k)).toBe(kind === 'unreachable' ? k >= goneConfirmations() : k > 3);
      },
    ), { numRuns: 400 });
  });
});
