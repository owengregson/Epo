import type { FollowbackWatcher } from '@/engine/followback-watcher';
import type { ReentrySupervisor } from '@/engine/reentry';
import type { Clock } from '@/governors/clock';
import type { RateGovernor } from '@/governors/rate-governor';
import type { ReadBudget } from '@/governors/read-budget';
import type { ProfileVisitor } from '@/rim/profile-visit-port';
import type { Settings } from '@/settings/settings';
import type { ProtectionIndex } from '@/shared/unfollow-protection';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { createClickReview } from './click-review';
import { createMutationAdmission, type JournalGate } from './mutation-admission';
import { createOwnStats, type OwnStatsRefresh } from './own-stats';
import { createPrepareMutation } from './prepare-mutation';

export type { OwnStatsRefresh };

interface MutationPolicyDeps {
  store: KnowledgeStore;
  ownPk: string;
  ownUsername?: string;
  clock: Clock;
  rate: RateGovernor;
  reentry: ReentrySupervisor;
  readBudget: ReadBudget;
  profiles(): ProfileVisitor;
  followback(): FollowbackWatcher;
  settings(): Settings;
  protection(): ProtectionIndex;
  signal(): AbortSignal | undefined;
  validateIdentity?(): Promise<boolean>;
  onProgress?(phase: string): void;
  /** The reconciliation gate at admission; defaults to today's global re-entry check. */
  journal?: JournalGate;
}

/** Every writer proves identity and current relationship policy at the physical click boundary. */
export function createMutationPolicy(d: MutationPolicyDeps) {
  const active = async (): Promise<boolean> => {
    const original = d.signal();
    return !original?.aborted && (!d.validateIdentity || await d.validateIdentity())
      && !original?.aborted && !d.signal()?.aborted && original === d.signal();
  };
  const admission = createMutationAdmission({ ...d, active });
  const review = createClickReview({ ...d, active });
  const ownStats = createOwnStats({ ...d, active });
  return {
    resolveIdentity: ownStats.resolveIdentity,
    beforeMutation: admission.beforeMutation,
    prepareProfile: review.prepareProfile,
    canAccept: admission.canAccept,
    onAccepted: admission.onAccepted,
    refreshOwnStats: ownStats.refreshOwnStats,
    prepareMutation: createPrepareMutation({ ...d, active }),
  };
}
