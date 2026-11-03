/**
 * What a click verdict does to the record (spec §9.7): the churn scheduler's one writer of the review
 * columns. Pure. The protection verdicts move through `protection-gate.keepRecord` (one guarded move),
 * so they — like proceed, a pending request and a deferral — return the record unchanged here.
 */

import { type ParkKind, type ParkSlots, parkTerminal, parkUntil } from '../kernel/derive-parks';
import type { ClickVerdict } from '../shared/click-verdict';
import type { FollowRecord } from '../store/types';

export interface ClickVerdictContext {
  readonly now: number;
  /** The hold a follow-back first seen at the click earns. */
  readonly holdMs: number;
  /** The best lower bound on when that follow-back happened (our follow), when known. */
  readonly followbackAfter: number | undefined;
  readonly slots: ParkSlots;
}

/** A readable page ends any earlier park. */
const READ = { parkReason: undefined, checkFailures: 0, recheckAt: undefined } as const;

/** The record after `v` (the same object when the verdict leaves it alone). */
export function applyClickVerdict(rec: FollowRecord, v: ClickVerdict, ctx: ClickVerdictContext): FollowRecord {
  switch (v.kind) {
    case 'reheld':
      return { ...rec, ...READ, state: 'followed_back', followbackObservedAt: ctx.now,
        followbackAfter: ctx.followbackAfter, holdUntil: ctx.now + ctx.holdMs, reconciledAt: ctx.now };
    case 'not-due':
      return { ...rec, ...READ, state: 'followed_back', reconciledAt: ctx.now };
    case 'already-gone':
      return { ...rec, ...READ, state: 'external', reconciledAt: ctx.now };
    case 'unavailable':
      return parked(rec, v.evidence === 'unreadable' ? 'unreadable' : 'unreachable', ctx);
    default:
      return rec;
  }
}

/** The k-th unavailable reading parks on the plan's schedule, then ends in an honest terminal (spec §9.9). */
function parked(rec: FollowRecord, kind: ParkKind, ctx: ClickVerdictContext): FollowRecord {
  const k = (rec.checkFailures ?? 0) + 1;
  if (!parkTerminal(kind, k)) return { ...rec, parkReason: kind, checkFailures: k, recheckAt: parkUntil(kind, k, ctx.slots) };
  return kind === 'unreachable'
    ? { ...rec, state: 'external', parkReason: kind, checkFailures: k, recheckAt: undefined }
    : { ...rec, state: 'abandoned', parkReason: kind, checkFailures: k, recheckAt: undefined, abandonedAt: ctx.now };
}
