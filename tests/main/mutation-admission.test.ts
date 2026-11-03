import { ActionDeferredError } from '@/adapter/errors';
import {
  createMutationAdmission,
  type JournalGate,
  type MutationAdmissionDeps,
  reentryJournalGate,
} from '@/main/services/mutation-admission';

/** An admission over open budgets, no owed delay and no probation; only the reconciliation gate varies. */
function admission(reentryOwes: boolean, journal?: JournalGate) {
  let deadline: number | null = null;
  const d = {
    store: {
      getActionDelayDeadline: () => deadline,
      setActionDelayDeadline: (at: number | null) => { deadline = at; },
      pendingEffectIntents: () => [],
    },
    clock: { now: () => 1_000 },
    rate: { atHardCeiling: () => false, atOperatingRate: () => false, actionsInLastHour: () => 0, nextDelayMs: () => 50 },
    reentry: { requiresReconciliation: () => reentryOwes, mutationWaitUntil: () => null, noteAction: () => {} },
    settings: () => ({ hourlyVelocityCap: 10, dryRun: false }),
    active: async () => true,
    journal,
  } as unknown as MutationAdmissionDeps;
  return { gate: createMutationAdmission(d), deadline: () => deadline };
}

describe('the journal gate at mutation admission', () => {
  test('the default gate is the global re-entry check', async () => {
    await expect(admission(true).gate.beforeMutation()).rejects.toThrow(ActionDeferredError);
    const open = admission(false);
    await open.gate.beforeMutation();
    expect(open.deadline()).toBe(1_050);
    expect(reentryJournalGate({ requiresReconciliation: (now) => (now ?? 0) > 5 }).requiresReconciliation(6)).toBe(true);
  });

  test('an injected gate decides in place of the re-entry check', async () => {
    await expect(admission(false, { requiresReconciliation: () => true }).gate.beforeMutation())
      .rejects.toThrow('relationship reconciliation required');
    const cleared = admission(true, { requiresReconciliation: () => false });
    await cleared.gate.beforeMutation();
    expect(cleared.deadline()).toBe(1_050);
  });
});
