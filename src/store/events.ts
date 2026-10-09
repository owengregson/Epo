/**
 * The domain vocabulary: facts in the past tense.
 *
 * Today the store's write path is a set of imperative methods whose merge
 * rules are hand-inlined into `ON CONFLICT` tails — `COALESCE(excluded.score,
 * follow_records.score)`, `MIN(edges.first_seen_at, excluded.first_seen_at)`,
 * the enrichment heal. Each of those IS a fold, written where no type and no
 * test can see it. This module starts the other half: an event is a value, and
 * the fold over it is a named pure function.
 *
 * Wave A lands the vocabulary and the canonical fold ONLY. Nothing here is on
 * the write path yet — `projectAccount` still drives the `accounts` table.
 * Migration 13 (the `events` table, the backfill and the shadow rebuild) is
 * designed in docs/adr/0701-event-log-plan.md and lands in wave B.
 *
 * One rule already visible here: **confidence is not stored.** It is
 * `SOURCE_CONFIDENCE[source]`, a pure function of provenance. Persisting it —
 * as `observations.confidence` does today — is a second source of truth for a
 * derived number.
 */

import type { AccountFields, Observation, Source } from './types';

export type { AccountFields, Source } from './types';
export { SOURCE_CONFIDENCE } from './types';

/** What every event carries, whatever it says. */
export interface Envelope {
  /** Log order, assigned by the append. Absent on an event not yet appended. */
  readonly seq?: number;
  /**
   * EVENT time, which may precede `seq` order — a notifications backfill
   * observes something that happened before the row ahead of it in the log.
   */
  readonly at: number;
  /** Provenance. Confidence is derived from it, never stored beside it. */
  readonly source: Source;
  /** Per-kind payload version, so the log can be migrated forward. */
  readonly v: 1;
}

/** We saw these fields on this account, from this source, at this moment. */
export interface AccountObserved extends Envelope {
  readonly kind: 'AccountObserved';
  readonly pk: string;
  readonly fields: AccountFields;
}

/**
 * The event union. One member today, by design: the fold that earns its keep
 * first is the account fold, and a union that grows ahead of its folds is a
 * vocabulary nobody speaks.
 */
export type DomainEvent = AccountObserved;

/** Every event kind, for exhaustiveness and for the `events(kind, at)` index. */
export const EVENT_KINDS = ['AccountObserved'] as const satisfies readonly DomainEvent['kind'][];

/**
 * Lift today's {@link Observation} into the event vocabulary — the seam wave B
 * backfills through, and what lets a test compare the fold against the
 * projection it will replace.
 */
export const accountObserved = (obs: Observation): AccountObserved => ({
  kind: 'AccountObserved',
  v: 1,
  at: obs.observedAt,
  source: obs.source,
  pk: obs.accountPk,
  fields: obs.fields,
});
