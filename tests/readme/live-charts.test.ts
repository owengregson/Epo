import { growthCharts, paceCharts, planOneDay } from '@/readme/live-charts';
import { DEFAULT_SETTINGS } from '@/settings/settings';
import { MS_PER_HOUR } from '@/timing/units';

/**
 * The README's nightly panels draw REAL data — the growth model and the
 * shipping SessionPlanner on the default settings. These pin the contract the
 * charts advertise: the plan respects the active-hours wall and the daily cap,
 * a given date always renders the same bytes, and different dates visibly
 * differ (the turbulence phase and the plan are keyed by the run date).
 */
describe('README live charts', () => {
  const dayStart = new Date(2026, 7, 24).getTime(); // a fixed local midnight

  test('planOneDay stays inside the active-hours window and under the cap', () => {
    const plan = planOneDay(dayStart, 20260824);
    expect(plan.cap).toBeGreaterThan(0);
    expect(plan.target).toBeLessThanOrEqual(plan.cap);
    expect(plan.actions.length).toBeLessThanOrEqual(plan.target);
    expect(plan.actions.length).toBeGreaterThan(0);
    const windowStart = dayStart + DEFAULT_SETTINGS.activeHoursStart * MS_PER_HOUR;
    const windowEnd = dayStart + DEFAULT_SETTINGS.activeHoursEnd * MS_PER_HOUR;
    for (const at of plan.actions) {
      expect(at).toBeGreaterThanOrEqual(windowStart);
      expect(at).toBeLessThan(windowEnd);
    }
    // Ascending: cumulative dots must stair-step left to right.
    const sorted = [...plan.actions].sort((a, b) => a - b);
    expect(plan.actions).toEqual(sorted);
  });

  test('pace chart plots one dot per action in both themes, plus the cap line', () => {
    const plan = planOneDay(dayStart, 20260824);
    const { light, dark } = paceCharts(plan, '2026-08-24');
    for (const svg of [light, dark]) {
      expect((svg.match(/<circle/g) ?? []).length).toBe(plan.actions.length);
      expect(svg).toContain(`PLAN ${plan.target} / CAP ${plan.cap}`);
      expect(svg).toContain('DAILY CAP');
      expect(svg).toContain('stroke-dasharray="6 5"');
    }
  });

  test('growth chart is deterministic per date and varies across dates', () => {
    const a = growthCharts(236, '2026-08-24');
    const b = growthCharts(236, '2026-08-24');
    const c = growthCharts(237, '2026-08-25');
    expect(a.dark).toBe(b.dark);
    expect(a.dark).not.toBe(c.dark);
    expect(a.dark).toContain('RE-SIMULATED NIGHTLY · 2026-08-24');
    // The smooth endpoints come from the model alone — the date only moves the wiggle.
    const end = /\+\d+ best/.exec(a.dark)?.[0];
    expect(end).toBeDefined();
    expect(c.dark).toContain(end as string);
  });
});
