/**
 * The plan wiring (ADR 0607, spec §5.13 S1): the plan service, the single writer of the day plan,
 * over the store and the live settings; its plan-backed day clock (the one boundary every day
 * counter reads); the loop's plan port; the plan and Boost status contributors; and the settings
 * preview port. The pace is unchanged: the reference tempo and the reference gap stay in force.
 */

import type { EngineWaitKey } from '@/engine/engine-waits';
import { journalBlocks } from '@/engine/journal';
import { referenceGapMs } from '@/engine/pacers';
import type { EnginePlanPacing } from '@/engine/plan-port';
import type { Clock, SystemClock } from '@/governors/clock';
import { projectBoost } from '@/governors/plan-boost';
import { projectPlan } from '@/governors/plan-projection';
import { PlanService } from '@/governors/plan-service';
import { RateGovernor, type RateGovernorConfig, type RatePlan } from '@/governors/rate-governor';
import { ReadBudget } from '@/governors/read-budget';
import type { PlanDayClock } from '@/kernel/plan';
import { MS_PER_HOUR } from '@/kernel/units';
import { PlanControl } from '@/main/modules/plan-control';
import { toPlanIntent } from '@/settings/plan-intent';
import { toReadAllowance } from '@/settings/read-allowance';
import { NEVER_PAUSED } from '@/shared/surface-gate';
import type { KnowledgeStore } from '@/store/knowledge-store';
import type { DelayManager } from '@/timing/delay-manager';
import { launchStream } from '@/utils/entropy';
import * as logger from '@/utils/logger';
import type { GraphBuildDeps, GraphPlan, StatusContributor, WiringParts } from './graph-types';
import { lastMutationBefore, planDemand } from './plan-demand';

/** The durable read budget; its limits re-derive from the live settings on every read. */
export function wireReadBudget(
  store: KnowledgeStore,
  clock: SystemClock,
  d: Pick<GraphBuildDeps, 'resolveSettings'>,
): ReadBudget {
  return new ReadBudget({ store, clock, limits: () => toReadAllowance(d.resolveSettings()) });
}

/** What the plan wiring hands the graph: the graph's plan, the loop's plan port and the rate governor over it. */
export interface PlanWiring extends GraphPlan {
  /** The loop's plan, for the session-paced model only (the legacy metronome keeps none). */
  readonly pacing: EnginePlanPacing | undefined;
  /** The rate governor counting against the plan's day and volume. */
  rateGovernor(cfg: RateGovernorConfig): RateGovernor;
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
    // The engine still arms the shared delay itself; the plan's deadline arrives with the cadence switch.
    deadline: () => null,
    journal: { blocks: (pk, exceptIntentId) => journalBlocks(pk, store.effectIntents.unsettledFor(pk), exceptIntentId) },
    runIntent: () => host.runIntent(),
    unconfirmed: () => null,
    surfaceGate: NEVER_PAUSED,
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
  host.settings.setCapabilities({ plan: true });
  triggers.start();
  // The legacy planner's phase is migrated by the plan's first write; its snapshot is retired.
  if (store.getPlanState() !== null && store.getPacingState() !== null) store.setPacingState(null);
  const gapRng = launchStream('main/plan-gap');
  const enginePlan: EnginePlanPacing = {
    view: (now) => service.view(now),
    ensureIfProvisional: (now) => {
      const view = service.view(now);
      return view.provisional ? service.ensure(now) : view;
    },
    wake,
    gapAfter: (at) => referenceGapMs(toPlanIntent(effective()), store.recentMutationTimes(at - MS_PER_HOUR), at, gapRng),
  };
  const dayClock = service.planDayClock();
  const ratePlan: RatePlan = {
    day: dayClock,
    volume: (now) => {
      const view = service.view(now);
      return { planned: Math.max(view.plan.volume.drawn, view.plan.volume.planned), remaining: view.remaining };
    },
  };
  return {
    service,
    dayClock,
    pacing: d.settings.pacingModel === 'organic' ? enginePlan : undefined,
    rateGovernor: (cfg) => new RateGovernor(store, clock, cfg, launchStream('governors/rate-governor'), ratePlan),
    resumed: () => triggers.resumed(),
    demandChanged: () => triggers.demandChanged(),
    boostActive: () => service.view(clock.now()).boost !== null,
    dispose: () => {
      triggers.dispose();
      host.settings.setPlanPort(null);
      host.settings.setCapabilities({ plan: false });
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

/** The plan wiring's startup steps and status contributors. */
export function planWiringParts(plan: GraphPlan, reads: ReadBudget, store: KnowledgeStore,
  d: Pick<GraphBuildDeps, 'plan'>): WiringParts {
  return { startupSteps: [], statusContributors: [planContributor(plan, reads), boostContributor(plan, store, d)] };
}
