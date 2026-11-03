/**
 * I3 and I12 (spec §20.3, §9.7, §5.13 S2): a cleanup run under the plan, over the production prune engine,
 * plan wiring, mutation policy and store, with a fake tab. I3: the plan's preflight precedes every visit, the
 * run waits exactly the deadline each dispatch armed (its spacing is the plan's gap) and visits no candidate
 * twice. I12: a deadline another writer arms and a full rolling hour, both mid-run, are served at their
 * instants; no candidate is marked visited without its visit.
 */
import { prepareAction } from '@/adapter/action-admission';
import { SURFACE } from '@/adapter/ig-surface';
import type { InstagramAdapter } from '@/adapter/instagram-adapter';
import { FollowbackWatcher } from '@/engine/followback-watcher';
import { UNCONFIGURED_PROTECTION } from '@/engine/protection-port';
import { PruneEngine } from '@/engine/prune-engine';
import type { PrunePlan } from '@/engine/prune-types';
import type { SystemClock } from '@/governors/clock';
import type { Admission, PlanView } from '@/governors/plan-types';
import type { GraphBuildDeps } from '@/main/services/graph-types';
import type { PlanWiring } from '@/main/services/plan-wiring';
import { wireMutationPolicy } from '@/main/services/unfollow-wiring';
import { AdapterBackedChurnActions } from '@/rim/churn-actions';
import type { TabProfileVisitor } from '@/rim/profile-visit';
import type { ProfileVisit } from '@/rim/profile-visit-port';
import { DEFAULT_SETTINGS, type Settings } from '@/settings/settings';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { DelayManager } from '@/timing/delay-manager';
import { MS_PER_HOUR, MS_PER_MINUTE } from '@/timing/units';
import { ok } from '@/utils/result';
import { FakeListSource, FakeSentinel, PRUNE_CFG } from '../kit/engine-harness';
import { fakePlanHost, intoSession, PLAN_TEST_RNG, type PlanClock, planClock, storePlanWiring } from '../kit/harness-plan';
import { openTestStore } from '../kit/store';

const FROM = Date.parse('2026-11-09T09:00:00');
const SETTINGS: Settings = { ...DEFAULT_SETTINGS, dryRun: false };
const CANDIDATES = Array.from({ length: 30 }, (_, i) => `c${i}`);
const MUTUALS = ['m0', 'm1', 'm2'];
const opened: { plan: PlanWiring; store: KnowledgeStore }[] = [];
afterEach(() => {
  while (opened.length > 0) {
    const o = opened.pop();
    o?.plan.dispose();
    o?.store.close();
  }
});

/** What the run did, in order: the plan's answer per candidate, each visit, press, deadline and consumed row. */
type Event =
  | { kind: 'preflight'; pk: string; at: number; admission: Admission }
  | { kind: 'visit'; pk: string; at: number }
  | { kind: 'press'; pk: string; at: number }
  | { kind: 'consumed'; pk: string; at: number }
  | { kind: 'armed'; at: number; deadline: number };

interface Rig {
  store: KnowledgeStore;
  clock: PlanClock;
  plan: PlanWiring;
  engine: PruneEngine;
  events: Event[];
  /** The open session's plan when the run starts. */
  session: PlanView;
  /** Called after every wait the run sleeps through (a test arms another writer's work here). */
  afterSleep: (() => void) | null;
}

/** The production cleanup composition over a scanned census, its clock at a kept session that holds cleanup. */
async function rig(before?: (store: KnowledgeStore, session: PlanView) => void): Promise<Rig> {
  const store = openTestStore(':memory:', { rng: PLAN_TEST_RNG });
  store.setOwnPk('me');
  const clock = planClock(FROM);
  const host = fakePlanHost(SETTINGS);
  const plan = storePlanWiring(store, clock, host);
  opened.push({ plan, store });
  for (const pk of [...CANDIDATES, ...MUTUALS]) {
    store.observe({ accountPk: pk, observedAt: FROM, source: 'followers-list', fields: { username: `u${pk}` } });
  }
  const events: Event[] = [];
  const r = { store, clock, plan, events, afterSleep: null } as unknown as Rig;
  const pkOf = (username: string): string => username.slice(1);

  let url = '';
  const visit = async (username: string): Promise<ProfileVisit> => {
    url = SURFACE.profileUrl(username);
    events.push({ kind: 'visit', pk: pkOf(username), at: clock.now() });
    return { ok: true, obs: { accountPk: pkOf(username), observedAt: clock.now(), source: 'profile', fields: { username } },
      viewer: { following: true, requested: false, followsUs: false } };
  };
  const profiles = { visit } as unknown as TabProfileVisitor;
  const followback = new FollowbackWatcher({ store, clock, ownPk: 'me', notifications: { fetchRecent: async () => ({ ok: true, events: [] }) } });
  const d = { resolveSettings: () => SETTINGS, driverSignal: () => undefined, plan: host,
    protection: { index: () => UNCONFIGURED_PROTECTION, setCapabilities: () => undefined } } as unknown as GraphBuildDeps;
  let engine: PruneEngine | null = null;
  const policy = wireMutationPolicy(d, { store, ownPk: 'me', ownUsername: 'me', clock: clock as unknown as SystemClock,
    cadence: plan.cadence, readBudget: plan.readBudget, dayClock: plan.dayClock, nextSessionAt: plan.nextSessionAt,
    cleanupRunning: () => engine?.status().state === 'running', profiles: () => profiles, followback: () => followback });
  const tab = { currentUrl: () => url, goto: async (to: string) => { url = to; } };
  const actor = {
    unfollow: async (username: string, expectedPk?: string, onDispatch?: () => void) => {
      const dispatch = await prepareAction({ tab: tab as never, prepareProfile: policy.prepareProfile,
        beforeMutation: policy.beforeMutation, abortSignal: () => undefined }, 'unfollow', username, expectedPk, onDispatch);
      await dispatch();
      events.push({ kind: 'press', pk: pkOf(username), at: clock.now() });
      return ok({ clicked: true });
    },
  };
  const adapter = { sentinel: new FakeSentinel(), actor } as unknown as InstagramAdapter;
  const churnActions = new AdapterBackedChurnActions({ adapter, store, ownPk: 'me', dryRun: false, clock });

  // The run's per-candidate admission is the production plan's, observed.
  const prunePlan: PrunePlan = { ...plan.prunePlan, preflight: (now, pk) => {
    const admission = plan.prunePlan.preflight(now, pk);
    events.push({ kind: 'preflight', pk, at: now, admission });
    return admission;
  } };
  const arm = store.setActionDelayDeadline.bind(store);
  store.setActionDelayDeadline = (at) => {
    if (at !== null) events.push({ kind: 'armed', at: clock.now(), deadline: at });
    arm(at);
  };
  const consume = store.consumePruneScanCandidate.bind(store);
  store.consumePruneScanCandidate = (pk) => {
    events.push({ kind: 'consumed', pk, at: clock.now() });
    consume(pk);
  };
  engine = new PruneEngine({ store, clock, ownPk: 'me', ownFollowing: new FakeListSource([...CANDIDATES, ...MUTUALS]),
    ownFollowers: new FakeListSource(MUTUALS), churnActions, sentinel: new FakeSentinel(), cfg: PRUNE_CFG, plan: prunePlan,
    tempo: plan.tempo, delays: new DelayManager({ clock, sleep: async (ms) => { clock.advance(ms); r.afterSleep?.(); } }) });
  r.engine = engine;

  // The census lands and re-plans the demand (the scan command's trigger); the next plan-day sizes cleanup from it.
  expect((await engine.scan()).aborted).toBe(false);
  plan.demandChanged();
  const settable = { now: () => clock.now(), set: (t: number) => { clock.t = t; } };
  r.session = intoSession(plan, settable, (v) => v.plan.kinds.unfollow - v.plan.kinds.lifecycleUnfollow >= 4);
  before?.(store, r.session);
  events.length = 0;
  return r;
}

const of = <K extends Event['kind']>(events: Event[], kind: K) => events.filter((e): e is Extract<Event, { kind: K }> => e.kind === kind);

/** Every visit follows an admitted preflight of the same candidate, with no other visit between them. */
function expectPreflightBeforeEveryVisit(events: Event[]): void {
  events.forEach((e, i) => {
    if (e.kind !== 'visit') return;
    const asked = events.slice(0, i).reverse().find((x) => x.kind === 'preflight' || x.kind === 'visit');
    expect(asked).toMatchObject({ kind: 'preflight', pk: e.pk, admission: { ok: true } });
  });
}

/** Every consumed row was visited before it was consumed, once. */
function expectNoRowConsumedUnvisited(events: Event[]): void {
  const consumed = of(events, 'consumed');
  expect(new Set(consumed.map((c) => c.pk)).size).toBe(consumed.length);
  for (const c of consumed) {
    const at = events.indexOf(c);
    expect(events.slice(0, at).some((e) => e.kind === 'visit' && e.pk === c.pk)).toBe(true);
  }
}

describe('I3: a cleanup run under the plan', () => {
  test('preflight per candidate, the shared deadline as its only spacing, no revisits', async () => {
    const r = await rig();
    await r.engine.run();
    const presses = of(r.events, 'press');
    expect(presses.length).toBeGreaterThanOrEqual(3);
    expectPreflightBeforeEveryVisit(r.events);
    const visited = of(r.events, 'visit').map((v) => v.pk);
    expect(new Set(visited).size).toBe(visited.length);
    expectNoRowConsumedUnvisited(r.events);

    // Each press arms the plan's gap at its dispatch, and the next press lands exactly on it.
    const gap = r.session.tempo.gap;
    const armed = of(r.events, 'armed');
    presses.slice(1).forEach((p, i) => {
      const owed = armed.filter((a) => a.at === presses[i].at).at(-1);
      expect(owed?.deadline).toBe(p.at);
      expect(p.at - presses[i].at).toBeGreaterThanOrEqual(gap.floorMs);
    });

    // The run spends only what the plan holds for cleanup today; its remainder stays runnable.
    const day = r.plan.service.view(r.clock.now());
    expect(presses.length).toBeLessThanOrEqual(day.plan.kinds.unfollow);
    expect(r.store.pruneScanRemainingCount()).toBe(CANDIDATES.length - of(r.events, 'consumed').length);
    expect(r.engine.status().state).toBe('done');
  });
});

describe('I12: refusals mid-run are served at their instants', () => {
  test("a deadline another writer arms mid-wait: the same candidate waits for it, then visits", async () => {
    const r = await rig();
    let armedOnce = false;
    r.afterSleep = () => {
      if (armedOnce || of(r.events, 'press').length < 2) return;
      armedOnce = true;
      r.store.setActionDelayDeadline(r.clock.now() + 7 * MS_PER_MINUTE);
    };
    await r.engine.run();
    const refused = of(r.events, 'preflight').find((p) => !p.admission.ok);
    expect(refused?.admission).toMatchObject({ ok: false, reason: 'deadline' });
    if (refused === undefined || refused.admission.ok) throw new Error('no deadline refusal');
    const { until } = refused.admission;
    const next = r.events.slice(r.events.indexOf(refused) + 1).find((e) => e.kind === 'preflight' || e.kind === 'visit');
    expect(next).toMatchObject({ kind: 'preflight', pk: refused.pk, at: until, admission: { ok: true } });
    expect(r.events.some((e) => e.kind === 'consumed' && e.pk === refused.pk && e.at < (until ?? 0))).toBe(false);
    expectPreflightBeforeEveryVisit(r.events);
    expectNoRowConsumedUnvisited(r.events);
  });

  test('a full rolling hour mid-run: the run waits for the hour to open, then the same candidate visits', async () => {
    const H = SETTINGS.hourlyVelocityCap;
    // Earlier writes just before the session (outside its window): two more presses fill the rolling hour.
    const r = await rig((store, session) => {
      const start = session.plan.sessions[session.open?.idx ?? 0].startAt;
      for (let i = 0; i < H - 2; i += 1) {
        const at = start - 30 * MS_PER_MINUTE;
        const intent = store.beginEffectIntent({ accountPk: `x${i}`, username: `x${i}`, action: 'follow', channel: 'manual', at });
        store.markEffectDispatched(intent.id, at);
        store.settleEffectIntent(intent.id, { at, result: 'ok', ledger: 'growth' });
      }
    });
    await r.engine.run();
    const refused = of(r.events, 'preflight').find((p) => !p.admission.ok && p.admission.reason === 'hourly-cap');
    if (refused === undefined || refused.admission.ok) throw new Error('no hourly-cap refusal');
    expect(of(r.events, 'press').filter((p) => p.at <= refused.at).length).toBe(2);
    const until = refused.admission.until ?? 0;
    expect(until).toBe(r.session.plan.sessions[r.session.open?.idx ?? 0].startAt - 30 * MS_PER_MINUTE + MS_PER_HOUR);
    const next = r.events.slice(r.events.indexOf(refused) + 1).find((e) => e.kind === 'preflight' || e.kind === 'visit');
    expect(next).toMatchObject({ kind: 'preflight', pk: refused.pk, at: until, admission: { ok: true } });
    expect(of(r.events, 'press').some((p) => p.pk === refused.pk && p.at >= until)).toBe(true);
    expectPreflightBeforeEveryVisit(r.events);
    expectNoRowConsumedUnvisited(r.events);
  });
});
