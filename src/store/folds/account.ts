/**
 * The canonical fold: an account, folded from what we observed about it.
 *
 * `projectAccount` (src/store/projections.ts) is the best code in the store
 * and it says so itself — in its own docstring it admits one weakness:
 * *identity fields have no persisted per-field provenance, so their merge is
 * newest-wins*. That means a `search` read (confidence 40) overwrites a
 * `profile`-read username (confidence 90) purely by arriving later.
 *
 * Make provenance first-class PER FIELD and the whole fold collapses to one
 * rule, applied uniformly to every field:
 *
 *   1. a strictly better source always wins;
 *   2. otherwise, newer-and-not-worse wins;
 *   3. otherwise the current value stands — provenance never rewinds.
 *
 * Three values today's fold computes and STORES stop existing here: `ratio`
 * (a generated column), `enrichment` (a pure function of three fields, read
 * at query time) and the `enrich_failed_at` heal (a fold over later events).
 * A stored derived value is a bug with a delay fuse.
 *
 * Not on the write path in wave A — see `src/store/events.ts`.
 */

import type { AccountObserved, DomainEvent } from '../events';
import { type AccountFields, SOURCE_CONFIDENCE } from '../types';

export { SOURCE_CONFIDENCE } from '../types';

/** A value, and the evidence for it. */
export interface Provenanced<T> {
  readonly value: T;
  readonly at: number;
  readonly conf: number;
}

/** Every observable field, each carrying its own evidence. */
export type ProvenancedFields = {
  readonly [K in keyof AccountFields]?: Provenanced<NonNullable<AccountFields[K]>>;
};

/** An account as folded from its events. No derived values, by construction. */
export interface AccountProjection {
  readonly pk: string;
  readonly fields: ProvenancedFields;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
}

/**
 * THE merge rule. One function, every field.
 *
 * The `>=` in clause 2 is deliberate: two reads of equal confidence at the
 * same instant are genuinely indistinguishable, so the later arrival wins and
 * the fold stays a total function. Everything else about the rule is
 * order-independent.
 */
export const merge = <T>(
  cur: Provenanced<T> | undefined,
  next: Provenanced<T>,
): Provenanced<T> => {
  if (cur === undefined) return next;
  if (next.conf > cur.conf) return next; // strictly better source
  if (next.at >= cur.at && next.conf >= cur.conf) return next; // newer, not worse
  return cur; // older, or weaker: never rewinds
};

const empty = (pk: string, at: number): AccountProjection => ({
  pk,
  fields: {},
  firstSeenAt: at,
  lastSeenAt: at,
});

const FIELD_NAMES = [
  'username',
  'followers',
  'following',
  'mutuals',
  'isPrivate',
  'isVerified',
  'activitySignal',
  'bio',
] as const satisfies readonly (keyof AccountFields)[];

const applyObserved = (
  state: AccountProjection | null,
  e: AccountObserved,
): AccountProjection => {
  const conf = SOURCE_CONFIDENCE[e.source];
  const base = state ?? empty(e.pk, e.at);
  const fields: Record<string, Provenanced<unknown>> = { ...base.fields };
  for (const key of FIELD_NAMES) {
    const value = e.fields[key];
    if (value === undefined) continue;
    fields[key] = merge(fields[key], { value, at: e.at, conf });
  }
  return {
    pk: base.pk,
    fields: fields as ProvenancedFields,
    firstSeenAt: Math.min(base.firstSeenAt, e.at),
    lastSeenAt: Math.max(base.lastSeenAt, e.at),
  };
};

/**
 * Fold one event onto an account. Total: an event of another kind leaves the
 * state alone rather than throwing, so a caller can pass the whole log.
 */
export const foldAccount = (
  state: AccountProjection | null,
  event: DomainEvent,
): AccountProjection | null => {
  if (event.kind !== 'AccountObserved') return state;
  return applyObserved(state, event);
};

/** Fold a whole stream for ONE account. `null` when nothing applied. */
export const foldAccountStream = (events: readonly DomainEvent[]): AccountProjection | null =>
  events.reduce<AccountProjection | null>(foldAccount, null);

/** Fold a mixed stream into one projection per account. */
export const foldAccounts = (
  events: readonly DomainEvent[],
): Map<string, AccountProjection> => {
  const out = new Map<string, AccountProjection>();
  for (const e of events) {
    if (e.kind !== 'AccountObserved') continue;
    const next = foldAccount(out.get(e.pk) ?? null, e);
    if (next !== null) out.set(e.pk, next);
  }
  return out;
};

/** Strip the provenance — the plain field values a projection table stores. */
export const valuesOf = (p: AccountProjection): AccountFields => {
  const out: Record<string, unknown> = {};
  for (const [key, prov] of Object.entries(p.fields)) {
    if (prov !== undefined) out[key] = prov.value;
  }
  return out as AccountFields;
};
