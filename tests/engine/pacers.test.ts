/**
 * The two pacing models, directly. Gating is a PURE verdict over facts: no
 * clock, no wait, no Engine — which park each model demands, and the gap it
 * owes after an action. The plan's park itself comes from its view.
 */

import type { ClockFacts, LedgerFacts, PacingFacts } from '@/engine/facts';
import { planPark } from '@/engine/facts-plan';
import { LegacyPacer, type PacingInputs, PlanPacer, pacingVerdict } from '@/engine/pacers';
import type { EnginePacing, EngineRate } from '@/engine/ports';
import { ENGINE } from '@/timing/config';
import { sample } from '@/timing/primitives';
import { stubPlanView } from '../kit/harness-plan';

const T0 = Date.parse('2026-08-12T12:00:00');
const HOUR = 3_600_000;

const ledger = (over: Partial<LedgerFacts> = {}): LedgerFacts => ({
  atHardCeiling: false,
  atOperatingRate: false,
  withinActiveHours: true,
  msUntilCycleReset: 6 * HOUR,
  actionsInLastHour: 0,
  ...over,
});

const clock: ClockFacts = { now: T0 };

const plan = (over: { park?: { key: 'engine:session-park' | 'engine:daily-ceiling-park'; until: number } | null;
  hourlyCap?: number } = {}): PacingFacts => ({
  model: 'plan',
  hourlyCap: over.hourlyCap ?? 20,
  sessionOpen: (over.park ?? null) === null,
  park: over.park ?? null,
  admits: { follow: true, unfollow: true, accept: true, explore: true },
  mix: 'normal',
  probation: false,
  reads: { exploreLeft: 0, reconcileLeft: 0 },
  checkDue: false,
  checkLight: false,
  censusDue: false,
});

const legacy = (activeHoursStart = 0): PacingFacts => ({ model: 'legacy', activeHoursStart });

const facts = (l: LedgerFacts, p: PacingFacts): PacingInputs => ({ clock, ledger: l, pacing: p });

/** The ms a spec's delay resolves to, at the median draw. */
const ms = (spec: NonNullable<ReturnType<typeof pacingVerdict>>): number =>
  typeof spec.delay === 'number' ? spec.delay : sample(spec.delay, () => 0.5);

describe('the plan pacing verdict', () => {
  test('an open session with headroom does not gate', () => {
    expect(pacingVerdict(facts(ledger(), plan()))).toBeNull();
  });

  test("the plan's park is served exactly: the day done waits for the ceiling park", () => {
    const spec = pacingVerdict(facts(ledger(), plan({ park: { key: 'engine:daily-ceiling-park', until: T0 + 9 * HOUR } })));
    expect(spec?.key).toBe('engine:daily-ceiling-park');
    expect(spec?.step).toBe('waited-ceiling');
    expect(ms(spec as NonNullable<typeof spec>)).toBe(9 * HOUR);
  });

  test('a closed session parks until the next one opens, never negative', () => {
    const spec = pacingVerdict(facts(ledger(), plan({ park: { key: 'engine:session-park', until: T0 + 45 * 60_000 } })));
    expect(spec?.key).toBe('engine:session-park');
    expect(spec?.step).toBe('waited-session');
    expect(ms(spec as NonNullable<typeof spec>)).toBe(45 * 60_000);
    const past = pacingVerdict(facts(ledger(), plan({ park: { key: 'engine:session-park', until: T0 - 10_000 } })));
    expect(ms(past as NonNullable<typeof past>)).toBe(0);
  });

  test('the velocity backstop parks inside its configured band', () => {
    const spec = pacingVerdict(facts(ledger({ actionsInLastHour: 9 }), plan({ hourlyCap: 5 })));
    expect(spec?.key).toBe('engine:velocity-park');
    expect(spec?.step).toBe('waited-session');
    const drawn = ms(spec as NonNullable<typeof spec>);
    expect(drawn).toBeGreaterThanOrEqual(ENGINE.VELOCITY_PARK_MIN_MS);
    expect(drawn).toBeLessThanOrEqual(ENGINE.VELOCITY_PARK_MAX_MS);
  });

  test('the plan model ignores active hours entirely (sessions subsume them)', () => {
    expect(pacingVerdict(facts(ledger({ withinActiveHours: false, atOperatingRate: true }), plan()))).toBeNull();
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
});

describe('the legacy pacing verdict', () => {
  test('inside the window with headroom it does not gate', () => {
    expect(pacingVerdict(facts(ledger(), legacy()))).toBeNull();
  });

  test('outside active hours it parks until the window opens', () => {
    const spec = pacingVerdict(facts(ledger({ withinActiveHours: false }), legacy(18)));
    expect(spec?.key).toBe('engine:active-hours-park');
    expect(spec?.step).toBe('waited-active-hours');
    expect(ms(spec as NonNullable<typeof spec>)).toBe(Date.parse('2026-08-12T18:00:00') - T0);
  });

  test('the OPERATING rate stops the day, not only the hard ceiling', () => {
    const spec = pacingVerdict(facts(ledger({ atOperatingRate: true }), legacy()));
    expect(spec?.key).toBe('engine:daily-ceiling-park');
    expect(spec?.step).toBe('waited-ceiling');
  });

  test('the legacy model ignores the velocity facts', () => {
    expect(pacingVerdict(facts(ledger({ actionsInLastHour: 999 }), legacy()))).toBeNull();
  });
});

describe('the post-action gap', () => {
  test("plan: the plan's reference gap after the action", () => {
    const at: number[] = [];
    const port = { gapAfter: (t: number) => at.push(t) && 111_000 } as unknown as EnginePacing;
    expect(new PlanPacer(port).noteAction(T0, 'follow')).toBe(111_000);
    expect(at).toEqual([T0]);
  });

  test('legacy: the gap is the governor’s paced delay', () => {
    const rate = { nextDelayMs: () => 240_000 } as unknown as EngineRate;
    expect(new LegacyPacer(rate).noteAction(T0, 'follow')).toBe(240_000);
  });
});
