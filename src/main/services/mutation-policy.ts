import { ActionAbortedError } from '@/adapter/errors';
import type { FollowbackWatcher } from '@/engine/followback-watcher';
import type { Clock } from '@/governors/clock';
import type { ReadBudget } from '@/governors/read-budget';
import type { ParkSlots } from '@/kernel/derive-parks';
import type { Writer } from '@/kernel/plan';
import type { ProfileVisitor } from '@/rim/profile-visit-port';
import type { EffectiveSettings } from '@/settings/effective';
import type { SurfaceGate } from '@/shared/surface-gate';
import type { ProtectionIndex } from '@/shared/unfollow-protection';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { createClickReview } from './click-review';
import { createMutationAdmission, type ReviewedAction } from './mutation-admission';
import type { MutationCadence } from './mutation-cadence';
import { createOwnStats, type OwnStatsRefresh } from './own-stats';
import { createPrepareMutation } from './prepare-mutation';

export type { OwnStatsRefresh };

interface MutationPolicyDeps {
  store: KnowledgeStore;
  ownPk: string;
  ownUsername?: string;
  clock: Clock;
  /** The plan's cadence: the admission before the visit, the deadline armed at dispatch (spec §5.13 S2). */
  cadence: MutationCadence;
  readBudget: ReadBudget;
  profiles(): ProfileVisitor;
  followback(): FollowbackWatcher;
  settings(): EffectiveSettings;
  protection(): ProtectionIndex;
  signal(): AbortSignal | undefined;
  validateIdentity?(): Promise<boolean>;
  onProgress?(phase: string): void;
  /** Where a journal park lands (the unfollow wiring hands the plan-day slots). */
  parkSlots?(): ParkSlots;
  /** Pauses unfollows while the relationship surface is unconfirmed (spec §10.6; default: never paused). */
  surfaceGate?: SurfaceGate;
  /** True while a cleanup run drives the tab (its writes are `cleanup-run`; otherwise prune writes are woven). */
  cleanupRunning?(): boolean;
}

/** Which loop a write belongs to, from the channel of the account's prepared journal intent. */
function writerFor(store: KnowledgeStore, pk: string, cleanupRunning: () => boolean): Writer {
  const intent = store.effectIntents.unsettledFor(pk).find((i) => i.state === 'prepared');
  if (intent?.channel === 'manual') return 'manual';
  if (intent?.channel === 'prune') return cleanupRunning() ? 'cleanup-run' : 'woven';
  return 'growth';
}

/** Every writer proves identity and current relationship policy at the physical click boundary. */
export function createMutationPolicy(d: MutationPolicyDeps) {
  const active = async (): Promise<boolean> => {
    const original = d.signal();
    return !original?.aborted && (!d.validateIdentity || await d.validateIdentity())
      && !original?.aborted && !d.signal()?.aborted && original === d.signal();
  };
  const cleanupRunning = d.cleanupRunning ?? (() => false);
  // The write under review and the one it admitted: actions are serialized on the one tab.
  let writer: Writer = 'growth';
  let reviewed: ReviewedAction | null = null;
  let dispatchGuard: (() => void) | null = null;
  const review = createClickReview({ ...d, active, writer: () => writer,
    preflight: (kind, w, now, subject) => d.cadence.preflight(kind, w, now, subject) });
  const admission = createMutationAdmission({ ...d, active, takeReviewed: () => {
    const r = reviewed;
    reviewed = null;
    if (r !== null) dispatchGuard?.();
    return r;
  } });
  const ownStats = createOwnStats({ ...d, active });
  return {
    resolveIdentity: ownStats.resolveIdentity,
    beforeMutation: admission.beforeMutation,
    prepareProfile: async (username: string, expectedPk: string, action: 'follow' | 'unfollow'): Promise<() => void> => {
      reviewed = null;
      dispatchGuard = null;
      writer = writerFor(d.store, expectedPk, cleanupRunning);
      await review.prepareProfile(username, expectedPk, action);
      reviewed = { kind: action, writer, subject: { pk: expectedPk } };
      const protectionGuard = review.dispatchGuard();
      dispatchGuard = () => {
        if (d.settings().dryRun) throw new ActionAbortedError('mutation-practice');
        protectionGuard();
      };
      return dispatchGuard;
    },
    canAccept: admission.canAccept,
    onAccepted: admission.onAccepted,
    refreshOwnStats: ownStats.refreshOwnStats,
    prepareMutation: createPrepareMutation({ ...d, active }),
  };
}
