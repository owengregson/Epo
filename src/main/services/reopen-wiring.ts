/**
 * The reopen wiring: the re-entry supervisor, the follow-back watcher with its
 * notifications feed and managed-relationship reads, and the persisted sweep cadence.
 */

import type { InstagramAdapter } from '@/adapter/instagram-adapter';
import type { Reader } from '@/adapter/reader';
import type { Sentinel } from '@/adapter/sentinel';
import { FollowbackWatcher } from '@/engine/followback-watcher';
import { ReentrySupervisor } from '@/engine/reentry';
import type { SystemClock } from '@/governors/clock';
import type { ReadBudget } from '@/governors/read-budget';
import type { PlanDayClock } from '@/kernel/plan';
import { AdapterBackedFollowNotifications } from '@/rim/follow-notifications';
import { managedRelationships } from '@/rim/managed-relationships';
import type { AdapterBackedOwnFollowersSource } from '@/rim/own-followers-source';
import type { TabProfileVisitor } from '@/rim/profile-visit';
import { type Settings, toFollowbackConfig } from '@/settings/settings';
import type { KnowledgeStore } from '@/store/knowledge-store';
import type { Cadence } from '@/timing/schedule-manager';
import type { GraphBuildDeps, WiringParts } from './graph-types';
import type { createMutationPolicy } from './mutation-policy';

/** The re-entry supervisor over the graph's store. */
export function wireReentry(store: KnowledgeStore, clock: SystemClock): ReentrySupervisor {
  return new ReentrySupervisor({ store, clock });
}

/** Expiry is eligibility for reconciliation, not evidence of a missing follow-back. */
export function prepareReentry(reentry: ReentrySupervisor, clock: SystemClock): void {
  reentry.prepare(clock.now());
}

/** What the follow-back watcher is built from (the graph's shared pieces). */
export interface FollowbackWiring {
  store: KnowledgeStore;
  clock: SystemClock;
  ownPk: string;
  ownUsername: string | undefined;
  settings: Settings;
  readBudget: ReadBudget;
  policy: ReturnType<typeof createMutationPolicy>;
  adapter: InstagramAdapter;
  reader: Reader;
  sentinel: Sentinel;
  profiles: TabProfileVisitor;
  liveOwnFollowers: AdapterBackedOwnFollowersSource | null;
  /** The plan's plan-day boundary (spec §4.4). */
  dayClock: PlanDayClock;
}

/** The follow-back watcher over the notifications feed and the managed-relationship reads. */
export function wireFollowback(d: GraphBuildDeps, w: FollowbackWiring): FollowbackWatcher {
  const { store, clock, ownPk, ownUsername, settings, readBudget, policy, adapter, reader, sentinel,
    profiles, liveOwnFollowers, dayClock } = w;
  const driverSignal = d.driverSignal;
  // Follow-back detection reads the NOTIFICATIONS feed (one click on the bell,
  // one observed news-inbox response) — cheap enough for the hourly default
  // cadence. Sentinel-gated; a stop() interrupts the response wait.
  const followNotifications = new AdapterBackedFollowNotifications({
    readBudget,
    ownPk,
    canAccept: policy.canAccept,
    onAccepted: policy.onAccepted,
    tab: d.tab,
    actor: adapter.actor,
    reader,
    sentinel,
    store,
    abortSignal: driverSignal,
    reporter: d.reporter,
  });
  const followback = new FollowbackWatcher({
    signal: driverSignal,
    relationships: managedRelationships({ clock, readBudget, profiles, signal: driverSignal,
      validateIdentity: d.validateIdentity, onProgress: d.onProgress }),
    store,
    clock,
    ownPk,
    notifications: followNotifications,
    followers: liveOwnFollowers && ownUsername ? {
      fetchAllPks: async () => {
        const refreshed = await policy.refreshOwnStats();
        if (!refreshed.ok) return { pks: [], complete: false, reason: refreshed.reason, retryAt: refreshed.retryAt };
        return liveOwnFollowers.fetchAllPks();
      },
    } : undefined,
    cfg: toFollowbackConfig(settings),
    planDay: (t) => dayClock.window(t),
  });
  return followback;
}

/** The follow-back sweep's persisted cadence (and its persisted jitter factor). */
export function wireSweepCadence(d: GraphBuildDeps): Cadence {
  // The follow-back sweep cadence, persisted through Settings so the rhythm
  // survives restarts (docs/PRINCIPLES.md §3). The jitter factor is persisted
  // beside it: each completed sweep redraws a bounded interval factor, so the
  // check never lands on a bare hourly grid — and a restart mid-interval keeps
  // the factor already drawn.
  const sweepCadence = d.scheduler.cadence('engine:followback-sweep', {
    getLastRunAt: () => d.resolveSettings().sweepLastRunAt,
    setLastRunAt: (at) => {
      d.updateSettings({ sweepLastRunAt: at });
    },
    jitter: {
      getFactor: () => d.resolveSettings().sweepIntervalFactor,
      setFactor: (factor) => {
        d.updateSettings({ sweepIntervalFactor: factor });
      },
    },
  });
  return sweepCadence;
}

/** A verified mutation: the re-entry supervisor notes it and the progress seam hears it. */
export function noteMutationFor(
  reentry: ReentrySupervisor,
  clock: SystemClock,
  d: Pick<GraphBuildDeps, 'onProgress'>,
): () => void {
  const noteMutation = (): void => {
    reentry.noteAction(clock.now());
    d.onProgress?.('mutation-verified');
  };
  return noteMutation;
}

/** The requester predicate churn's selection reads (spec §9.9): an open request into our account, live. */
export function requesterPredicate(store: Pick<KnowledgeStore, 'hasActiveRequest'>): (pk: string) => boolean {
  return (pk) => store.hasActiveRequest(pk);
}

/** The reopen wiring's startup steps and status contributors (the reopen stream fills them). */
export function reopenWiringParts(): WiringParts {
  return { startupSteps: [], statusContributors: [] };
}
