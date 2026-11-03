/**
 * Law L7 (spec §5.2) with L3 and L11 beside it: identical inputs draw byte-identical plans; A → B → A
 * restores plan(A); a repair is an identity for the current window. Each session's planned unfollow
 * rate stays under the unfollow cap's sustained rate (L3), and no in-step wait at the slowest pace
 * and the largest tempo override reaches the step watchdog (L11).
 */
import fc from 'fast-check';
import { RECOVERY } from '@/kernel/derive';
import { drawBase, drawDayPlan, replanRemainder } from '@/kernel/plan/draw';
import { NO_USAGE } from '@/kernel/plan/status';
import { POLICY } from '@/kernel/policy';
import { SETTINGS_POLICY } from '@/kernel/settings-policy';
import { REFERENCE_TEMPO, resolve, TEMPO_KEYS, TEMPO_SPECS, type TempoKey } from '@/kernel/tempo';
import { MS_PER_DAY, MS_PER_HOUR } from '@/kernel/units';
import { drawInput, emptyDemand, testIntent, windowFor } from '../../kit/plan';

const DAY0 = new Date(2026, 10, 3, 12).getTime();

describe('L7: determinism', () => {
  test('identical inputs draw byte-identical plans', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 90 }), fc.integer({ min: 0, max: 0xffffffff }), (day, entropy) => {
      const input = drawInput(DAY0 + day * MS_PER_DAY, { installEntropy: entropy });
      return JSON.stringify(drawDayPlan(input)) === JSON.stringify(drawDayPlan({ ...input }));
    }), { numRuns: 30 });
  });

  test('A → B → A restores plan(A) (common random numbers)', () => {
    const a = drawInput(DAY0);
    const b = { ...a, intent: testIntent({ hourlyCap: 14, sessions: { min: 5, max: 9 } }) };
    const planA = drawDayPlan(a);
    expect(drawDayPlan(b)).not.toEqual(planA);
    expect(drawDayPlan({ ...b, intent: a.intent })).toEqual(planA);
  });

  test('a repair re-derives the identical plan for the current window', () => {
    const input = drawInput(DAY0, { firstOpenAt: windowFor(DAY0).startsAt + 9 * MS_PER_HOUR });
    const plan = drawDayPlan(input);
    const repaired = replanRemainder(plan, input, input.firstOpenAt + MS_PER_HOUR, NO_USAGE, 'repair');
    expect(repaired.sessions).toEqual(plan.sessions);
    expect(repaired.revision).toBe(plan.revision + 1);
  });
});

test('L3: each session plans unfollows under the unfollow cap\'s sustained rate', () => {
  for (let day = 0; day < 30; day += 1) {
    const intent = testIntent({ cleanupShare: 0.71 });
    const plan = drawBase(drawInput(DAY0 + day * MS_PER_DAY, { intent, demand: emptyDemand({ lifecycleDueByDayEnd: 12, pruneStock: 90 }) }));
    for (const s of plan.sessions.filter((x) => x.mix.unfollow > 0)) {
      const perHour = s.mix.unfollow / ((s.expectedEndAt - s.startAt) / MS_PER_HOUR);
      expect(perHour).toBeLessThanOrEqual(intent.unfollowHourlyCap / POLICY.CEILING_HEADROOM + 1e-9);
    }
  }
});

test('L11: no in-step wait at the slowest pace and the largest override reaches the step watchdog', () => {
  const slowest = { ...REFERENCE_TEMPO, pace: 1.45, motion: 1.45 ** 0.5, depth: 1 / 1.45 };
  // Parks and session gaps are registered engine waits, not in-step silences.
  const parks: readonly TempoKey[] = ['gap.action', 'check.spacing', 'backoff.walled'];
  for (const key of TEMPO_KEYS.filter((k) => !parks.includes(k))) {
    const p = resolve(key, slowest, SETTINGS_POLICY.TEMPO_OVERRIDE_MAX_FACTOR).prior;
    const max = p.shape === 'band' || p.shape === 'logn' ? p.max : p.shape === 'base' ? p.value
      : p.shape === 'mix' ? Math.max((p.base as { max: number }).max, (p.alt as { max: number }).max) : 0;
    expect([key, max < RECOVERY.STEP_WATCHDOG_MS]).toEqual([key, true]);
  }
  expect(TEMPO_SPECS['gap.action'].prior.shape).toBe('gap');
});
