/**
 * The standalone writers' settlement step: before a manual or prune mutation, settle the journal's
 * due intents (spec §9.8) and any owed relationship reconciliation.
 */

import type { FollowbackWatcher } from '@/engine/followback-watcher';
import { planDaySlots } from '@/engine/journal';
import type { ReentrySupervisor } from '@/engine/reentry';
import type { Clock } from '@/governors/clock';
import { calendarPlanDayClock } from '@/governors/plan-day-clock';
import type { ReadBudget } from '@/governors/read-budget';
import type { ParkSlots } from '@/kernel/derive-parks';
import { settleDueIntents } from '@/rim/journal-settlement';
import type { ProfileVisitor } from '@/rim/profile-visit-port';
import type { Settings } from '@/settings/settings';
import type { KnowledgeStore } from '@/store/knowledge-store';

export interface PrepareMutationDeps {
  store: KnowledgeStore;
  ownPk: string;
  clock: Clock;
  reentry: ReentrySupervisor;
  readBudget: ReadBudget;
  profiles(): ProfileVisitor;
  followback(): FollowbackWatcher;
  settings(): Settings;
  signal(): AbortSignal | undefined;
  /** The identity and run-token check every write repeats. */
  active(): Promise<boolean>;
  /** Where a park lands (default: local-midnight plan-days, until the wiring hands the plan's slots). */
  parkSlots?(): ParkSlots;
}

/** The mutation policy's `prepareMutation` (see `mutation-policy.ts`): true once nothing is owed. */
export function createPrepareMutation(d: PrepareMutationDeps): () => Promise<boolean> {
  const { store, clock, reentry, readBudget, ownPk, active } = d;
  const dayClock = calendarPlanDayClock({ now: () => clock.now() });
  const slots = d.parkSlots ?? ((): ParkSlots => planDaySlots(dayClock, clock.now()));
  return async (): Promise<boolean> => {
    const token = d.signal();
    const current = (): boolean => !token?.aborted && token === d.signal();
    if (!current() || !await active()) return false;
    await settleDueIntents({ store, profiles: d.profiles(), ownPk, clock, readBudget, slots,
      maxRetries: () => d.settings().maxRetries, signal: d.signal });
    if (!current() || !await active()) return false;
    if (reentry.requiresReconciliation(clock.now())) {
      const checked = await d.followback().check({ requireFresh: reentry.requiresCensus(clock.now()),
        freshSinceAt: reentry.snapshot().reconciliationStartedAt ?? undefined });
      if (checked.outcome !== 'complete' || !current() || !await active()) return false;
      reentry.noteReconciled(checked, clock.now());
    }
    return current() && !reentry.requiresReconciliation(clock.now());
  };
}
