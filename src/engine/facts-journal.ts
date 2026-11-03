/**
 * The reconcile half of the cadence facts: whether the re-entry supervisor
 * still owes a reconciliation before the next mutation.
 */

/** What the reconcile fact reads (the Engine's fact deps satisfy it). */
export interface JournalFactDeps {
  requiresReconciliation?(now: number): boolean;
}

/** Whether a reconciliation is owed at `now`; false when no supervisor is wired. */
export function reconcileDue(d: JournalFactDeps, now: number): boolean {
  return d.requiresReconciliation?.(now) ?? false;
}
