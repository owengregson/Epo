/**
 * The journal half of the cadence facts: whether an unsettled write is due for its
 * settlement read (spec §9.8). Per account and per intent — never a global phase.
 */

import type { KnowledgeStore } from '../store/knowledge-store';

/** What the journal fact reads (the Engine's fact deps satisfy it). */
export interface JournalFactDeps {
  store: Pick<KnowledgeStore, 'effectIntents'>;
  /** Whether a settlement step is wired; without one nothing is ever due here. */
  settlesJournal?: boolean;
}

/** Whether an intent is due at `now` (dispatched or uncertain, any park served). */
export function journalDue(d: JournalFactDeps, now: number): boolean {
  return d.settlesJournal === true && d.store.effectIntents.due(now).length > 0;
}
