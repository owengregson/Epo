/**
 * I14 (spec §20.3, §8.2, §8.5, Q37): Boost reachable end to end through the Foundation-level control.
 * "Start Epo and Boost" while stopped advances run intent, writes the window (the re-plan inserts the
 * act-now session) and queues the Start; a quit and reopen starts stopped with the Boost `paused` on its
 * wall-clock end, `on` again after Start; the feed carries the Boost's started row.
 */
import { boostControlOf, boostWindowOf } from '@/main/modules/boost-wiring';
import { liveSources } from '@/main/services/live-wiring';
import type { PlanWiring } from '@/main/services/plan-wiring';
import { DEFAULT_SETTINGS } from '@/settings/settings';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { MS_PER_HOUR, MS_PER_MINUTE } from '@/timing/units';
import { CENSUS_FRESH_MS, fakePlanHost, PLAN_TEST_RNG, type PlanClock, planClock, storePlanWiring } from '../kit/harness-plan';
import { openTestStore } from '../kit/store';

type RunIntent = 'running' | 'stopped' | 'paused';
const FROM = Date.parse('2026-11-10T10:00:00');
const plans: PlanWiring[] = [];
let store: KnowledgeStore;
beforeEach(() => {
  store = openTestStore(':memory:', { rng: PLAN_TEST_RNG });
  store.setOwnPk('me');
});
afterEach(() => {
  while (plans.length > 0) plans.pop()?.dispose();
  store.close();
});

/** A launch over the shared store: the plan wiring, a stopped runtime and the Foundation-level control. */
function launch(clock: PlanClock) {
  const host = fakePlanHost({ ...DEFAULT_SETTINGS, dryRun: false });
  host.intent = 'stopped';
  const runtime = {
    desired: 'stopped' as RunIntent,
    commands: [] as RunIntent[],
    snapshot: () => ({ desired: runtime.desired, blockedReason: null }),
    command: (intent: 'running') => {
      runtime.commands.push(intent);
      runtime.desired = intent;
      host.intent = intent;
    },
  };
  const plan = storePlanWiring(store, clock, host);
  plans.push(plan);
  const starts: RunIntent[] = [];
  const control = boostControlOf({ graph: () => ({ plan, store }), runtime: () => runtime,
    startEngine: async () => { starts.push(runtime.desired); }, seed: () => 'friend', now: () => clock.now() });
  return { plan, runtime, starts, control };
}

/** The first instant of the day between two kept sessions, with the next one at least an hour away. */
function betweenSessions(plan: PlanWiring, clock: PlanClock): void {
  const day = plan.service.ensure(clock.now());
  for (const s of day.plan.sessions) {
    const t = s.expectedEndAt + 2 * s.tempo.gap.capMs;
    const v = plan.service.view(t);
    if (v.open === null && v.nextSessionAt !== null && v.nextSessionAt - t > MS_PER_HOUR && t > clock.now()) {
      clock.t = t;
      return;
    }
  }
  throw new Error('no idle stretch between sessions today');
}

test('Start Epo and Boost while stopped: intent first, the act-now session, then the queued Start', () => {
  const clock = planClock(FROM);
  const { plan, runtime, starts, control } = launch(clock);
  betweenSessions(plan, clock);
  expect(plan.service.view(clock.now()).open).toBeNull();

  const result = control.startBoost(12, { alsoStart: true });
  expect(result.kind).toBe('started');
  expect(runtime.commands).toEqual(['running']);
  expect(starts).toEqual(['running']);
  const view = plan.service.view(clock.now());
  expect(view.open).toMatchObject({ mix: 'boost' });
  expect(control.view()).toMatchObject({ state: 'on', effectiveFrom: clock.now(), endsAt: clock.now() + 12 * MS_PER_HOUR });
});

test('a quit and reopen starts stopped: the Boost is paused on its wall-clock end, on again after Start', () => {
  const clock = planClock(FROM);
  const first = launch(clock);
  betweenSessions(first.plan, clock);
  expect(first.control.startBoost(12, { alsoStart: true }).kind).toBe('started');
  const endsAt = first.control.view().endsAt;
  first.plan.dispose();

  clock.t += 3 * MS_PER_HOUR;
  const reopened = launch(clock);
  expect(reopened.control.view()).toMatchObject({ state: 'paused', endsAt });
  reopened.runtime.command('running');
  expect(reopened.control.view().state).not.toBe('paused');
  expect(reopened.control.view().endsAt).toBe(endsAt);
});

test("the feed shows the Boost's started row from the window the plan persists", () => {
  const clock = planClock(FROM);
  const { plan, control } = launch(clock);
  betweenSessions(plan, clock);
  expect(control.startBoost(4, { alsoStart: true }).kind).toBe('started');
  const startedAt = clock.now();
  clock.t += MS_PER_MINUTE;
  const live = liveSources({ store, ownPk: 'me', pruneEngine: { status: () => ({ scanReady: false, scanAt: null }) } },
    () => ({ incidents: [] }),
    { planDay: plan.dayClock, censusFreshMs: () => CENSUS_FRESH_MS, now: () => clock.now(), boost: (t) => boostWindowOf({ plan }, t) });
  expect(live.feed().items).toContainEqual(expect.objectContaining({ kind: 'boost', edge: 'started', at: startedAt }));
});
