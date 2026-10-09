/**
 * The two pacing models, directly. Gating is now a PURE verdict over facts:
 * no clock, no wait, no Engine — which park each model demands, and the gap it
 * owes after an action.
 */

import type { ClockFacts, LedgerFacts, PacingFacts } from '@/engine/facts';
import { LegacyPacer, OrganicPacer, type PacingInputs, pacingVerdict } from '@/engine/pacers';
import type { EnginePacing, EngineRate } from '@/engine/ports';
import { ENGINE } from '@/timing/config';
import { sample } from '@/timing/primitives';

const T0 = Date.parse('2026-08-12T12:00:00');

const ledger = (over: Partial<LedgerFacts> = {}): LedgerFacts => ({
  atHardCeiling: false,
  atOperatingRate: false,
  withinActiveHours: true,
  msUntilCycleReset: 6 * 3_600_000,
  actionsInLastHour: 0,
  ...over,
});

const clock: ClockFacts = { now: T0 };

const organic = (over: Partial<PacingFacts> = {}): PacingFacts => ({
  model: 'organic',
  sessionOpen: true,
  nextSessionStartAt: T0,
  hourlyVelocityCap: 20,
  activeHoursStart: 0,
  ...over,
});

const legacy = (over: Partial<PacingFacts> = {}): PacingFacts => ({
  ...organic(over),
  model: 'legacy',
});

const facts = (l: LedgerFacts, p: PacingFacts): PacingInputs => ({ clock, ledger: l, pacing: p });

/** The ms a spec's delay resolves to, at the median draw. */
const ms = (spec: NonNullable<ReturnType<typeof pacingVerdict>>): number =>
  typeof spec.delay === 'number' ? spec.delay : sample(spec.delay, () => 0.5);

describe('the organic pacing verdict', () => {
  test('an open session with headroom does not gate', () => {
    expect(pacingVerdict(facts(ledger(), organic()))).toBeNull();
  });

  test('the hard ceiling parks until the cycle resets — before the session is consulted', () => {
    const spec = pacingVerdict(facts(ledger({ atHardCeiling: true }), organic({ sessionOpen: false })));
    expect(spec?.key).toBe('engine:daily-ceiling-park');
    expect(spec?.step).toBe('waited-ceiling');
    expect(ms(spec as NonNullable<typeof spec>)).toBe(6 * 3_600_000);
  });

  test('a closed session parks until the next one opens', () => {
    const spec = pacingVerdict(
      facts(ledger(), organic({ sessionOpen: false, nextSessionStartAt: T0 + 45 * 60_000 })),
    );
    expect(spec?.key).toBe('engine:session-park');
    expect(spec?.step).toBe('waited-session');
    expect(ms(spec as NonNullable<typeof spec>)).toBe(45 * 60_000);
  });

  test('a session that opened in the past never parks negative', () => {
    const spec = pacingVerdict(
      facts(ledger(), organic({ sessionOpen: false, nextSessionStartAt: T0 - 10_000 })),
    );
    expect(ms(spec as NonNullable<typeof spec>)).toBe(0);
  });

  test('the velocity backstop parks inside its configured band', () => {
    const spec = pacingVerdict(
      facts(ledger({ actionsInLastHour: 9 }), organic({ hourlyVelocityCap: 5 })),
    );
    expect(spec?.key).toBe('engine:velocity-park');
    expect(spec?.step).toBe('waited-session');
    const drawn = ms(spec as NonNullable<typeof spec>);
    expect(drawn).toBeGreaterThanOrEqual(ENGINE.VELOCITY_PARK_MIN_MS);
    expect(drawn).toBeLessThanOrEqual(ENGINE.VELOCITY_PARK_MAX_MS);
  });

  test('the organic model ignores active hours entirely (the session gate subsumes them)', () => {
    expect(pacingVerdict(facts(ledger({ withinActiveHours: false }), organic()))).toBeNull();
  });
});

describe('the legacy pacing verdict', () => {
  test('inside the window with headroom it does not gate', () => {
    expect(pacingVerdict(facts(ledger(), legacy()))).toBeNull();
  });

  test('outside active hours it parks until the window opens', () => {
    const spec = pacingVerdict(
      facts(ledger({ withinActiveHours: false }), legacy({ activeHoursStart: 18 })),
    );
    expect(spec?.key).toBe('engine:active-hours-park');
    expect(spec?.step).toBe('waited-active-hours');
    expect(ms(spec as NonNullable<typeof spec>)).toBe(Date.parse('2026-08-12T18:00:00') - T0);
  });

  test('the OPERATING rate stops the day, not only the hard ceiling', () => {
    const spec = pacingVerdict(facts(ledger({ atOperatingRate: true }), legacy()));
    expect(spec?.key).toBe('engine:daily-ceiling-park');
    expect(spec?.step).toBe('waited-ceiling');
  });

  test('the legacy model ignores the session and velocity facts', () => {
    expect(
      pacingVerdict(
        facts(ledger({ actionsInLastHour: 999 }), legacy({ sessionOpen: false, hourlyVelocityCap: 1 })),
      ),
    ).toBeNull();
  });
});

describe('the post-action gap', () => {
  test('organic: the planner records the action and owns the next gap', () => {
    const recorded: string[] = [];
    const planner = {
      recordAction: (_at: number, kind: string) => recorded.push(kind),
      nextActionGapMs: () => 111_000,
    } as unknown as EnginePacing;
    expect(new OrganicPacer(planner).noteAction(T0, 'follow')).toBe(111_000);
    expect(recorded).toEqual(['follow']);
  });

  test('legacy: the gap is the governor’s paced delay', () => {
    const rate = { nextDelayMs: () => 240_000 } as unknown as EngineRate;
    expect(new LegacyPacer(rate).noteAction(T0, 'follow')).toBe(240_000);
  });
});
