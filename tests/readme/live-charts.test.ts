import { MS_PER_DAY, MS_PER_HOUR } from '@/timing/units';
import * as liveCharts from '@/tools/readme/live-charts';
import { paceCharts, planOneDay } from '@/tools/readme/live-charts';

/**
 * The README's nightly panel draws REAL data — the shipping day plan on the default settings: the plan
 * keeps its actions inside its sessions and under the daily cap, and a given date renders the same bytes.
 */
describe('README live charts', () => {
  const dayStart = new Date(2026, 7, 24).getTime(); // a fixed local midnight

  test('planOneDay keeps its actions inside its sessions and under the cap', () => {
    const plan = planOneDay(dayStart, 20260824);
    expect(plan.cap).toBeGreaterThan(0);
    expect(plan.target).toBeLessThanOrEqual(plan.cap);
    expect(plan.actions.length).toBeLessThanOrEqual(plan.target);
    expect(plan.actions.length).toBeGreaterThan(0);
    const firstStart = dayStart + plan.activeStartHour * MS_PER_HOUR;
    for (const at of plan.actions) {
      expect(at).toBeGreaterThanOrEqual(firstStart);
      expect(at).toBeLessThan(dayStart + MS_PER_DAY + MS_PER_DAY);
    }
    expect(planOneDay(dayStart, 20260824)).toEqual(plan);
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

  test('no simulated growth panel: growth is measured only (owner Q30), so the projection left the charts', () => {
    expect('growthCharts' in liveCharts).toBe(false);
  });
});
