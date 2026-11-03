/**
 * I1 (spec §5.13 guarding test, §20.3): the rate oracle. The production cadence, rate governor, plan
 * service and store (the plan wiring the graph builds) are driven over simulated weeks the way the engine
 * loop drives them: preflight, arm at dispatch, settle, wait on the armed deadline, park on a refusal.
 * The pace matches the retired pacer's oracle, no rolling hour exceeds H, no day exceeds V or
 * automaticDayMax(P0), and the day law's mean matches the legacy oracle.
 */
import { automaticDayMax } from '@/kernel/plan/volume';
import { mulberry32 } from '@/kernel/rng';
import type { PlanWiring } from '@/main/services/plan-wiring';
import { DEFAULT_SETTINGS, type Settings, toRateGovernorConfig } from '@/settings/settings';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE } from '@/timing/units';
import { fakePlanHost, PLAN_TEST_RNG, type PlanClock, planClock, storePlanWiring } from '../kit/harness-plan';
import { legacyDay, legacyMeanGapMs } from '../kit/legacy-pacer-oracle';
import { openTestStore } from '../kit/store';

const FROM = Date.parse('2026-11-09T00:30:00');
const SETTINGS: Settings = { ...DEFAULT_SETTINGS, dryRun: false };
const opened: { plan: PlanWiring; store: KnowledgeStore }[] = [];
afterEach(() => {
  while (opened.length > 0) {
    const o = opened.pop();
    o?.plan.dispose();
    o?.store.close();
  }
});

function rig(settings: Settings = SETTINGS): { store: KnowledgeStore; clock: PlanClock; plan: PlanWiring } {
  const store = openTestStore(':memory:', { rng: PLAN_TEST_RNG });
  store.setOwnPk('me');
  const clock = planClock(FROM);
  const plan = storePlanWiring(store, clock, fakePlanHost(settings));
  opened.push({ plan, store });
  return { store, clock, plan };
}

/** One automatic follow, written through the journal the way a landed dispatch settles. */
function settle(store: KnowledgeStore, pk: string, at: number): void {
  const intent = store.beginEffectIntent({ accountPk: pk, username: pk, action: 'follow', channel: 'growth', at });
  store.markEffectDispatched(intent.id, at);
  store.settleEffectIntent(intent.id, { at, result: 'ok', ledger: 'growth' });
}

interface Run {
  events: { at: number; day: string; session: number }[];
  planned: Map<string, number>;
  hourlyParks: Set<number>;
  sessionHours: number;
}

/** The loop over `days`: act while admitted, wait on the armed deadline, park until a refusal's `until`. */
function drive(r: ReturnType<typeof rig>, days: number): Run {
  const { store, clock, plan } = r;
  const run: Run = { events: [], planned: new Map(), hourlyParks: new Set(), sessionHours: 0 };
  const rate = plan.rateGovernor(toRateGovernorConfig(SETTINGS));
  const seenSessions = new Set<string>();
  const end = FROM + days * MS_PER_DAY;
  for (let guard = 0, n = 0; clock.now() < end && guard < 100_000; guard += 1) {
    const now = clock.now();
    const view = plan.pacing.ensureIfProvisional(now);
    run.planned.set(view.window.key, view.plan.volume.planned);
    for (const s of view.plan.sessions) {
      const key = `${view.window.key}:${s.startAt}`;
      if (s.budget > 0 && !seenSessions.has(key)) {
        seenSessions.add(key);
        run.sessionHours += (s.expectedEndAt - s.startAt) / MS_PER_HOUR;
      }
    }
    const pk = `p${n}`;
    const admission = plan.cadence.preflight('follow', 'growth', now, { pk });
    if (admission.ok) {
      const deadline = plan.cadence.armAtDispatch('follow', 'growth', now, { pk });
      settle(store, pk, now);
      n += 1;
      run.events.push({ at: now, day: view.window.key, session: view.open?.idx ?? -1 });
      expect(rate.actionsInLastHour(now)).toBeLessThanOrEqual(SETTINGS.hourlyVelocityCap);
      clock.t = deadline;
      continue;
    }
    if (admission.reason === 'hourly-cap') run.hourlyParks.add(Math.floor(now / MS_PER_HOUR));
    const until = admission.until ?? view.nextSessionAt ?? view.window.endsAt;
    clock.t = until > now ? until : now + MS_PER_MINUTE;
  }
  return run;
}

describe('I1: the plan runtime against the retired pacer (Balanced / Standard)', () => {
  const r = rig();
  const run = drive(r, 21);
  const byDay = new Map<string, number>();
  for (const e of run.events) byDay.set(e.day, (byDay.get(e.day) ?? 0) + 1);

  test("the mean in-session gap is within [0.95, 1.25] × the oracle's jittered(3, 7, 30 %) mean", () => {
    const gaps = run.events.slice(1).flatMap((e, i) => {
      const prev = run.events[i];
      return prev.day === e.day && prev.session === e.session ? [e.at - prev.at] : [];
    });
    expect(gaps.length).toBeGreaterThan(200);
    const ratio = gaps.reduce((a, b) => a + b, 0) / gaps.length / legacyMeanGapMs(3 * MS_PER_MINUTE, 7 * MS_PER_MINUTE);
    expect(ratio).toBeGreaterThanOrEqual(0.95);
    expect(ratio).toBeLessThanOrEqual(1.25);
  });

  test('no rolling hour exceeds H; hourly parks touch under 1 % of session-hours', () => {
    const times = run.events.map((e) => e.at);
    for (let i = 0; i < times.length; i += 1) {
      const inHour = times.filter((t) => t > times[i] - MS_PER_HOUR && t <= times[i]).length;
      expect(inHour).toBeLessThanOrEqual(SETTINGS.hourlyVelocityCap);
    }
    expect(run.hourlyParks.size / run.sessionHours).toBeLessThan(0.01);
  });

  test('day totals stay within V, and no automatic day exceeds automaticDayMax(P0)', () => {
    const max = automaticDayMax(SETTINGS.dailyOperatingRate);
    const days = [...run.planned.keys()];
    expect(days.length).toBeGreaterThanOrEqual(20);
    for (const day of days) {
      expect(byDay.get(day) ?? 0).toBeLessThanOrEqual(run.planned.get(day) ?? 0);
      expect(run.planned.get(day) ?? 0).toBeLessThanOrEqual(max);
    }
    // Whole days (the first and last may be partial) realize their plan: a session its close cuts short
    // loses its rest (the plan's close rule), so the aggregate, not each day, is the pace guard.
    const whole = days.slice(1, -1);
    const sum = (f: (day: string) => number): number => whole.reduce((a, day) => a + f(day), 0);
    expect(sum((day) => byDay.get(day) ?? 0) / sum((day) => run.planned.get(day) ?? 0)).toBeGreaterThanOrEqual(0.95);
  });
});

test("I1: the mean automatic day is within ±2 % of the legacy oracle min(planner volume, cyclePlan)", () => {
  const { plan } = rig();
  const days = 2000;
  const volumes: number[] = [];
  let t = FROM;
  for (let d = 0; d < days; d += 1) {
    const view = plan.service.view(t);
    volumes.push(view.plan.volume.planned);
    t = view.window.endsAt;
  }
  const rng = mulberry32(0x1d1);
  const p0 = SETTINGS.dailyOperatingRate;
  const oracle = Array.from({ length: 20_000 }, (_, i) => legacyDay(p0, SETTINGS.dailyHardCeiling,
    SETTINGS.dailyVolumeVariancePct / 100, SETTINGS.restDayChancePct / 100, rng, FROM + i * 7919 * MS_PER_MINUTE));
  const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
  expect(Math.max(...volumes)).toBeLessThanOrEqual(automaticDayMax(p0));
  expect(Math.abs(mean(volumes) / mean(oracle) - 1)).toBeLessThanOrEqual(0.02);
});

test('I1: one accept pass draws exactly one deadline gap, owed after its last accept', () => {
  const r = rig();
  const owed: number[] = [];
  const { plan, store, clock } = r;
  const write = store.setActionDelayDeadline.bind(store);
  store.setActionDelayDeadline = (at) => {
    if (at !== null) owed.push(at - clock.now());
    write(at);
  };
  for (let d = 0; d < 14 && plan.service.view(clock.now()).open === null; d += 1) {
    const view = plan.pacing.ensureIfProvisional(clock.now());
    clock.t = view.nextSessionAt ?? view.window.endsAt;
  }
  plan.pacing.ensureIfProvisional(clock.now());
  expect(plan.service.view(clock.now()).open).not.toBeNull();
  let accepted = 0;
  while (accepted < 5 && plan.cadence.acceptAllowed(clock.now())) {
    plan.cadence.acceptPassEnded(clock.now());
    accepted += 1;
    clock.t += 1_000;
  }
  expect(accepted).toBeGreaterThan(1);
  // One draw for the pass: every accept re-owes the same gap after itself, so the deadline left is one gap.
  expect(new Set(owed).size).toBe(1);
  expect(store.getActionDelayDeadline()).toBe(clock.now() - 1_000 + owed[0]);
});
