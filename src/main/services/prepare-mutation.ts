/**
 * The standalone writers' settlement step: before a manual or prune mutation, settle the journal's
 * due intents (spec §9.8) — nothing else. The journal is per account, so an account still unsettled
 * refuses only its own next write (typed `journal`); every other write proceeds.
 */


import { planDaySlots } from '@/engine/journal';
import type { Clock } from '@/governors/clock';
import { calendarPlanDayClock } from '@/governors/plan-day-clock';
import type { ReadBudget } from '@/governors/read-budget';
import type { ParkSlots } from '@/kernel/derive-parks';
import { settleDueIntents } from '@/rim/journal-settlement';
import type { ProfileVisitor } from '@/rim/profile-visit-port';
import type { EffectiveSettings } from '@/settings/effective';
import type { KnowledgeStore } from '@/store/knowledge-store';

export interface PrepareMutationDeps {
  store: KnowledgeStore;
  ownPk: string;
  clock: Clock;
  readBudget: ReadBudget;
  profiles(): ProfileVisitor;
  settings(): Pick<EffectiveSettings, 'maxRetries'>;
  signal(): AbortSignal | undefined;
  /** The identity and run-token check every write repeats. */
  active(): Promise<boolean>;
  /** Where a park lands (default: local-midnight plan-days, until the wiring hands the plan's slots). */
  parkSlots?(): ParkSlots;
}

/** The mutation policy's `prepareMutation` (see `mutation-policy.ts`): true unless stopped or signed out. */
export function createPrepareMutation(d: PrepareMutationDeps): () => Promise<boolean> {
  const { store, clock, readBudget, ownPk, active } = d;
  const dayClock = calendarPlanDayClock({ now: () => clock.now() });
  const slots = d.parkSlots ?? ((): ParkSlots => planDaySlots(dayClock, clock.now()));
  return async (): Promise<boolean> => {
    const token = d.signal();
    const current = (): boolean => !token?.aborted && token === d.signal();
    if (!current() || !await active()) return false;
    await settleDueIntents({ store, profiles: d.profiles(), ownPk, clock, readBudget, slots,
      maxRetries: () => d.settings().maxRetries, signal: d.signal });
    return current() && await active();
  };
}
