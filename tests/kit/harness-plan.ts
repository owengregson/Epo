/**
 * The engine kit's plan-side fakes: the in-memory follow-back sweep cadence, the
 * composition root's plan surface, and the plan over a real store as the plan
 * wiring builds it (the plan integration tests). Re-exported by `engine-harness.ts`.
 */

import type { EnginePacing, SweepCadence } from '@/engine/engine';
import type { Clock } from '@/governors/clock';
import type { PlanService } from '@/governors/plan-service';
import type { PlanPreviewPort, PlanView } from '@/governors/plan-types';
import { viewPlan } from '@/governors/plan-view';
import { drawDayPlan } from '@/kernel/plan';
import { MS_PER_DAY } from '@/kernel/units';
import type { PlanHost } from '@/main/services/graph-types';
import { type PlanWiring, wirePlan } from '@/main/services/plan-wiring';
import { effectiveFromV1 } from '@/settings/effective';
import { DEFAULT_SETTINGS, type Settings } from '@/settings/settings';
import type { SettingsCapabilities } from '@/shared/settings-view';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { DelayManager } from '@/timing/delay-manager';
import { ScheduleManager } from '@/timing/schedule-manager';
import { drawInput, viewInputs } from './plan';
import { openTestStore } from './store';

/**
 * The in-memory follow-back cadence: starts due (a fresh Engine's first
 * eligible step performs a catch-up sweep), then honours the configured
 * interval. Production injects a PERSISTED cadence instead (PRINCIPLES §3).
 */
export const memorySweepCadence = (): SweepCadence => {
  let last = 0;
  return {
    isDue: (now, everyMs) => now - last >= everyMs,
    markRun: (now) => {
      last = now;
    },
  };
};

/** A settable clock the plan reads. */
export interface PlanClock {
  t: number;
  now(): number;
  advance(ms: number): void;
}

export const planClock = (t: number): PlanClock => {
  const c: PlanClock = { t, now: () => c.t, advance: (ms) => { c.t += ms; } };
  return c;
};

/** The composition root's plan surface over v1 settings, recording what the wiring registers. */
export interface FakePlanHost extends PlanHost {
  settingsNow: Settings;
  intent: 'running' | 'stopped' | 'paused';
  port: PlanPreviewPort | null;
  capabilities: Partial<SettingsCapabilities>;
  pushes: number;
  listeners: Set<() => void>;
  /** Apply a settings patch and tell the subscribers, the way the settings service does. */
  change(patch: Partial<Settings>): void;
}

export function fakePlanHost(settings: Settings = DEFAULT_SETTINGS): FakePlanHost {
  const host: FakePlanHost = {
    settingsNow: settings,
    intent: 'running',
    port: null,
    capabilities: {},
    pushes: 0,
    listeners: new Set(),
    runIntent: () => host.intent,
    settings: {
      effective: () => effectiveFromV1(host.settingsNow),
      onChange: (fn) => {
        host.listeners.add(fn);
        return () => host.listeners.delete(fn);
      },
      setPlanPort: (port) => {
        host.port = port;
      },
      setCapabilities: (patch) => {
        host.capabilities = { ...host.capabilities, ...patch };
      },
    },
    pushStatus: () => {
      host.pushes += 1;
    },
    change: (patch) => {
      host.settingsNow = { ...host.settingsNow, ...patch };
      for (const fn of [...host.listeners]) fn();
    },
  };
  return host;
}

/** The plan wiring over a real store, as the graph builds it (the edge timer on `scheduler`). */
export function storePlanWiring(store: KnowledgeStore, clock: Clock, host: FakePlanHost = fakePlanHost(),
  scheduler: ScheduleManager = new ScheduleManager(), delays: DelayManager = new DelayManager({ clock })): PlanWiring {
  return wirePlan(store, clock, 'ME', delays, { plan: host, settings: host.settingsNow, scheduler });
}

const kitPlans: PlanWiring[] = [];
afterEach(() => {
  while (kitPlans.length > 0) kitPlans.pop()?.dispose();
});

/** The plan wiring over `store`, disposed after the current test: a rig's real cadence and plan port. */
export function kitPlan(store: KnowledgeStore, clock: Clock, settings: Settings = DEFAULT_SETTINGS): PlanWiring {
  const plan = storePlanWiring(store, clock, fakePlanHost(settings));
  kitPlans.push(plan);
  return plan;
}

/**
 * Move `clock` to the first kept session of the next plan-day drawn whole (its first open at its start) whose
 * plan satisfies `fits`: a rig that must act, with the day's kinds sized from the store's demand.
 */
export function intoSession(plan: PlanWiring, clock: { now(): number; set(t: number): void },
  fits: (v: PlanView) => boolean = () => true): PlanView {
  for (let day = 0; day < 14; day += 1) {
    clock.set(plan.service.view(clock.now()).window.endsAt);
    const view = plan.service.ensure(clock.now());
    const first = view.plan.sessions.find((s) => s.budget > 0);
    if (first === undefined || !fits(view)) continue;
    clock.set(first.startAt);
    return plan.service.view(first.startAt);
  }
  throw new Error('no plan-day in two weeks fits the rig');
}

/** The plan service over a real store and the given v1 settings, the way the plan wiring builds it. */
export function storePlan(store: KnowledgeStore, clock: PlanClock, settings: Settings = DEFAULT_SETTINGS): PlanService {
  return storePlanWiring(store, clock, fakePlanHost(settings)).service;
}

/** The first plan-day from `from` on whose ideal plan has at least `sessions` sessions with budget. */
export function busyDay(plan: PlanService, from: number, sessions = 3): PlanView {
  for (let d = 0; d < 28; d += 1) {
    const v = plan.view(plan.view(from + d * MS_PER_DAY).window.startsAt);
    if (v.plan.sessions.filter((s) => s.budget > 0).length >= sessions) return v;
  }
  throw new Error('no busy plan-day in four weeks');
}

/** A plan view at `now` from a drawn plan, with the fields a loop test steers set. */
export function stubPlanView(now: number, o: { open: boolean; nextSessionAt: number | null; target: number;
  hourCap?: number; usedAuto?: number }): PlanView {
  const plan = drawDayPlan(drawInput(now));
  const base = viewPlan(plan, viewInputs(plan, now));
  const reads = { reconcile: 0, explore: 0, explorePages: 0, checks: 0, checkPages: 0 };
  return {
    ...base,
    plan: {
      ...plan,
      volume: { ...plan.volume, drawn: o.target, planned: o.target },
      ceilings: { ...plan.ceilings, hour: o.hourCap ?? plan.ceilings.hour },
    },
    open: o.open
      ? { idx: 0, mixLeft: { follow: 1, unfollow: 1, accept: 0 }, readsLeft: reads, mix: 'normal', probation: false, censusHost: false }
      : null,
    nextSessionAt: o.open ? null : o.nextSessionAt,
    used: { ...base.used, auto: o.usedAuto ?? 0 },
  };
}

/** The plan port a loop test steers: open or closed, the next session, the day's target, the gap it arms. */
export class FakePlan implements EnginePacing {
  open = true;
  gapMs = 4 * 60_000;
  target = 25;
  hourCap: number | undefined;
  usedAuto = 0;
  /** When each action the gap was drawn after landed. */
  gaps: number[] = [];
  ensures = 0;
  constructor(private readonly nextStart: number) {}
  view(now: number): PlanView {
    return stubPlanView(now, { open: this.open, nextSessionAt: this.nextStart, target: this.target, hourCap: this.hourCap,
      usedAuto: this.usedAuto });
  }
  ensureIfProvisional(now: number): PlanView {
    this.ensures += 1;
    return this.view(now);
  }
  wake(): void {}
  gapAfter(at: number): number {
    this.gaps.push(at);
    return this.gapMs;
  }
}

/** The install entropy every plan integration store pins, so separate stores draw the same plans. */
export const PLAN_TEST_RNG = (): number => 0.375;

/** The busy plan-day's ideal plan for a store pinned to {@link PLAN_TEST_RNG}, read from a scratch store. */
export function idealDay(from: number, sessions = 3, settings: Settings = DEFAULT_SETTINGS): PlanView {
  const scratch = openTestStore(':memory:', { rng: PLAN_TEST_RNG });
  // Built two days earlier, so every day scanned is drawn whole (none is the build's own day).
  const plan = storePlanWiring(scratch, planClock(from - MS_PER_DAY - MS_PER_DAY), fakePlanHost(settings));
  try {
    return busyDay(plan.service, from, sessions);
  } finally {
    plan.dispose();
    scratch.close();
  }
}

/** A real plan over a pinned store, its clock at the start of a busy plan-day's first kept session. */
export interface SessionPlanRig {
  readonly store: KnowledgeStore;
  readonly clock: PlanClock;
  readonly host: FakePlanHost;
  readonly plan: PlanWiring;
  /** The busy plan-day's ideal plan (the pinned store draws the same one). */
  readonly day: PlanView;
  dispose(): void;
}

export function sessionPlanRig(settings: Settings = DEFAULT_SETTINGS, from = Date.parse('2026-11-09T12:00:00')): SessionPlanRig {
  const day = idealDay(from, 3, settings);
  const store = openTestStore(':memory:', { rng: PLAN_TEST_RNG });
  store.setOwnPk('me');
  const first = day.plan.sessions.find((s) => s.budget > 0);
  if (first === undefined) throw new Error('the busy plan-day has no kept session');
  const clock = planClock(first.startAt);
  const host = fakePlanHost(settings);
  const plan = storePlanWiring(store, clock, host);
  return { store, clock, host, plan, day, dispose: () => { plan.dispose(); store.close(); } };
}
