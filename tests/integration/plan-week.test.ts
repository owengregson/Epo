/**
 * I11 (spec §20.3): one simulated week per persona over the production plan wiring, cadence, read budget and
 * a real store, stepped the way the engine loop steps them. Every plan-day stays within its plan and within
 * automaticDayMax(P0); every gap is at or above its session's floor; no rolling hour exceeds the cap the write
 * ran under; every verify read is admitted inside the plan-day's D6 allowance and the plan's own reads fit D6.
 */
import { automaticDayMax } from '@/kernel/plan/volume';
import type { PlanWiring } from '@/main/services/plan-wiring';
import { effectiveFromV1 } from '@/settings/effective';
import { PERSONAS, type PersonaId } from '@/settings/pattern-map';
import { toReadAllowance } from '@/settings/read-allowance';
import { DEFAULT_SETTINGS, sanitizeSettings } from '@/settings/settings';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { MS_PER_HOUR } from '@/timing/units';
import { fakePlanHost, PLAN_TEST_RNG, planClock, storePlanWiring } from '../kit/harness-plan';
import { drivePlan, perDay } from '../kit/plan-drive';
import { openTestStore } from '../kit/store';

const FROM = Date.parse('2026-11-09T00:30:00');
const NAMED = Object.keys(PERSONAS) as Exclude<PersonaId, 'custom'>[];

describe.each(NAMED)('I11: a week as %s', (persona) => {
  const settings = sanitizeSettings({ ...DEFAULT_SETTINGS, persona, dryRun: false });
  const store: KnowledgeStore = openTestStore(':memory:', { rng: PLAN_TEST_RNG });
  store.setOwnPk('me');
  const clock = planClock(FROM);
  const plan: PlanWiring = storePlanWiring(store, clock, fakePlanHost(settings));
  const run = drivePlan(plan, store, clock, 8);
  const byDay = perDay(run);
  const days = [...run.plans.keys()];
  // The first and last plan-days are partial (a late first open, the drive's end): the week is the rest.
  const week = days.slice(1, -1);
  afterAll(() => {
    plan.dispose();
    store.close();
  });

  test('every plan-day stays within its plan and automaticDayMax(P0); the week realizes its plan', () => {
    const max = automaticDayMax(settings.dailyOperatingRate);
    expect(week.length).toBeGreaterThanOrEqual(6);
    for (const day of days) {
      const planned = run.plans.get(day)?.volume.planned ?? 0;
      expect({ day, done: byDay.get(day) ?? 0 }).toEqual({ day, done: expect.any(Number) });
      expect(byDay.get(day) ?? 0).toBeLessThanOrEqual(planned);
      expect(planned).toBeLessThanOrEqual(max);
    }
    const sum = (f: (day: string) => number): number => week.reduce((a, day) => a + f(day), 0);
    const planned = sum((day) => run.plans.get(day)?.volume.planned ?? 0);
    expect(planned).toBeGreaterThan(0);
    expect(sum((day) => byDay.get(day) ?? 0) / planned).toBeGreaterThanOrEqual(0.9);
  });

  test('every gap is at or above the floor of the session it was drawn in', () => {
    run.writes.slice(1).forEach((w, i) => {
      const prev = run.writes[i];
      expect(w.at - prev.at).toBeGreaterThanOrEqual(prev.floorMs);
    });
  });

  test('no rolling hour holds more writes than the cap each ran under', () => {
    for (let i = 0, lo = 0; i < run.writes.length; i += 1) {
      while (run.writes[lo].at <= run.writes[i].at - MS_PER_HOUR) lo += 1;
      expect(i - lo + 1).toBeLessThanOrEqual(run.writes[i].hourCap);
    }
  });

  test("every verify read fits the plan-day's D6 allowance, and the plan's own reads fit D6", () => {
    const effective = effectiveFromV1(settings);
    for (const day of days) {
      const p = run.plans.get(day);
      if (p === undefined) continue;
      const d6 = toReadAllowance(effective, p.demand);
      const r = p.reads;
      expect(byDay.get(day) ?? 0).toBeLessThanOrEqual(d6.profiles);
      expect(r.explore + r.reconcile + r.catchUp.profiles).toBeLessThanOrEqual(d6.profiles);
      expect(r.explorePages + r.census + r.following + r.checkPages + r.catchUp.pages).toBeLessThanOrEqual(d6.listPages);
      expect(r.checks + r.catchUp.notifications).toBeLessThanOrEqual(d6.notifications);
    }
  });

  test('every whole plan-day realizes exactly V.planned', () => {
    for (const day of week) {
      expect({ day, realized: byDay.get(day) ?? 0 }).toEqual({ day, realized: run.plans.get(day)?.volume.planned });
    }
  });
});
