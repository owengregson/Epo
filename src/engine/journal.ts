/**
 * The journal (spec §9.8): the per-account gate, which unsettled writes are due for an observation,
 * and the settlement table — what one observation of an intent's account settles. Pure; the rim's
 * `journal-settlement.ts` reads the account and applies the result.
 */

import { type ParkKind, type ParkSlots, parkTerminal, parkUntil } from '../kernel/derive-parks';
import type { EffectIntent, EffectSettlement, FollowRecord } from '../store/types';

/** A write whose outcome the journal still owes: dispatched, or dispatched and unverified. */
function open(i: EffectIntent): boolean {
  return i.state === 'dispatched' || i.state === 'uncertain';
}

/** Whether an earlier write to `pk` is still open; the caller's own intent is excepted (spec §9.8). */
export function journalBlocks(pk: string, unsettled: readonly EffectIntent[], exceptIntentId?: string): boolean {
  return unsettled.some((i) => i.accountPk === pk && i.id !== exceptIntentId && open(i));
}

/** Whether `i` is due for its settlement read at `now`: open, and any park it has served. */
export function journalDue(i: EffectIntent, now: number): boolean {
  return open(i) && (i.nextAttemptAt === null || i.nextAttemptAt <= now);
}

/** One observation of an intent's account: a fresh page, an unavailable one, a wall, or a refused read. */
export interface IntentObservation {
  readonly kind: 'ok' | 'absent' | 'renamed' | 'unreadable' | 'walled' | 'read-budget';
  readonly following?: boolean | null;
  readonly requested?: boolean | null;
  readonly followsUs?: boolean | null;
  readonly at: number;
  readonly resumeAt?: number | null;
}

/** What one observation settles: the intent (with its record and edge), a park, a terminal, or the ladder. */
export type Settlement =
  | { readonly settle: EffectSettlement; readonly closesRequest?: true }
  | {
      readonly park: { readonly attempts: number; readonly nextAttemptAt: number };
      readonly recordPark: ParkKind | null;
      readonly record: FollowRecord | null;
    }
  | { readonly expire: EffectSettlement; readonly recordTerminal: 'external' | 'abandoned' | null }
  | { readonly ladder: true };

export interface SettlementContext {
  readonly ownPk: string;
  readonly slots: ParkSlots;
  /** Failed attempts a record survives before it is abandoned (the churn config's retries). */
  readonly maxRetries: number;
}

const TERMINAL: ReadonlySet<FollowRecord['state']> = new Set(['unfollowed', 'abandoned', 'external']);

/** Whether the relation the verb acts on holds now (we follow or requested; for an accept, they follow us). */
function holds(i: EffectIntent, o: IntentObservation): boolean | null {
  if (i.action === 'accept-request') return o.followsUs ?? null;
  if (o.following === true || o.requested === true) return true;
  return o.following === false && o.requested === false ? false : null;
}

/**
 * The settlement of `intent` by one observation of its account (spec §9.8, row by row). Records move
 * only for the growth loop's own writes, and never out of a terminal state.
 */
export function settlementFor(
  intent: EffectIntent, o: IntentObservation, rec: FollowRecord | null, ctx: SettlementContext,
): Settlement {
  if (o.kind === 'walled') return { ladder: true };
  if (o.kind === 'read-budget') {
    const nextAttemptAt = o.resumeAt ?? ctx.slots.planDayStartAfter(1);
    return { park: { attempts: intent.attempts, nextAttemptAt }, recordPark: null, record: null };
  }
  const managed = intent.channel === 'growth' && rec !== null && !TERMINAL.has(rec.state) ? rec : null;
  if (o.kind === 'absent' || o.kind === 'renamed') return unavailable('unreachable', intent, o.at, managed, ctx);
  const relation = o.kind === 'ok' ? holds(intent, o) : null;
  return relation === null ? unavailable('unreadable', intent, o.at, managed, ctx)
    : observed(intent, relation, o.at, managed, ctx);
}

/** A readable account: whether the write landed decides the intent, the record and the edge. */
function observed(i: EffectIntent, relation: boolean, at: number, rec: FollowRecord | null, ctx: SettlementContext): Settlement {
  if (i.action === 'accept-request') {
    return relation
      ? { settle: { at, result: 'external', ledger: 'none',
        edge: { srcPk: i.accountPk, dstPk: ctx.ownPk, active: true, observedAt: at } }, closesRequest: true }
      : { settle: { at, result: 'cancelled', ledger: 'none' } };
  }
  const edge = { srcPk: ctx.ownPk, dstPk: i.accountPk, active: relation, observedAt: at };
  if (i.action === 'follow') {
    // The mirror of F6: a follow that landed waits for its follow-back from the dispatch it made.
    const record = rec?.state !== 'queued' ? undefined : relation
      ? { ...rec, state: 'pending_followback' as const, followedAt: i.dispatchedAt ?? at, reconciledAt: at }
      : retried(rec, at, ctx.maxRetries);
    return { settle: { at, result: relation ? 'external' : 'cancelled', ledger: 'none', edge, record } };
  }
  // U06 F6: an unfollow that did not land stays queued for its unfollow; one that landed closes the record.
  if (relation) {
    const record = rec?.state === 'unfollow_queued' ? { ...rec, reconciledAt: at } : undefined;
    return { settle: { at, result: 'cancelled', ledger: 'none', edge, record } };
  }
  const record = rec === null ? undefined : { ...rec, state: 'unfollowed' as const, reconciledAt: at };
  return { settle: { at, result: 'external', ledger: 'none', edge, record } };
}

/** A follow that did not land spends one retry; past the limit its record is abandoned. */
function retried(rec: FollowRecord, at: number, maxRetries: number): FollowRecord {
  const retryCount = rec.retryCount + 1;
  return retryCount > maxRetries ? { ...rec, state: 'abandoned', retryCount, abandonedAt: at } : { ...rec, retryCount };
}

/** An unavailable account parks on the plan's schedule and ends in an honest terminal (spec §9.9). */
function unavailable(kind: ParkKind, i: EffectIntent, at: number, rec: FollowRecord | null, ctx: SettlementContext): Settlement {
  const k = i.attempts + 1;
  if (parkTerminal(kind, k)) {
    const state = kind === 'unreachable' ? 'external' as const : 'abandoned' as const;
    const record = rec === null ? undefined : { ...rec, state, parkReason: kind, checkFailures: k, recheckAt: undefined,
      ...(state === 'abandoned' ? { abandonedAt: at } : {}) };
    return { expire: { at, result: 'expired', ledger: 'none', record }, recordTerminal: rec === null ? null : state };
  }
  const nextAttemptAt = parkUntil(kind, k, ctx.slots);
  return { park: { attempts: k, nextAttemptAt }, recordPark: rec === null ? null : kind,
    record: rec === null ? null : { ...rec, parkReason: kind, checkFailures: k, recheckAt: nextAttemptAt } };
}
