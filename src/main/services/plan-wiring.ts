/**
 * The plan wiring (ADR 0607, spec §5.13 S1): the plan service, the single writer of the day plan,
 * over the store and the live settings; its plan-backed day clock (the one boundary every day
 * counter reads); the loop's plan port; the plan and Boost status contributors; and the settings
 * preview port; the cadence, the read budget and the plan-backed tempo the whole graph runs on.
 */

import type { EngineWaitKey } from '@/engine/engine-waits';
import { journalBlocks } from '@/engine/journal';
import type { EnginePlan } from '@/engine/plan-port';
import type { PrunePlan } from '@/engine/prune-types';
import { UnconfirmedBreaker } from '@/engine/unconfirmed-breaker';
import type { Clock } from '@/governors/clock';
import { projectBoost } from '@/governors/plan-boost';
import { projectPlan } from '@/governors/plan-projection';
import { PlanService } from '@/governors/plan-service';
import { RateGovernor, type RateGovernorConfig, type RatePlan } from '@/governors/rate-governor';
import { ReadBudget, type ReadBudgetConfig } from '@/governors/read-budget';
import type { PlanDayClock } from '@/kernel/plan';
import type { TempoSource } from '@/kernel/tempo';
import { PlanControl } from '@/main/modules/plan-control';
import type { EffectiveSettings } from '@/settings/effective';
import { toPlanIntent } from '@/settings/plan-intent';
import { toReadAllowance } from '@/settings/read-allowance';
import type { KnowledgeStore } from '@/store/knowledge-store';
import type { DelayManager } from '@/timing/delay-manager';
import * as logger from '@/utils/logger';
import type { GraphBuildDeps, GraphPlan, StatusContributor, WiringParts } from './graph-types';
import { createMutationCadence, type MutationCadence } from './mutation-cadence';
import { lastMutationBefore, planDemand } from './plan-demand';
import { surfaceGateOf } from './surface-wiring';

/**
 * The durable read budget's limits on every read (spec §5.8 layer 1): the plan-day totals from the live
 * settings and the plan's own census sizing, the plan-day window they reset at (the trailing-24 h
 * backstop binds as well), and the plan's explore sub-limit for the day.
 */
export function planReadLimits(service: Pick<PlanService, 'view'>, effective: () => EffectiveSettings, now: number): ReadBudgetConfig {
  const view = service.view(now);
  return { ...toReadAllowance(effective(), view.plan.demand), window: view.window,
    explore: { profiles: view.plan.reads.explore, pages: view.plan.reads.explorePages } };
}

/** What the plan wiring hands the graph: the graph's plan, the loop's plan port and the rate governor over it. */
export interface PlanWiring extends GraphPlan {
  /** The loop's plan: the one pacing model (spec §5.13 S2). */
  readonly pacing: EnginePlan;
  /** The unconfirmed-actions breaker every automatic writer feeds (spec §11.1 F7). */
  readonly breaker: UnconfirmedBreaker;
  /** The rate governor counting against the plan's day and volume. */
  rateGovernor(cfg: RateGovernorConfig): RateGovernor;
  /** The plan's cadence: the admission before every visit and the deadline armed at dispatch. */
  readonly cadence: MutationCadence;
  /** The plan's next session start (a park slot), or null when none remains before the boundary. */
  nextSessionAt(now: number): number | null;
  /** The open session's start and planned unfollows, or null between sessions (spec §9.7). */
  reviewBound(now: number): { readonly since: number; readonly planned: number } | null;
  /** The plan's face toward cleanup: the run's admission, its gap, the breaker, the day's cleanup. */
  readonly prunePlan: PrunePlan;
  /** The durable read budget on the plan's plan-day limits. */
  readonly readBudget: ReadBudget;
  /** The plan-backed tempo (spec §5.9, §5.11): every Instagram-facing wait, dwell and gesture follows the session. */
  readonly tempo: TempoSource;
}

/** The loop's waits a re-plan can move: the plan's own parks. */
const PLAN_PARKS: readonly EngineWaitKey[] = ['engine:session-park', 'engine:daily-ceiling-park'];

/** The plan service over the store and the live settings, the one plan-day boundary it backs, and its triggers. */
export function wirePlan(store: KnowledgeStore, clock: Clock, ownPk: string, delays: DelayManager,
  d: Pick<GraphBuildDeps, 'plan' | 'settings' | 'scheduler'>): PlanWiring {
  const host = d.plan;
  const effective = () => host.settings.effective();
  const installEntropy = store.installEntropy();
  let control: PlanControl | null = null;
  const breaker = new UnconfirmedBreaker();
  const gate = surfaceGateOf(store);
  const service = new PlanService({
    store,
    clock,
    installEntropy,
    launchSeed: (installEntropy ^ (clock.now() >>> 0)) >>> 0,
    intent: () => toPlanIntent(effective()),
    demand: (window, now) => planDemand(store, effective(), ownPk, window, now),
    lastMutationBefore: (t) => lastMutationBefore(store, t),
    // Outside following actions from the own-header log (spec §9.10): charged to the ceiling, increases only.
    outsideSince: (since) => store.growth.outsideSince(since),
    // The shared deadline the cadence arms at dispatch: an automatic write waits it out (spec §5.13 S2).
    deadline: () => store.getActionDelayDeadline(),
    journal: { blocks: (pk, exceptIntentId) => journalBlocks(pk, store.effectIntents.unsettledFor(pk), exceptIntentId) },
    runIntent: () => host.runIntent(),
    unconfirmed: () => breaker.held(clock.now()),
    // The real gate of this store's graph, read at each ask (the plan mix and the admission).
    surfaceGate: gate,
    onChanged: () => control?.changed(),
  }, { log: logger });
  const wake = (): void => {
    for (const key of PLAN_PARKS) delays.cancel(key);
  };
  control = new PlanControl({
    plan: service, scheduler: d.scheduler, settings: host.settings, clock, pushStatus: () => host.pushStatus(), wake,
  });
  const triggers = control;
  host.settings.setPlanPort(service);
  // The plan's tempo is in force: every key's site is enabled (the look-before-act dwell, the step pauses).
  host.settings.setCapabilities({ plan: true, tempo: true });
  triggers.start();
  // The legacy planner's phase is migrated by the plan's first write; its snapshot is retired.
  if (store.getPlanState() !== null && store.getPacingState() !== null) store.setPacingState(null);
  const cadence = createMutationCadence({ plan: service, store });
  const enginePlan: EnginePlan = {
    view: (now) => service.view(now),
    ensureIfProvisional: (now) => {
      const view = service.view(now);
      return view.provisional ? service.ensure(now) : view;
    },
    wake,
    velocityParkUntil: (now) => cadence.velocityParkUntil(now),
    practiced: (at) => {
      cadence.armPractice(at);
    },
    // A trip holds the kind for the rest of this session: until the next one starts, or the boundary.
    noteOutcome: (kind, unverified, at) => {
      const view = service.view(at);
      return breaker.note(kind, unverified, at, view.nextSessionAt ?? view.window.endsAt);
    },
    paused: (activity) => gate.paused(activity),
  };
  const dayClock = service.planDayClock();
  const ratePlan: RatePlan = { day: dayClock };
  const prunePlan: PrunePlan = {
    preflight: (now, pk) => cadence.preflight('unfollow', 'cleanup-run', now, { pk }),
    practiced: (now) => {
      cadence.armPractice(now);
    },
    noteOutcome: (unverified, now) => enginePlan.noteOutcome('unfollow', unverified, now),
    cleanupToday: (now) => {
      const view = service.view(now);
      return { done: view.used.unfollow, limit: view.plan.kinds.unfollow };
    },
    censusFreshMs: () => service.snapshot(clock.now()).intent.patienceWaitMs,
    dayWindow: (now) => dayClock.window(now),
  };
  return {
    service,
    dayClock,
    cadence,
    breaker,
    prunePlan,
    readBudget: new ReadBudget({ store, clock, limits: () => planReadLimits(service, effective, clock.now()) }),
    tempo: service.tempo(),
    nextSessionAt: (now) => service.view(now).nextSessionAt,
    reviewBound: (now) => {
      const open = service.view(now).open;
      const s = open === null ? undefined : service.view(now).plan.sessions[open.idx];
      return s === undefined ? null : { since: s.startAt, planned: s.mix.unfollow };
    },
    pacing: enginePlan,
    rateGovernor: (cfg) => new RateGovernor(store, clock, cfg, ratePlan),
    resumed: () => triggers.resumed(),
    demandChanged: () => triggers.demandChanged(),
    boostActive: () => service.view(clock.now()).boost !== null,
    dispose: () => {
      triggers.dispose();
      host.settings.setPlanPort(null);
      host.settings.setCapabilities({ plan: false, tempo: false });
    },
  };
}

/** The open graph's plan-day, for a service that outlives graphs and reads the boundary only while one is open. */
export function openGraphPlanDay(graph: () => { readonly plan: Pick<GraphPlan, 'dayClock'> } | null): Pick<PlanDayClock, 'window'> {
  return {
    window: (t) => {
      const open = graph();
      if (open === null) throw new Error('plan-day: read while no graph is open');
      return open.plan.dayClock.window(t);
    },
  };
}

/** `EpoStatus.plan`: the pure view projected, with the reads spent since the plan-day began. */
function planContributor(plan: GraphPlan, reads: ReadBudget): StatusContributor {
  return {
    name: 'plan',
    contribute: (_graph, now) => {
      const view = plan.service.view(now);
      return { plan: projectPlan(view, reads.doneSince(view.window.startsAt)) };
    },
  };
}

/** `EpoStatus.boost`: the Boost window as the plan holds it (the commands live in boost-control). */
function boostContributor(plan: GraphPlan, store: KnowledgeStore, d: Pick<GraphBuildDeps, 'plan'>): StatusContributor {
  return {
    name: 'boost',
    contribute: (_graph, now) => {
      const record = plan.service.snapshot(now).state.boost;
      const followsDuring = record === null ? null : store.tallySince(record.startedAt).follow;
      return { boost: projectBoost(plan.service.view(now), now, d.plan.runIntent(), { record, followsDuring }) };
    },
  };
}

/** `EpoStatus.actionsUnconfirmed`: the kind the breaker holds back and its streak, or null (spec §11.1 F7). */
function unconfirmedContributor(breaker: UnconfirmedBreaker): StatusContributor {
  return { name: 'actionsUnconfirmed', contribute: (_graph, now) => ({ actionsUnconfirmed: breaker.held(now) }) };
}

/** The plan wiring's startup steps and status contributors. */
export function planWiringParts(plan: GraphPlan & { readonly breaker?: UnconfirmedBreaker }, reads: ReadBudget,
  store: KnowledgeStore, d: Pick<GraphBuildDeps, 'plan'>): WiringParts {
  const contributors = [planContributor(plan, reads), boostContributor(plan, store, d)];
  if (plan.breaker !== undefined) contributors.push(unconfirmedContributor(plan.breaker));
  return { startupSteps: [], statusContributors: contributors };
}
