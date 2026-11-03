/**
 * The unfollow wiring: the protection port over the settings service's live index, the mutation
 * policy's deps, the churn scheduler with its reconciler, and the prune engine's unfollow deps.
 */

import { ChurnScheduler } from '@/engine/churn-scheduler';
import type { FollowbackWatcher } from '@/engine/followback-watcher';
import { createProtectionPort, type ProtectionPort } from '@/engine/protection-port';
import { ProtectionReconciler } from '@/engine/protection-reconciler';
import type { PruneEngineDeps } from '@/engine/prune-engine';
import type { ReentrySupervisor } from '@/engine/reentry';
import { scoreCandidate } from '@/engine/scorer';
import type { SourceFrontier } from '@/engine/source-frontier';
import { type Clock, SystemClock } from '@/governors/clock';
import { calendarPlanDayClock } from '@/governors/plan-day-clock';
import type { RateGovernor } from '@/governors/rate-governor';
import type { ReadBudget } from '@/governors/read-budget';
import type { PlanDayClock } from '@/kernel/plan';
import type { AdapterBackedChurnActions } from '@/rim/churn-actions';
import type { TabProfileVisitor } from '@/rim/profile-visit';
import { type Settings, toChurnConfig, toPruneConfig, toScorerConfig } from '@/settings/settings';
import type { KnowledgeStore } from '@/store/knowledge-store';
import type { GraphBuildDeps, WiringParts } from './graph-types';
import { createMutationPolicy } from './mutation-policy';

type MutationPolicy = ReturnType<typeof createMutationPolicy>;

/** The protection port over the settings service's live index, on the one plan-day boundary (spec §4.4, §7). */
export function wireProtection(d: Pick<GraphBuildDeps, 'protection'>, clock: Clock): { port: ProtectionPort; dayClock: PlanDayClock } {
  // Local-midnight plan-days until the plan's own clock is swapped in here.
  const dayClock = calendarPlanDayClock({ now: () => clock.now() });
  return { port: createProtectionPort({ index: () => d.protection.index(), clock, dayClock }), dayClock };
}

/** What the mutation policy is built from; the two later pieces are read through closures. */
export interface MutationPolicyWiring {
  store: KnowledgeStore;
  ownPk: string;
  ownUsername: string | undefined;
  clock: SystemClock;
  rate: RateGovernor;
  reentry: ReentrySupervisor;
  readBudget: ReadBudget;
  profiles(): TabProfileVisitor;
  followback(): FollowbackWatcher;
}

/** The click-boundary policy every writer passes (identity, budget, current relationship). */
export function wireMutationPolicy(d: GraphBuildDeps, w: MutationPolicyWiring): MutationPolicy {
  const { store, ownPk, ownUsername, clock, rate, reentry, readBudget } = w;
  const driverSignal = d.driverSignal;
  const policy = createMutationPolicy({ store, ownPk, ownUsername, clock, rate, reentry, readBudget,
    profiles: w.profiles, followback: w.followback, settings: d.resolveSettings,
    protection: () => d.protection.index(),
    signal: driverSignal, validateIdentity: d.validateIdentity, onProgress: d.onProgress });
  return policy;
}

/** What the churn scheduler is built from (the graph's shared pieces). */
export interface ChurnWiring {
  frontier: SourceFrontier;
  store: KnowledgeStore;
  clock: SystemClock;
  rate: RateGovernor;
  churnActions: AdapterBackedChurnActions;
  ownPk: string;
  settings: Settings;
}

/** The churn scheduler with its config, the frontier's pick, the live eligibility check and protection. */
export function wireChurn(d: GraphBuildDeps, w: ChurnWiring): ChurnScheduler {
  const { frontier, store, clock, rate, churnActions, ownPk, settings } = w;
  const { port, dayClock } = wireProtection(d, clock);
  const reconciler = new ProtectionReconciler({ store, port, clock, dayClock });
  const churn = new ChurnScheduler({
    pickQueued: (records) => frontier.pickQueued(records),
    validateFollow: (record) => {
      const account = store.getAccount(record.accountPk);
      return account !== null && scoreCandidate(account, toScorerConfig(d.resolveSettings())).eligible;
    },
    store,
    clock,
    rate,
    actions: churnActions,
    ownPk,
    cfg: toChurnConfig(settings),
    protection: port,
    reconciler,
  });
  // The graph-open pass: rules that changed, or a plan-day that rolled, while Epo was closed.
  reconciler.sync(clock.now());
  return churn;
}

/** The prune engine's unfollow-facing deps: its config, protection, the run stamp, the own-stats refresh. */
export function pruneUnfollowDeps(
  d: GraphBuildDeps,
  w: { settings: Settings; policy: MutationPolicy; ownUsername: string | undefined },
): Pick<PruneEngineDeps, 'cfg' | 'protection' | 'onRunComplete' | 'refreshOwnStats'> {
  const { settings, policy, ownUsername } = w;
  return {
    cfg: toPruneConfig(settings),
    protection: wireProtection(d, new SystemClock()).port,
    // Persist the completed run's timestamp through the one settings save path
    // (also reloads live configs — harmless, and keeps one write path).
    onRunComplete: (at) => {
      d.updateSettings({ pruneLastRunAt: at });
    },
    // A scan's first act: ONE active profile-info fetch for our own account, so
    // the header counts sizing the progress bar (and backing the census
    // coverage guard) are fresh in the store — the passive observer alone can
    // miss them entirely (SPA profile loads don't always issue
    // the profile endpoint).
    refreshOwnStats: ownUsername
      ? async (): Promise<void> => {
          const refreshed = await policy.refreshOwnStats();
          if (!refreshed.ok) throw new Error(`Fresh own profile required: ${refreshed.reason}`);
        }
      : undefined,
  };
}

/** The unfollow wiring's startup steps and status contributors (the unfollow-decisions stream fills them). */
export function unfollowWiringParts(): WiringParts {
  return { startupSteps: [], statusContributors: [] };
}
