/**
 * The plan's one writer over a real store (spec §5.13 S1, §20.3): status reads never write (I4), a
 * restart mid-session finds the same plan and the same open session (I5), and a six-hour close lets
 * the missed sessions expire, Start between sessions parks exactly, and a late first open prorates
 * the sessions already over (I8).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Engine } from '@/engine/engine';
import type { PlanView } from '@/governors/plan-types';
import { ReadBudget } from '@/governors/read-budget';
import { MS_PER_HOUR, MS_PER_MINUTE } from '@/kernel/units';
import type { PlanWiring } from '@/main/services/plan-wiring';
import { planWiringParts } from '@/main/services/plan-wiring';
import { effectiveFromV1 } from '@/settings/effective';
import { toReadAllowance } from '@/settings/read-allowance';
import { DEFAULT_SETTINGS, toRateGovernorConfig } from '@/settings/settings';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { DelayManager } from '@/timing/delay-manager';
import { testDeps } from '../kit/engine-harness';
import { fakePlanHost, idealDay, PLAN_TEST_RNG, type PlanClock, planClock, storePlanWiring } from '../kit/harness-plan';
import { openTestStore } from '../kit/store';

const T0 = new Date(2026, 10, 9, 12).getTime();
const dirs: string[] = [];
const stores: KnowledgeStore[] = [];
const wirings: PlanWiring[] = [];

/** A store on disk (so a restart can reopen it), with the pinned install entropy. */
function diskStore(dir = mkdtempSync(path.join(tmpdir(), 'epo-plan-'))): { store: KnowledgeStore; dir: string } {
  if (!dirs.includes(dir)) dirs.push(dir);
  const store = openTestStore(path.join(dir, 'epo.db'), { rng: PLAN_TEST_RNG });
  stores.push(store);
  return { store, dir };
}

/** The graph's plan, built now: the build ensures the plan once. */
function build(store: KnowledgeStore, clock: PlanClock): PlanWiring {
  const plan = storePlanWiring(store, clock);
  wirings.push(plan);
  return plan;
}

/** Close one process: its plan's triggers stop and its store closes. */
function close(plan: PlanWiring, store: KnowledgeStore): void {
  plan.dispose();
  wirings.splice(wirings.indexOf(plan), 1);
  store.close();
  stores.splice(stores.indexOf(store), 1);
}

afterEach(() => {
  while (wirings.length > 0) wirings.pop()?.dispose();
  while (stores.length > 0) stores.pop()?.close();
});
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const kept = (v: PlanView) => v.plan.sessions.filter((s) => s.budget > 0);

describe('I4 — status reads never write plan_state', () => {
  test('the build writes the plan once; N composed status reads leave plan_state byte-identical', () => {
    const day = idealDay(T0);
    const { store } = diskStore();
    const clock = planClock(kept(day)[0].startAt);
    const host = fakePlanHost();
    const plan = storePlanWiring(store, clock, host);
    wirings.push(plan);
    const raw = store.getPlanState();
    expect(raw).not.toBeNull();
    const reads = new ReadBudget({ store, clock, limits: () => toReadAllowance(effectiveFromV1(DEFAULT_SETTINGS)) });
    const contributors = planWiringParts(plan, reads, store, { plan: host }).statusContributors;
    const writes = jest.spyOn(store, 'setPlanState');
    for (let t = clock.t; t < day.window.endsAt; t += 7 * MS_PER_MINUTE) {
      clock.t = t;
      for (const c of contributors) c.contribute(null, t);
      plan.dayClock.window(t);
    }
    expect(writes).not.toHaveBeenCalled();
    expect(store.getPlanState()).toBe(raw);
  });

  test("the engine's status is pure too, and its today counts from the plan-day, not midnight", () => {
    const day = idealDay(T0);
    const { store } = diskStore();
    const clock = planClock(T0);
    const plan = build(store, clock);
    const engine = new Engine({
      ...testDeps({ store, clock, rate: plan.rateGovernor(toRateGovernorConfig(DEFAULT_SETTINGS)) }),
      pacing: plan.pacing,
    });
    const raw = store.getPlanState();
    const writes = jest.spyOn(store, 'setPlanState');
    for (let t = T0; t < day.window.endsAt; t += 11 * MS_PER_MINUTE) {
      clock.t = t;
      const { planned } = plan.service.view(t).plan.volume;
      expect(engine.status().plannedToday).toBe(planned);
    }
    expect(writes).not.toHaveBeenCalled();
    expect(store.getPlanState()).toBe(raw);

    clock.t = T0;
    const start = plan.service.view(T0).window.startsAt;
    const midnight = new Date(new Date(T0).setHours(0, 0, 0, 0)).getTime();
    store.setOwnPk('ME');
    store.ensureFollowersBaseline(midnight - MS_PER_HOUR);
    store.observeOwnFollowerEvent('early', 'ME', Math.max(midnight + MS_PER_MINUTE, start - 10 * MS_PER_MINUTE));
    store.observeOwnFollowerEvent('later', 'ME', start + MS_PER_MINUTE);
    expect(start).toBeGreaterThan(midnight + MS_PER_MINUTE);
    expect(engine.status().netToday).toBe(1);
  });
});

describe('I5 — a restart mid-session', () => {
  test('a new process finds the same plan, the same open session and the ledger usage, and writes nothing', () => {
    const session = kept(idealDay(T0))[0];
    const { store, dir } = diskStore();
    const clock = planClock(session.startAt + MS_PER_MINUTE);
    const first = build(store, clock);
    const before = first.service.view(clock.t);
    store.recordAction('a1', 'follow', 'ok', clock.t);
    const raw = store.getPlanState();
    close(first, store);

    const reopened = diskStore(dir).store;
    clock.t += 2 * MS_PER_MINUTE;
    const after = build(reopened, clock).service.view(clock.t);
    expect(reopened.getPlanState()).toBe(raw);
    expect(after.provisional).toBe(false);
    expect(after.plan.revision).toBe(before.plan.revision);
    expect(after.plan.seed).toBe(before.plan.seed);
    expect(after.open?.idx).toBe(before.open?.idx);
    expect(after.used.auto).toBe(1);
    expect(after.sessions[after.open?.idx ?? -1]?.used).toBe(1);
  });
});

describe('I8 — a six-hour close and a late first open', () => {
  test('sessions missed while closed expire with no catch-up; the reopen does not re-draw the plan', () => {
    const first = kept(idealDay(T0))[0];
    const { store, dir } = diskStore();
    const clock = planClock(first.startAt);
    const plan = build(store, clock);
    const opened = plan.service.view(clock.t);
    store.recordAction('a1', 'follow', 'ok', clock.t);
    const raw = store.getPlanState();
    close(plan, store);

    clock.t += 6 * MS_PER_HOUR;
    const reopened = diskStore(dir).store;
    const back = build(reopened, clock).service.view(clock.t);
    expect(reopened.getPlanState()).toBe(raw);
    expect(back.plan.revision).toBe(opened.plan.revision);
    back.plan.sessions.forEach((s, i) => {
      const windowEnd = back.plan.sessions[i + 1]?.startAt ?? back.plan.window.endsAt;
      if (s.budget > 0 && i > 0 && windowEnd <= clock.t) expect(back.sessions[i].state).toBe('skipped');
    });
    const left = back.sessions.filter((s) => s.state === 'now' || s.state === 'next' || s.state === 'later');
    expect(back.R).toBe(left.reduce((a, s) => a + Math.max(0, s.budget - s.used), 0));
  });

  test('Start between two sessions parks exactly until the next one opens', async () => {
    const [first, second] = kept(idealDay(T0));
    const { store } = diskStore();
    const clock = planClock(first.expectedEndAt + MS_PER_MINUTE);
    const plan = build(store, clock);
    const sleeps: number[] = [];
    const sleep = (ms: number): Promise<void> => {
      sleeps.push(ms);
      return Promise.resolve();
    };
    const delays = new DelayManager({ clock, sleep });
    const rate = plan.rateGovernor(toRateGovernorConfig(DEFAULT_SETTINGS));
    const engine = new Engine({ ...testDeps({ store, clock, rate, delays }), pacing: plan.pacing });
    expect(await engine.stepOnce()).toBe('waited-session');
    expect(sleeps).toEqual([second.startAt - clock.t]);
    expect(plan.service.view(clock.t).nextSessionAt).toBe(second.startAt);
  });

  test('a first open after a session ended prorates it to nothing; planned volume keeps only the rest', () => {
    const ideal = idealDay(T0);
    const { store } = diskStore();
    const clock = planClock(kept(ideal)[0].expectedEndAt + MS_PER_MINUTE);
    const late = build(store, clock).service.view(clock.t);
    const prorated = late.plan.sessions.filter((s) => s.before === 'first-open');
    expect(prorated.length).toBeGreaterThan(0);
    expect(prorated.every((s) => s.budget === 0)).toBe(true);
    expect(late.plan.firstOpenAt).toBe(clock.t);
    expect(late.plan.volume.planned).toBe(late.plan.sessions.reduce((a, s) => a + s.budget, 0));
    expect(late.plan.volume.planned).toBeLessThan(ideal.plan.volume.planned);
  });
});
