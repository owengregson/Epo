/**
 * The engine kit's plan-side fakes: the in-memory follow-back sweep cadence, the
 * composition root's plan surface, and the plan over a real store as the plan
 * wiring builds it (the plan integration tests). Re-exported by `engine-harness.ts`.
 */

import type { SweepCadence } from '@/engine/engine';
import type { PlanService } from '@/governors/plan-service';
import type { PlanPreviewPort, PlanView } from '@/governors/plan-types';
import { MS_PER_DAY } from '@/kernel/units';
import type { PlanHost } from '@/main/services/graph-types';
import { type PlanWiring, wirePlan } from '@/main/services/plan-wiring';
import { effectiveFromV1 } from '@/settings/effective';
import { DEFAULT_SETTINGS, type Settings } from '@/settings/settings';
import type { SettingsCapabilities } from '@/shared/settings-view';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { DelayManager } from '@/timing/delay-manager';
import { ScheduleManager } from '@/timing/schedule-manager';
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
}

export const planClock = (t: number): PlanClock => {
  const c = { t, now: () => c.t };
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
export function storePlanWiring(store: KnowledgeStore, clock: PlanClock, host: FakePlanHost = fakePlanHost(),
  scheduler: ScheduleManager = new ScheduleManager(), delays: DelayManager = new DelayManager({ clock })): PlanWiring {
  return wirePlan(store, clock, 'ME', delays, { plan: host, settings: host.settingsNow, scheduler });
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

/** The install entropy every plan integration store pins, so separate stores draw the same plans. */
export const PLAN_TEST_RNG = (): number => 0.375;

/** The busy plan-day's ideal plan for a store pinned to {@link PLAN_TEST_RNG}, read from a scratch store. */
export function idealDay(from: number, sessions = 3): PlanView {
  const scratch = openTestStore(':memory:', { rng: PLAN_TEST_RNG });
  // Built two days earlier, so every day scanned is drawn whole (none is the build's own day).
  const plan = storePlanWiring(scratch, planClock(from - MS_PER_DAY - MS_PER_DAY));
  try {
    return busyDay(plan.service, from, sessions);
  } finally {
    plan.dispose();
    scratch.close();
  }
}
