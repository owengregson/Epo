/**
 * The plan's pacing gate, directly (spec §5.16). Gating is a PURE verdict over the plan's facts: no clock,
 * no wait, no Engine — the park the plan demands, served exactly. The park itself comes from the view
 * (the day done, a closed session) and the exact velocity window; no gap is drawn here.
 */

import type { ClockFacts, PacingFacts } from '@/engine/facts';
import { planPark } from '@/engine/facts-plan';
import { type PacingInputs, pacingVerdict } from '@/engine/pacers';
import type { PlanFacts } from '@/engine/plan-port';
import { stubPlanView } from '../kit/harness-plan';

const T0 = Date.parse('2026-08-12T12:00:00');
const HOUR = 3_600_000;

const clock: ClockFacts = { now: T0 };

const plan = (park: PlanFacts['park'] = null): PacingFacts => ({
  sessionOpen: park === null,
  park,
  admits: { follow: true, unfollow: true, accept: true, explore: true },
  mix: 'normal',
  probation: false,
  reads: { exploreLeft: 0, reconcileLeft: 0 },
  checkDue: false,
  checkLight: false,
  censusDue: false,
});

const facts = (p: PacingFacts): PacingInputs => ({ clock, pacing: p });

describe('the plan pacing verdict', () => {
  test('an open session with headroom does not gate', () => {
    expect(pacingVerdict(facts(plan()))).toBeNull();
  });

  test.each([
    ['engine:daily-ceiling-park', 'waited-ceiling', 9 * HOUR],
    ['engine:session-park', 'waited-session', 45 * 60_000],
    ['engine:velocity-park', 'waited-session', 7 * 60_000],
    ['engine:read-budget-park', 'waited-session', 2 * HOUR],
  ] as const)("the plan's %s is served exactly", (key, step, ms) => {
    expect(pacingVerdict(facts(plan({ key, until: T0 + ms })))).toEqual({ key, delay: ms, step });
  });

  test('a park whose instant has passed waits nothing, never a negative delay', () => {
    expect(pacingVerdict(facts(plan({ key: 'engine:session-park', until: T0 - 10_000 }))))
      .toEqual({ key: 'engine:session-park', delay: 0, step: 'waited-session' });
  });
});

describe("the plan's park from its view", () => {
  test('an open session with volume left does not park', () => {
    expect(planPark(stubPlanView(T0, { open: true, nextSessionAt: null, target: 25 }), false)).toBeNull();
  });

  test('a closed session parks to the next session, or to the boundary when none is left', () => {
    const view = stubPlanView(T0, { open: false, nextSessionAt: T0 + HOUR, target: 25 });
    expect(planPark(view, false)).toEqual({ key: 'engine:session-park', until: T0 + HOUR });
    const none = stubPlanView(T0, { open: false, nextSessionAt: null, target: 25 });
    expect(planPark(none, false)).toEqual({ key: 'engine:session-park', until: none.window.endsAt });
  });

  test("the day done (V spent or the hard ceiling) parks to the next plan-day's first session", () => {
    const spent = stubPlanView(T0, { open: true, nextSessionAt: null, target: 25, usedAuto: 25 });
    expect(planPark(spent, false)).toEqual({ key: 'engine:daily-ceiling-park', until: spent.window.endsAt });
    const tomorrow = stubPlanView(T0, { open: false, nextSessionAt: T0 + 30 * HOUR, target: 25 });
    expect(planPark(tomorrow, true)).toEqual({ key: 'engine:daily-ceiling-park', until: T0 + 30 * HOUR });
  });

  test('a full rolling hour inside an open session parks exactly to its window; one already past does not', () => {
    const open = stubPlanView(T0, { open: true, nextSessionAt: null, target: 25 });
    expect(planPark(open, false, T0 + 12 * 60_000)).toEqual({ key: 'engine:velocity-park', until: T0 + 12 * 60_000 });
    expect(planPark(open, false, T0 - 1)).toBeNull();
    // The day done or a closed session outranks the rolling hour.
    const closed = stubPlanView(T0, { open: false, nextSessionAt: T0 + HOUR, target: 25 });
    expect(planPark(closed, false, T0 + 12 * 60_000)?.key).toBe('engine:session-park');
  });
});
