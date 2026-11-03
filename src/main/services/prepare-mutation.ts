/**
 * The standalone writers' settlement step: before a manual or prune mutation,
 * settle the journal's uncertain effects and any owed relationship reconciliation.
 */

import type { FollowbackWatcher } from '@/engine/followback-watcher';
import type { ReentrySupervisor } from '@/engine/reentry';
import type { Clock } from '@/governors/clock';
import type { ReadBudget } from '@/governors/read-budget';
import { reconcileEffects } from '@/rim/effect-reconciliation';
import type { ProfileVisitor } from '@/rim/profile-visit-port';
import type { KnowledgeStore } from '@/store/knowledge-store';

export interface PrepareMutationDeps {
  store: KnowledgeStore;
  ownPk: string;
  clock: Clock;
  reentry: ReentrySupervisor;
  readBudget: ReadBudget;
  profiles(): ProfileVisitor;
  followback(): FollowbackWatcher;
  signal(): AbortSignal | undefined;
  /** The identity and run-token check every write repeats. */
  active(): Promise<boolean>;
}

/** The mutation policy's `prepareMutation` (see `mutation-policy.ts`): true once nothing is owed. */
export function createPrepareMutation(d: PrepareMutationDeps): () => Promise<boolean> {
  const { store, clock, reentry, readBudget, ownPk, active } = d;
  return async (): Promise<boolean> => {
    const token = d.signal();
    const current = (): boolean => !token?.aborted && token === d.signal();
    if (!current() || !await active()) return false;
    const result = await reconcileEffects({ store, profiles: d.profiles(), ownPk, clock, readBudget, signal: d.signal });
    if (result.outcome !== 'complete' || !current() || !await active()) return false;
    if (reentry.requiresReconciliation(clock.now())) {
      const checked = await d.followback().check({ requireFresh: reentry.requiresCensus(clock.now()),
        freshSinceAt: reentry.snapshot().reconciliationStartedAt ?? undefined });
      if (checked.outcome !== 'complete' || !current() || !await active()) return false;
      reentry.noteReconciled(checked, clock.now());
    }
    return current() && !reentry.requiresReconciliation(clock.now());
  };
}
