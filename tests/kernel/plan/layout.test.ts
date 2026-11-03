/**
 * Law L5 (spec §5.4 steps 4–11): sessions are ordered inside the plan-day, separated by at least the
 * session boundary, end before the window does, never touch quiet hours; budgets apportion the
 * volume exactly (each kind too); proration never grows as the first open moves later.
 */
import fc from 'fast-check';
import { inQuietHours } from '@/kernel/plan/circadian';
import {
  apportion,
  apportionCapped,
  availableBlocks,
  fitVolume,
  lateJoinBudget,
  layoutSessions,
  SESSION_BOUNDARY_MS,
} from '@/kernel/plan/layout';
import { planSeed } from '@/kernel/plan/seed';
import { allocateKinds } from '@/kernel/plan/volume';
import { MS_PER_HOUR, MS_PER_MINUTE } from '@/kernel/units';
import { drawInput, emptyDemand, testIntent } from '../../kit/plan';

const DAY0 = new Date(2026, 10, 3, 12).getTime();
const minuteOf = (t: number): number => new Date(t).getHours() * 60 + new Date(t).getMinutes();

const laid = (dayOffset: number, volume: number, over: Parameters<typeof drawInput>[1] = {}) => {
  const input = drawInput(DAY0 + dayOffset * 24 * MS_PER_HOUR, over);
  const seed = planSeed(input.installEntropy, input.window.key);
  const v = fitVolume(seed, input, volume);
  const kinds = allocateKinds(v, input.intent, emptyDemand({ lifecycleDueByDayEnd: 5, pendingRequests: 2 }), false);
  return { input, v, kinds, sessions: layoutSessions(seed, input, v, kinds) };
};

describe('apportionment', () => {
  test('largest remainder: exact totals, every share ≥ the floor', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 200 }), fc.array(fc.double({ min: 0.05, max: 5, noNaN: true }), { minLength: 1, maxLength: 9 }),
      (extra, w) => {
        const total = w.length + extra;
        const out = apportion(total, w, 1);
        return out.reduce((a, b) => a + b, 0) === total && out.every((x) => x >= 1);
      }));
  });

  test('capped apportionment keeps totals exact and overflows at most one per session', () => {
    fc.assert(fc.property(fc.array(fc.integer({ min: 1, max: 20 }), { minLength: 1, maxLength: 9 }), fc.double({ min: 0, max: 1, noNaN: true }),
      (budgets, share) => {
        const caps = budgets.map((b) => Math.floor(b / 2));
        const total = Math.floor(budgets.reduce((a, b) => a + b, 0) / 2 * share);
        const out = apportionCapped(total, budgets.map((b) => b), caps);
        return out.reduce((a, b) => a + b, 0) === total && out.every((x, i) => x <= caps[i] + 1 && x <= budgets[i]);
      }));
  });
});

describe('L5: the layout', () => {
  test('ordered, separated, inside the window, clear of quiet hours; budgets and kinds exact', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 60 }), fc.integer({ min: 1, max: 97 }), fc.constantFrom(0.43, 1, 1.61),
      fc.constantFrom('trickle', 'sessions', 'bursts'), (day, volume, k, rhythm) => {
        const sessions = { trickle: { min: 5, max: 9 }, sessions: { min: 3, max: 6 }, bursts: { min: 2, max: 4 } }[rhythm];
        const { input, v, kinds, sessions: ss } = laid(day, volume, { intent: testIntent({ consistencyScale: k, sessions }) });
        const { startsAt, endsAt } = input.window;
        let ok = ss.reduce((a, s) => a + s.budget, 0) === v;
        for (const [i, s] of ss.entries()) {
          ok &&= s.startAt >= startsAt && s.expectedEndAt <= endsAt + 1 && s.budget >= 1;
          if (i > 0) ok &&= s.startAt >= ss[i - 1].expectedEndAt + SESSION_BOUNDARY_MS - 1;
          for (let t = s.startAt; t < s.expectedEndAt; t += 5 * MS_PER_MINUTE) ok &&= !inQuietHours(minuteOf(t), input.intent.quietHours);
          ok &&= s.mix.follow + s.mix.unfollow + s.mix.accept <= s.budget && s.mix.unfollow <= Math.floor(s.budget / 2) + 1;
        }
        for (const kind of ['follow', 'unfollow', 'accept'] as const) ok &&= ss.reduce((a, s) => a + s.mix[kind], 0) === kinds[kind];
        return ok && ss.length <= 9;
      }), { numRuns: 60 });
  });

  test('a layout is a property of the day: the same input lays out the same sessions', () => {
    expect(laid(3, 40).sessions).toEqual(laid(3, 40).sessions);
  });

  test('proration never grows as the first open moves later, and zeroes only sessions already over', () => {
    const base = laid(5, 44);
    let prev = Number.POSITIVE_INFINITY;
    for (let h = 0; h <= 24; h += 2) {
      const open = base.input.window.startsAt + h * MS_PER_HOUR;
      const { sessions } = laid(5, 44, { firstOpenAt: open });
      const kept = sessions.reduce((a, s) => a + s.budget, 0);
      expect(kept).toBeLessThanOrEqual(prev);
      prev = kept;
      for (const s of sessions) expect(s.before === 'first-open').toBe(s.expectedEndAt <= open);
    }
    expect(prev).toBe(0);
  });

  test('when sessions cannot fit the free time the volume shrinks to fit (session-time)', () => {
    const tight = testIntent({ hourlyCap: 14, quietHours: { startMinute: 20 * 60, endMinute: 10 * 60 }, operatingRate: 100 });
    const { v, sessions } = laid(2, 97, { intent: tight });
    expect(v).toBeLessThan(97);
    expect(v).toBeGreaterThan(0);
    expect(sessions.reduce((a, s) => a + s.budget, 0)).toBe(v);
  });

  test('free time is the window minus quiet hours', () => {
    const input = drawInput(DAY0);
    const free = availableBlocks(input.window, input.intent).reduce((a, b) => a + b.to - b.from, 0);
    expect(free / MS_PER_HOUR).toBeCloseTo(24 - 6.5, 1);
  });

  test('a late join gets only what still fits before the expected end', () => {
    const s = laid(1, 40).sessions[0];
    expect(lateJoinBudget(s, s.startAt)).toBe(Math.min(s.budget, Math.floor((s.expectedEndAt - s.startAt) / s.tempo.gap.targetMeanMs)));
    expect(lateJoinBudget(s, s.expectedEndAt - s.tempo.gap.targetMeanMs)).toBe(Math.min(1, s.budget));
    expect(lateJoinBudget(s, s.expectedEndAt + 1)).toBe(0);
  });
});
