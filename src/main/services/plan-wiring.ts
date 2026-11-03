/**
 * The plan wiring (ADR 0607, spec §5.13 S1): the plan service, the single writer of the day plan,
 * over the store and the live settings; its plan-backed day clock (the one boundary every day
 * counter reads); the plan and Boost status contributors; and the settings preview port. The
 * reference tempo stays in force (the plan's tempo is swapped in with the cadence switch).
 */

import type { Clock, SystemClock } from '@/governors/clock';
import { projectBoost } from '@/governors/plan-boost';
import { projectPlan } from '@/governors/plan-projection';
import { PlanService } from '@/governors/plan-service';
import { ReadBudget } from '@/governors/read-budget';
import { patternCircadianProfile } from '@/settings/pattern-map';
import { toPlanIntent } from '@/settings/plan-intent';
import { toReadAllowance } from '@/settings/read-allowance';
import { type Settings, toPacingConfig } from '@/settings/settings';
import { NEVER_PAUSED } from '@/shared/surface-gate';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { samplePhaseOffset } from '@/timing/circadian';
import { CIRCADIAN } from '@/timing/config';
import { type PlannerSnapshot, SessionPlanner } from '@/timing/session-planner';
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

/** The organic planner when the settings select it, else undefined (the legacy metronome). */
function wirePacing(store: KnowledgeStore, settings: Settings): SessionPlanner | undefined {
  // The per-install circadian phase offset lives in the snapshot, so it is stable
  // across restarts and freshly drawn on first run.
  let pacingSnap: PlannerSnapshot | null = null;
  const pacingSnapRaw = store.getPacingState();
  if (pacingSnapRaw !== null) {
    try {
      pacingSnap = JSON.parse(pacingSnapRaw) as PlannerSnapshot;
    } catch (e) {
      logger.warn('foundation: bad pacing snapshot, starting fresh', { error: String(e) });
    }
  }
  const phaseOffset =
    pacingSnap?.phaseOffsetHours ??
    samplePhaseOffset(CIRCADIAN.PHASE_JITTER_MAX_HOURS, launchStream('main/plan-wiring'));
  return settings.pacingModel === 'organic'
    ? new SessionPlanner({
        profile: patternCircadianProfile(settings.pattern, phaseOffset),
        cfg: toPacingConfig(settings),
        snapshot: pacingSnap,
      })
    : undefined;
}

/** What the plan wiring hands the graph: the graph's plan, plus the session planner it still runs. */
export interface PlanWiring extends GraphPlan {
  readonly pacing: SessionPlanner | undefined;
}

/** The plan service over the store and the live settings, and the one plan-day boundary it backs. */
export function wirePlan(store: KnowledgeStore, clock: Clock, ownPk: string,
  d: Pick<GraphBuildDeps, 'plan' | 'settings'>): PlanWiring {
  const host = d.plan;
  const effective = () => host.settings.effective();
  const installEntropy = store.installEntropy();
  const service = new PlanService({
    store,
    clock,
    installEntropy,
    launchSeed: (installEntropy ^ (clock.now() >>> 0)) >>> 0,
    intent: () => toPlanIntent(effective()),
    demand: (window, now) => planDemand(store, effective(), ownPk, window, now),
    lastMutationBefore: (t) => lastMutationBefore(store, t),
    // Outside actions arrive with the own-header log; until then none are charged.
    outsideSince: () => 0,
    // The engine still arms the shared delay itself; the plan's deadline arrives with the cadence switch.
    deadline: () => null,
    journal: { blocks: () => false },
    runIntent: () => host.runIntent(),
    unconfirmed: () => null,
    surfaceGate: NEVER_PAUSED,
  }, { log: logger });
  host.settings.setPlanPort(service);
  host.settings.setCapabilities({ plan: true });
  return {
    service,
    dayClock: service.planDayClock(),
    pacing: wirePacing(store, d.settings),
    dispose: () => {
      host.settings.setPlanPort(null);
      host.settings.setCapabilities({ plan: false });
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
