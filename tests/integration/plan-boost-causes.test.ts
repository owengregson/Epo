/**
 * I9 (spec §20.3, §8.3; law L13 over the production plan wiring and a real store): a Boost across a restart,
 * a clock jump, a settings change, the plan-day edge inside a 20 h Boost and a plan_state repair. After every
 * cause the window is the one the user started and the overlay holds: every session inside it runs the Boost
 * mix with no unfollows, an unfollow waits for the window, and what the day can run stays within automaticDayMax(P0).
 */
import { automaticDayMax } from '@/kernel/plan/volume';
import type { PlanWiring } from '@/main/services/plan-wiring';
import { DEFAULT_SETTINGS, type Settings } from '@/settings/settings';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE } from '@/timing/units';
import { type FakePlanHost, fakePlanHost, PLAN_TEST_RNG, type PlanClock, planClock, storePlanWiring } from '../kit/harness-plan';
import { openTestStore } from '../kit/store';

const FROM = Date.parse('2026-11-10T10:00:00');
// Isolate Boost admission at every plan-day edge; quiet-hours precedence has its own coverage.
const SETTINGS: Settings = { ...DEFAULT_SETTINGS, dryRun: false, activeHoursStart: 0, activeHoursEnd: 0 };
const plans: PlanWiring[] = [];
let store: KnowledgeStore;
let clock: PlanClock;
beforeEach(() => {
  store = openTestStore(':memory:', { rng: PLAN_TEST_RNG });
  store.setOwnPk('me');
  clock = planClock(FROM);
  // Follows old enough to be due, so the plan holds unfollows for the Boost to hold back (spec §8.3).
  for (let i = 0; i < 6; i += 1) {
    const pk = `old${i}`;
    store.observe({ accountPk: pk, observedAt: FROM - 9 * MS_PER_DAY, source: 'profile', fields: { username: pk, followers: 200, following: 200 } });
    store.upsertFollowRecord({ accountPk: pk, targetPk: 'hub', state: 'pending_followback', followedAt: FROM - 9 * MS_PER_DAY + i, retryCount: 0 });
  }
});
afterEach(() => {
  while (plans.length > 0) plans.pop()?.dispose();
  store.close();
});

/** A launch over the shared store: the plan wiring as the graph builds it, Epo meant to run. */
function launch(host: FakePlanHost = fakePlanHost(SETTINGS)): { plan: PlanWiring; host: FakePlanHost } {
  const plan = storePlanWiring(store, clock, host);
  plans.push(plan);
  return { plan, host };
}

/** Start a Boost of `hours` at the clock: the window the plan persisted. */
function boost(plan: PlanWiring, hours: number): { startedAt: number; endsAt: number } {
  plan.service.startBoost(hours * MS_PER_HOUR, clock.now());
  const record = plan.service.snapshot(clock.now()).state.boost;
  if (record === null) throw new Error('the Boost was not persisted');
  return { startedAt: record.startedAt, endsAt: record.endsAt };
}

/** L13 at the clock: the started window, the overlay on every session inside it, an unfollow held, the day bounded. */
function expectOverlay(plan: PlanWiring, window: { startedAt: number; endsAt: number }): number {
  const now = clock.now();
  const view = plan.service.view(now);
  expect(view.boost).toMatchObject({ startedAt: window.startedAt, endsAt: window.endsAt, endedAt: null });
  const t0 = Math.max(window.startedAt, view.window.startsAt);
  const t1 = Math.min(window.endsAt, view.window.endsAt);
  const inside = view.plan.sessions.filter((s) => s.before === 'none' && s.budget > 0 && s.startAt >= t0 && s.startAt < t1);
  for (const s of inside) expect({ at: s.startAt, mix: s.tempo.mix, unfollows: s.mix.unfollow }).toEqual({ at: s.startAt, mix: 'boost', unfollows: 0 });
  if (view.open !== null) expect(view.open.mix).toBe('boost');
  // What the day can still run: the automatic writes so far and the kept remainder (an ended session holds none).
  expect(view.used.auto + view.R).toBeLessThanOrEqual(automaticDayMax(SETTINGS.dailyOperatingRate));
  expect(plan.cadence.preflight('unfollow', 'growth', now, { pk: 'u' })).toMatchObject({ ok: false, reason: 'deferred-by-boost' });
  return inside.length;
}

test('a restart: the reopened plan keeps the window and its overlay', () => {
  const first = launch();
  const window = boost(first.plan, 12);
  expect(expectOverlay(first.plan, window)).toBeGreaterThan(0);
  first.plan.dispose();
  clock.t += 3 * MS_PER_HOUR;
  const { plan } = launch();
  expect(expectOverlay(plan, window)).toBeGreaterThan(0);
});

test('a clock jump back inside the window re-plans on the clock and keeps the overlay', () => {
  const { plan } = launch();
  const window = boost(plan, 12);
  clock.t += 3 * MS_PER_HOUR;
  // A completed census writes the plan at the later instant (the demand cause).
  plan.demandChanged();
  expect(plan.service.snapshot(clock.now()).state.plan?.drawnAt).toBe(clock.now());
  clock.t -= 2 * MS_PER_HOUR;
  const replanned = plan.service.ensure(clock.now());
  expect(replanned.plan.cause).toBe('clock');
  expect(expectOverlay(plan, window)).toBeGreaterThan(0);
});

test('a settings change during the Boost re-plans the remainder and keeps the overlay', () => {
  const { plan, host } = launch();
  const window = boost(plan, 12);
  clock.t += MS_PER_HOUR;
  const before = plan.service.snapshot(clock.now()).state.plan?.revision ?? 0;
  host.change({ hourlyVelocityCap: SETTINGS.hourlyVelocityCap - 2 });
  const after = plan.service.snapshot(clock.now()).state.plan;
  expect(after?.cause).toBe('settings');
  expect(after?.revision ?? 0).toBeGreaterThan(before);
  expect(after?.ceilings.hour).toBe(SETTINGS.hourlyVelocityCap - 2);
  expect(expectOverlay(plan, window)).toBeGreaterThan(0);
});

test('the plan-day edge inside a 20 h Boost: the next plan-day carries the overlay until the window ends', () => {
  // An evening Boost: its 20 h reach well into the next plan-day's sessions.
  clock.t = Date.parse('2026-11-10T20:00:00');
  const { plan } = launch();
  const window = boost(plan, 20);
  const edge = plan.service.view(clock.now()).window.endsAt;
  expect(edge).toBeLessThan(window.endsAt);
  clock.t = edge;
  const next = plan.service.ensure(clock.now());
  expect(next.plan.cause).toBe('day-start');
  expect(next.window.startsAt).toBe(edge);
  expect(expectOverlay(plan, window)).toBeGreaterThan(0);
  // After the window the plan-day is the plain one: its sessions run the normal mix.
  const later = next.plan.sessions.filter((s) => s.budget > 0 && s.startAt >= window.endsAt);
  expect(later.length).toBeGreaterThan(0);
  for (const s of later) expect(s.tempo.mix).toBe('normal');
});

test('a plan_state repair keeps the valid Boost window and re-applies the overlay', () => {
  const { plan } = launch();
  const window = boost(plan, 12);
  const raw = store.getPlanState();
  if (raw === null) throw new Error('no plan_state');
  store.setPlanState(JSON.stringify({ ...JSON.parse(raw), plan: { v: 1, window: 'unreadable' } }));
  clock.t += 30 * MS_PER_MINUTE;
  const repaired = plan.service.ensure(clock.now());
  expect(repaired.plan.cause).toBe('repair');
  expect(expectOverlay(plan, window)).toBeGreaterThan(0);
});
