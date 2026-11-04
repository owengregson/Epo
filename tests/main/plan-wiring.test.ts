/**
 * The plan wiring (spec §5.13 S1): the plan service registers its preview port and the `plan`
 * capability and withdraws both when the graph closes; the day clock is the plan's own boundary;
 * the `plan` and `boost` contributors project the pure view; the demand and the last write before
 * an instant come from the store.
 */
import { FakeClock } from '@/governors/clock';
import { ReadBudget } from '@/governors/read-budget';
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE } from '@/kernel/units';
import { lastMutationBefore, planDemand } from '@/main/services/plan-demand';
import { type PlanWiring, planWiringParts } from '@/main/services/plan-wiring';
import { effectiveFromV1 } from '@/settings/effective';
import { toReadAllowance } from '@/settings/read-allowance';
import { DEFAULT_SETTINGS } from '@/settings/settings';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { busyDay, fakePlanHost, planClock, storePlanWiring } from '../kit/harness-plan';
import { openTestStore } from '../kit/store';

const T0 = new Date(2026, 10, 9, 12).getTime();
const stores: KnowledgeStore[] = [];
const wirings: PlanWiring[] = [];
const store = (): KnowledgeStore => {
  const s = openTestStore(':memory:', { rng: () => 0.375 });
  stores.push(s);
  return s;
};
const wire = (...args: Parameters<typeof storePlanWiring>): PlanWiring => {
  const plan = storePlanWiring(...args);
  wirings.push(plan);
  return plan;
};
afterEach(() => {
  while (wirings.length > 0) wirings.pop()?.dispose();
  while (stores.length > 0) stores.pop()?.close();
});

const reads = (s: KnowledgeStore, clock: { now(): number }) =>
  new ReadBudget({ store: s, clock, limits: () => toReadAllowance(effectiveFromV1(DEFAULT_SETTINGS)) });

describe('registration', () => {
  test('the build writes the plan once; the preview port and the plan capability come and go with the graph', () => {
    const host = fakePlanHost();
    const s = store();
    const plan = wire(s, planClock(T0), host);
    expect(s.getPlanState()).not.toBeNull();
    expect(plan.service.view(T0).provisional).toBe(false);
    expect(host.port).toBe(plan.service);
    expect(host.capabilities.plan).toBe(true);
    plan.dispose();
    expect(host.port).toBeNull();
    expect(host.capabilities.plan).toBe(false);
  });

  test('the day clock is the plan service own boundary, not local midnight', () => {
    const plan = wire(store(), planClock(T0));
    const view = plan.service.view(T0);
    expect(plan.dayClock.window(T0)).toEqual(view.window);
    expect(plan.dayClock.dayKey(T0)).toBe(view.window.key);
    expect(new Date(view.window.startsAt).getHours() + new Date(view.window.startsAt).getMinutes()).toBeGreaterThan(0);
  });
});

describe('the contributors', () => {
  test('plan projects the pure view with the reads spent since the plan-day began', () => {
    const s = store();
    const clock = planClock(T0);
    const host = fakePlanHost();
    const plan = wire(s, clock, host);
    const budget = reads(s, clock);
    const day = busyDay(plan.service, T0);
    clock.t = day.window.startsAt + MS_PER_HOUR;
    budget.consume('profile', 'exploration', 2);
    budget.consume('notification', 'reconciliation', 1);
    const raw = s.getPlanState();
    const [planC] = planWiringParts(plan, budget, s, { plan: host }).statusContributors;
    const fields = planC.contribute(null, clock.t);
    expect(fields.plan?.day.key).toBe(day.window.key);
    expect(fields.plan?.reads.profiles.done).toBe(2);
    expect(fields.plan?.reads.checks.done).toBe(1);
    expect(fields.plan?.totals.automaticMax).toBe(day.plan.ceilings.automaticMax);
    expect(s.getPlanState()).toBe(raw);
  });

  test('boost is off with no window, and paused while the window is open and Epo is stopped', () => {
    const s = store();
    const clock = planClock(T0);
    const host = fakePlanHost();
    const plan = wire(s, clock, host);
    const [, boostC] = planWiringParts(plan, reads(s, clock), s, { plan: host }).statusContributors;
    expect(boostC.contribute(null, T0).boost?.state).toBe('off');
    plan.service.startBoost(2 * MS_PER_HOUR, T0);
    host.intent = 'stopped';
    expect(boostC.contribute(null, T0 + MS_PER_MINUTE).boost?.state).toBe('paused');
  });
});

describe('the journal port (spec §9.8)', () => {
  test("only an account's own open write refuses its next one; the caller's own intent and other accounts pass", () => {
    const s = store();
    const plan = wire(s, planClock(T0));
    const admits = (subject: { pk: string; intentId?: string }) => plan.service.view(T0).admits('unfollow', 'manual', subject);
    const open = s.beginEffectIntent({ accountPk: 'x', username: 'xavier', action: 'unfollow', channel: 'manual', at: T0 });
    expect(admits({ pk: 'x' })).toEqual({ ok: true });
    s.markEffectDispatched(open.id, T0);
    expect(admits({ pk: 'x' })).toEqual({ ok: false, reason: 'journal', until: null });
    expect([admits({ pk: 'x', intentId: open.id }), admits({ pk: 'y' })]).toEqual([{ ok: true }, { ok: true }]);
    s.markEffectUncertain(open.id, T0);
    expect(admits({ pk: 'x' })).toEqual({ ok: false, reason: 'journal', until: null });
  });
});

describe('the store reads', () => {
  test('the demand counts due lifecycle work, today follows, the stock and recent accepts', () => {
    const s = store();
    const clock = new FakeClock(T0);
    const plan = wire(s, planClock(T0));
    const window = plan.service.view(T0).window;
    const settings = effectiveFromV1(DEFAULT_SETTINGS);
    const wait = settings.maxWaitForFollowbackDays * MS_PER_DAY;
    s.upsertFollowRecord({ accountPk: 'q', targetPk: null, state: 'unfollow_queued', retryCount: 0 });
    s.upsertFollowRecord({ accountPk: 'p1', targetPk: null, state: 'pending_followback', retryCount: 0, followedAt: window.endsAt - wait - 1 });
    s.upsertFollowRecord({ accountPk: 'p2', targetPk: null, state: 'pending_followback', retryCount: 0, followedAt: window.endsAt });
    // A wait that ends on the boundary is due on the next plan-day: the window is [startsAt, endsAt).
    s.upsertFollowRecord({ accountPk: 'p3', targetPk: null, state: 'pending_followback', retryCount: 0, followedAt: window.endsAt - wait });
    s.recordAction('f', 'follow', 'ok', window.startsAt + 1);
    const d = planDemand(s, settings, 'ME', window, clock.now());
    expect(d.lifecycleDueByDayEnd).toBe(2);
    expect(d.lifecycleBacklog).toBeGreaterThanOrEqual(1);
    expect(d.followsDoneToday).toBe(1);
    expect(d.acceptsRecent).toBe(0);
    expect(d.census.lastCompleteAt).toBeNull();
  });

  test('the outside actions, the open requests and the kept re-checks due today come from the store', () => {
    const s = store();
    s.setOwnPk('ME');
    const plan = wire(s, planClock(T0));
    const window = plan.service.view(T0).window;
    const header = (at: number, following: number) =>
      s.observe({ accountPk: 'ME', observedAt: at, source: 'profile', fields: { followers: 100, following } });
    header(window.startsAt + 1, 200);
    header(window.startsAt + 2, 203);
    header(window.startsAt + 3, 199); // the owner's own unfollows are never charged
    s.observeEdge('r1', 'ME', 'requests', true, T0);
    s.observeEdge('r2', 'ME', 'requests', true, T0);
    s.observeEdge('ME', 'r3', 'requests', true, T0);
    const kept = (pk: string, recheckAt: number) => s.upsertFollowRecord({ accountPk: pk, targetPk: null, state: 'kept',
      retryCount: 0, keptReason: 'unreadable-bio', recheckAt });
    kept('k1', window.endsAt - MS_PER_MINUTE);
    kept('k2', window.endsAt + MS_PER_HOUR);
    kept('k3', window.endsAt);
    const d = planDemand(s, effectiveFromV1(DEFAULT_SETTINGS), 'ME', window, T0);
    expect([d.outsideToday, d.pendingRequests, d.protectedReeval]).toEqual([3, 2, 1]);
    expect(plan.service.view(T0).used.outside).toBe(3);
  });

  test("the journal's due intents and the followers head's page size come from the store", () => {
    const s = store();
    s.setOwnPk('ME');
    const plan = wire(s, planClock(T0));
    const window = plan.service.view(T0).window;
    const begin = (pk: string) => s.beginEffectIntent({ accountPk: pk, username: pk, action: 'unfollow', channel: 'manual', at: T0 });
    const dispatched = (pk: string): string => {
      const { id } = begin(pk);
      s.markEffectDispatched(id, T0);
      return id;
    };
    begin('prepared'); // nothing was pressed: no settlement read is owed
    dispatched('due');
    s.effectIntents.park(dispatched('later-today'), { attempts: 1, nextAttemptAt: window.endsAt - MS_PER_HOUR }, null);
    s.effectIntents.park(dispatched('next-day'), { attempts: 1, nextAttemptAt: window.endsAt }, null);
    s.settleEffectIntent(dispatched('settled'), { at: T0, result: 'ok', ledger: 'none' });
    const demand = () => planDemand(s, effectiveFromV1(DEFAULT_SETTINGS), 'ME', window, T0);
    expect([demand().journalPending, demand().census.rowsPerPage]).toEqual([2, null]);
    s.reopen.set({ v: 1, feed: null, requests: null, lastSweep: null, lastCatchUp: null, following: null,
      head: { walkedAt: T0, rowsPerPage: 12, order: { verdict: 'newest-first', pairs: 3, ordered: 3, at: T0 }, contiguous: true } });
    expect(demand().census.rowsPerPage).toBe(12);
  });

  test('the last write before an instant is exact, looks back past a day, and is null with no ledger', () => {
    const s = store();
    expect(lastMutationBefore(s, T0)).toBeNull();
    s.recordAction('a', 'follow', 'ok', T0 - 5 * MS_PER_DAY);
    s.recordAction('b', 'follow', 'ok', T0 + MS_PER_MINUTE);
    expect(lastMutationBefore(s, T0)).toBe(T0 - 5 * MS_PER_DAY);
    s.recordAction('c', 'unfollow', 'ok', T0 - MS_PER_HOUR);
    expect(lastMutationBefore(s, T0)).toBe(T0 - MS_PER_HOUR);
    expect(lastMutationBefore(s, T0 - 6 * MS_PER_DAY)).toBeNull();
  });
});

describe('the plan-backed tempo (spec §5.13 S2 item 9, §5.11)', () => {
  test('the graph runs on the plan tempo: every site enabled, the open session in force, capabilities.tempo set', () => {
    const host = fakePlanHost();
    const s = store();
    const clock = planClock(T0);
    const plan = wire(s, clock, host);
    expect(host.capabilities).toMatchObject({ plan: true, tempo: true, boost: true });
    for (const key of ['dwell.before-press', 'ui.step-pause', 'walk.rest-every'] as const) expect(plan.tempo.enabled(key)).toBe(true);
    const day = busyDay(plan.service, T0);
    const session = day.plan.sessions.find((x) => x.budget > 0);
    if (session === undefined) throw new Error('no kept session');
    clock.t = session.startAt;
    expect(plan.tempo.current()).toEqual(plan.service.view(clock.t).tempo);
    plan.dispose();
    expect(host.capabilities).toMatchObject({ plan: false, tempo: false, boost: false });
  });
});

describe('the activity clock (spec §5.13 S2b, §5.16)', () => {
  test('each graph holds one clock of its own; an end noted on it spaces the next entry', () => {
    const plan = wire(store(), planClock(T0));
    const other = wire(store(), planClock(T0));
    expect(plan.activity).not.toBe(other.activity);
    expect(plan.activity.lastEndAt()).toBeNull();
    plan.activity.noteEnd(T0);
    expect(plan.activity.lastEndAt()).toBe(T0);
    expect(other.activity.lastEndAt()).toBeNull();
  });
});
