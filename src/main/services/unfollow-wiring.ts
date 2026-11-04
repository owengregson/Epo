/**
 * The unfollow wiring: the protection port over the settings service's live index, the mutation
 * policy's deps, the churn scheduler with its reconciler, and the prune engine's unfollow deps,
 * all on the plan's one plan-day boundary (spec §4.4), handed in by the graph build.
 */

import { ChurnScheduler } from '@/engine/churn-scheduler';
import type { FollowbackWatcher } from '@/engine/followback-watcher';
import { planDaySlots } from '@/engine/journal';
import { createProtectionPort, type ProtectionPort } from '@/engine/protection-port';
import { ProtectionReconciler } from '@/engine/protection-reconciler';
import type { PruneEngineDeps } from '@/engine/prune-engine';
import { scoreCandidate } from '@/engine/scorer';
import type { SourceFrontier } from '@/engine/source-frontier';
import { type Clock, SystemClock } from '@/governors/clock';
import type { RateGovernor } from '@/governors/rate-governor';
import type { ReadBudget } from '@/governors/read-budget';
import type { PlanDayClock } from '@/kernel/plan';
import type { AdapterBackedChurnActions } from '@/rim/churn-actions';
import { settleNextIntent } from '@/rim/journal-settlement';
import type { TabProfileVisitor } from '@/rim/profile-visit';
import type { ProfileVisitor } from '@/rim/profile-visit-port';
import { type Settings, toChurnConfig, toPruneConfig, toScorerConfig } from '@/settings/settings';
import type { StatusFields } from '@/shared/status-fields';
import type { SurfaceGate } from '@/shared/surface-gate';
import type { KnowledgeStore } from '@/store/knowledge-store';
import type { GraphBuildDeps, WiringParts } from './graph-types';
import type { MutationCadence } from './mutation-cadence';
import { createMutationPolicy } from './mutation-policy';
import { requesterPredicate } from './reopen-wiring';

type MutationPolicy = ReturnType<typeof createMutationPolicy>;

/** The protection port over the settings service's live index, on the plan's plan-day boundary (spec §4.4, §7). */
export function wireProtection(d: Pick<GraphBuildDeps, 'protection'>, clock: Clock, dayClock: PlanDayClock): { port: ProtectionPort } {
  return { port: createProtectionPort({ index: () => d.protection.index(), clock, dayClock }) };
}

/** The plan's next session start, a park slot (spec §9.9); null when none remains before the boundary. */
type NextSessionAt = (now: number) => number | null;
const noNextSession: NextSessionAt = () => null;

/** What the mutation policy is built from; the two later pieces are read through closures. */
export interface MutationPolicyWiring {
  store: KnowledgeStore;
  ownPk: string;
  ownUsername: string | undefined;
  clock: SystemClock;
  /** The plan's cadence (spec §5.13 S2): its admission before every visit, its deadline at dispatch. */
  cadence: MutationCadence;
  readBudget: ReadBudget;
  /** The plan's plan-day boundary (the park slots land on it). */
  dayClock: PlanDayClock;
  nextSessionAt?: NextSessionAt;
  /** The real surface gate (spec §10.6): pauses unfollows while the relationship surface is unconfirmed. */
  surfaceGate?: SurfaceGate;
  /** True while a cleanup run drives the tab. */
  cleanupRunning?(): boolean;
  profiles(): TabProfileVisitor;
  followback(): FollowbackWatcher;
}

/** The click-boundary policy every writer passes (identity, the plan's admission, current relationship). */
export function wireMutationPolicy(d: GraphBuildDeps, w: MutationPolicyWiring): MutationPolicy {
  const { store, ownPk, ownUsername, clock, cadence, readBudget, dayClock, surfaceGate, cleanupRunning } = w;
  const next = w.nextSessionAt ?? noNextSession;
  return createMutationPolicy({ store, ownPk, ownUsername, clock, cadence, readBudget, surfaceGate, cleanupRunning,
    profiles: w.profiles, followback: w.followback, settings: d.resolveSettings,
    protection: () => d.protection.index(),
    parkSlots: () => planDaySlots(dayClock, clock.now(), next(clock.now())),
    signal: d.driverSignal, validateIdentity: d.validateIdentity, onProgress: d.onProgress });
}

/** The engine's journal step: the oldest due intent settled with one read, on the plan-day slots (spec §9.8). */
export function journalSettler(
  d: Pick<GraphBuildDeps, 'resolveSettings' | 'driverSignal'>,
  w: { store: KnowledgeStore; profiles: ProfileVisitor; ownPk: string; clock: Clock; readBudget: ReadBudget; dayClock: PlanDayClock;
    nextSessionAt?: NextSessionAt },
): () => ReturnType<typeof settleNextIntent> {
  const { dayClock, nextSessionAt, ...settle } = w;
  const next = nextSessionAt ?? noNextSession;
  return () => settleNextIntent({ ...settle, slots: () => planDaySlots(dayClock, w.clock.now(), next(w.clock.now())),
    maxRetries: () => d.resolveSettings().maxRetries, signal: d.driverSignal });
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
  /** The plan's plan-day boundary (protection re-checks, the reconciler's day roll, the park slots). */
  dayClock: PlanDayClock;
  nextSessionAt?: NextSessionAt;
  /** The open session's start and planned unfollows: the bound on reviews that press nothing (spec §9.7). */
  reviewBound?(now: number): { readonly since: number; readonly planned: number } | null;
}

/** The churn scheduler with its config, the frontier's pick, the live eligibility check and protection. */
export function wireChurn(d: GraphBuildDeps, w: ChurnWiring): ChurnScheduler {
  const { frontier, store, clock, rate, churnActions, ownPk, settings, dayClock, reviewBound } = w;
  const next = w.nextSessionAt ?? noNextSession;
  const { port } = wireProtection(d, clock, dayClock);
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
    cfg: toChurnConfig(d.plan.settings.effective()),
    protection: port,
    reconciler,
    parkSlots: () => planDaySlots(dayClock, clock.now(), next(clock.now())),
    reviewBound,
    // An open request into our account keeps a record out of every timer and pick (spec §9.9).
    hasActiveRequest: requesterPredicate(store),
  });
  // The graph-open pass: rules that changed, or a plan-day that rolled, while Epo was closed; and the writes an
  // earlier run prepared but never dispatched, cancelled with no read (spec §9.8).
  reconciler.sync(clock.now());
  store.effectIntents.cancelInterruptedPrepared(clock.now());
  d.protection.setCapabilities({ protectionEverywhere: true });
  return churn;
}

/** The prune engine's unfollow-facing deps: its config, protection, the run stamp, the own-stats refresh. */
export function pruneUnfollowDeps(
  d: GraphBuildDeps,
  w: { settings: Settings; policy: MutationPolicy; ownUsername: string | undefined; dayClock: PlanDayClock },
): Pick<PruneEngineDeps, 'cfg' | 'protection' | 'onRunComplete' | 'refreshOwnStats'> {
  const { settings, policy, ownUsername } = w;
  return {
    cfg: toPruneConfig(settings),
    protection: wireProtection(d, new SystemClock(), w.dayClock).port,
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
      ? async () => {
          const refreshed = await policy.refreshOwnStats();
          if (!refreshed.ok) throw new Error(`Fresh own profile required: ${refreshed.reason}`);
          return refreshed.header;
        }
      : undefined,
  };
}

const PAUSED_FIELD = { 'needs-review': 'protection-needs-review', unavailable: 'protection-unavailable' } as const;

/** The unfollow wiring's status contributor: why every automatic unfollow is paused, or null (spec §7.6). */
export function unfollowWiringParts(): WiringParts {
  return {
    startupSteps: [],
    statusContributors: [{
      name: 'unfollowsPaused',
      contribute: (graph): Partial<StatusFields> => {
        if (graph === null) return {};
        const state = graph.churn.protectionState();
        return { unfollowsPaused: state === 'ready' ? null : PAUSED_FIELD[state] };
      },
    }],
  };
}
