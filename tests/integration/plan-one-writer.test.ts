/**
 * The plan's one writer over a real store (spec §5.13 S1, §20.3): status reads never write (I4), a
 * restart mid-session finds the same plan and the same open session (I5), and a six-hour close lets
 * the missed sessions expire while a late first open prorates the sessions already over (I8).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { PlanView } from '@/governors/plan-types';
import { ReadBudget } from '@/governors/read-budget';
import { MS_PER_HOUR, MS_PER_MINUTE } from '@/kernel/units';
import { planWiringParts } from '@/main/services/plan-wiring';
import { toReadAllowance } from '@/settings/read-allowance';
import { DEFAULT_SETTINGS } from '@/settings/settings';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { busyDay, fakePlanHost, planClock, storePlan, storePlanWiring } from '../kit/harness-plan';
import { openTestStore } from '../kit/store';

const T0 = new Date(2026, 10, 9, 12).getTime();
const dirs: string[] = [];
const stores: KnowledgeStore[] = [];

/** A store on disk (so a restart can reopen it), with a pinned install entropy. */
function diskStore(dir = mkdtempSync(path.join(tmpdir(), 'epo-plan-'))): { store: KnowledgeStore; dir: string } {
  if (!dirs.includes(dir)) dirs.push(dir);
  const store = openTestStore(path.join(dir, 'epo.db'), { rng: () => 0.375 });
  stores.push(store);
  return { store, dir };
}

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
});
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const kept = (v: PlanView) => v.plan.sessions.filter((s) => s.budget > 0);

describe('I4 — status reads never write plan_state', () => {
  test('before the first ensure nothing is written; after it N composed reads leave plan_state byte-identical', () => {
    const { store } = diskStore();
    const clock = planClock(T0);
    const host = fakePlanHost();
    const plan = storePlanWiring(store, clock, host);
    const reads = new ReadBudget({ store, clock, limits: () => toReadAllowance(DEFAULT_SETTINGS) });
    const contributors = planWiringParts(plan, reads, store, { plan: host }).statusContributors;
    const statusAt = (t: number) => contributors.map((c) => c.contribute(null, t));
    const day = busyDay(plan.service, T0);
    for (let i = 0; i < 30; i += 1) statusAt(day.window.startsAt + i * 20 * MS_PER_MINUTE);
    expect(store.getPlanState()).toBeNull();

    const open = kept(day)[0].startAt;
    clock.t = open;
    plan.service.ensure(open);
    const raw = store.getPlanState();
    expect(raw).not.toBeNull();
    const writes = jest.spyOn(store, 'setPlanState');
    for (let t = open; t < day.window.endsAt; t += 7 * MS_PER_MINUTE) {
      clock.t = t;
      statusAt(t);
      plan.dayClock.window(t);
    }
    expect(writes).not.toHaveBeenCalled();
    expect(store.getPlanState()).toBe(raw);
  });
});

describe('I5 — a restart mid-session', () => {
  test('a new process finds the same plan, the same open session and the ledger usage, and writes nothing', () => {
    const { store, dir } = diskStore();
    const clock = planClock(T0);
    const day = busyDay(storePlan(store, clock), T0);
    const session = kept(day)[0];
    clock.t = session.startAt + MS_PER_MINUTE;
    const before = storePlan(store, clock).ensure(clock.t);
    store.recordAction('a1', 'follow', 'ok', clock.t);
    const raw = store.getPlanState();
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const reopened = diskStore(dir).store;
    clock.t += 2 * MS_PER_MINUTE;
    const after = storePlan(reopened, clock).ensure(clock.t);
    expect(reopened.getPlanState()).toBe(raw);
    expect(after.plan.revision).toBe(before.plan.revision);
    expect(after.plan.seed).toBe(before.plan.seed);
    expect(after.open?.idx).toBe(before.open?.idx);
    expect(after.used.auto).toBe(1);
    expect(after.sessions[after.open?.idx ?? -1]?.used).toBe(1);
  });
});

describe('I8 — a six-hour close and a late first open', () => {
  test('sessions missed while closed expire with no catch-up; the plan is not re-drawn', () => {
    const { store } = diskStore();
    const clock = planClock(T0);
    const plan = storePlan(store, clock);
    const day = busyDay(plan, T0);
    const first = kept(day)[0];
    clock.t = first.startAt;
    const opened = plan.ensure(clock.t);
    store.recordAction('a1', 'follow', 'ok', clock.t);
    const raw = store.getPlanState();

    clock.t += 6 * MS_PER_HOUR;
    const back = plan.ensure(clock.t);
    expect(store.getPlanState()).toBe(raw);
    expect(back.plan.revision).toBe(opened.plan.revision);
    back.plan.sessions.forEach((s, i) => {
      const windowEnd = back.plan.sessions[i + 1]?.startAt ?? back.plan.window.endsAt;
      if (s.budget > 0 && i > 0 && windowEnd <= clock.t) expect(back.sessions[i].state).toBe('skipped');
    });
    const left = back.sessions.filter((s) => s.state === 'now' || s.state === 'next' || s.state === 'later');
    expect(back.R).toBe(left.reduce((a, s) => a + Math.max(0, s.budget - s.used), 0));
  });

  test('a first open after a session ended prorates it to nothing; planned volume keeps only the rest', () => {
    const { store } = diskStore();
    const clock = planClock(T0);
    const plan = storePlan(store, clock);
    const ideal = busyDay(plan, T0);
    const gone = kept(ideal)[0];
    clock.t = gone.expectedEndAt + MS_PER_MINUTE;
    const late = plan.ensure(clock.t);
    const prorated = late.plan.sessions.filter((s) => s.before === 'first-open');
    expect(prorated.length).toBeGreaterThan(0);
    expect(prorated.every((s) => s.budget === 0)).toBe(true);
    expect(late.plan.firstOpenAt).toBe(clock.t);
    expect(late.plan.volume.planned).toBe(late.plan.sessions.reduce((a, s) => a + s.budget, 0));
    expect(late.plan.volume.planned).toBeLessThan(ideal.plan.volume.planned);
  });
});
