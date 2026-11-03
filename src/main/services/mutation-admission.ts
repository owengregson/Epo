/**
 * The mutation admission: the account budget, the journal and probation gates
 * and the shared delay every write passes, plus the request-acceptance pair.
 */

import { ActionAbortedError, ActionDeferredError } from '@/adapter/errors';
import type { ReentrySupervisor } from '@/engine/reentry';
import type { Clock } from '@/governors/clock';
import type { RateGovernor } from '@/governors/rate-governor';
import type { Settings } from '@/settings/settings';
import type { KnowledgeStore } from '@/store/knowledge-store';

/** Whether a reconciliation must settle before the next mutation may run. */
export interface JournalGate {
  requiresReconciliation(now: number): boolean;
}

/** The default gate: today's global re-entry check. */
export function reentryJournalGate(reentry: Pick<ReentrySupervisor, 'requiresReconciliation'>): JournalGate {
  return { requiresReconciliation: (now) => reentry.requiresReconciliation(now) };
}

export interface MutationAdmissionDeps {
  store: KnowledgeStore;
  clock: Clock;
  rate: RateGovernor;
  reentry: ReentrySupervisor;
  settings(): Settings;
  onProgress?(phase: string): void;
  /** The identity and run-token check every write repeats. */
  active(): Promise<boolean>;
  /** The reconciliation gate; defaults to {@link reentryJournalGate}. */
  journal?: JournalGate;
}

/** The admission half of the mutation policy (see `mutation-policy.ts`). */
export function createMutationAdmission(d: MutationAdmissionDeps) {
  const { store, clock, rate, reentry, active } = d;
  const journal = d.journal ?? reentryJournalGate(reentry);
  const budgetOpen = (): boolean => !rate.atHardCeiling() && !rate.atOperatingRate()
    && rate.actionsInLastHour() < d.settings().hourlyVelocityCap;
  return {
    beforeMutation: async (): Promise<void> => {
      if (!await active()) throw new ActionAbortedError('mutation-admission');
      if (!budgetOpen()) throw new ActionDeferredError('account mutation budget exhausted');
      const now = clock.now();
      if (journal.requiresReconciliation(now)) throw new ActionDeferredError('relationship reconciliation required');
      if (reentry.mutationWaitUntil(now) !== null) throw new ActionDeferredError('return probation delay still owed');
      if ((store.getActionDelayDeadline() ?? 0) > now) throw new ActionDeferredError('shared mutation delay still owed');
      store.setActionDelayDeadline(now + rate.nextDelayMs());
    },
    canAccept: async (): Promise<boolean> => !d.settings().dryRun && await active() && budgetOpen()
      && (store.getActionDelayDeadline() ?? 0) <= clock.now()
      && reentry.mutationWaitUntil(clock.now()) === null
      && !store.pendingEffectIntents().some((i) => i.state !== 'prepared'),
    onAccepted: (): void => {
      const now = clock.now();
      store.setActionDelayDeadline(now + rate.nextDelayMs());
      reentry.noteAction(now);
      d.onProgress?.('request-accepted');
    },
  };
}
