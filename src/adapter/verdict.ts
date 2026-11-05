/**
 * VERDICT — what actually happened to one action, as a value.
 *
 * Today a follow's outcome is spread across three layers: the Actor throws
 * `ActionRateLimitedError` / `ActionBlockedError` or returns a `Result`,
 * `churn-actions` maps those onto `ChurnActionOutcome`'s optional cause flags,
 * and `applyOutcome` re-derives from them whether the record may be touched.
 * The invariant "a BLOCKED action leaves the record untouched" therefore lives
 * in four files as a convention.
 *
 * A `Verdict` carries its own record `effect`, produced by the ONE classifier
 * that has all the evidence. There is no other constructor for `throttled` or
 * `walled`, and the ledger writer takes only the narrowed {@link CommitVerdict}
 * — so a throttled verdict cannot be handed to it even by mistake.
 *
 * THIS WAVE: the Actor still returns `Result<{clicked}>` and still throws the
 * two error classes, because `churn-actions.ts` must keep returning the
 * `ChurnActionOutcome` the engine consumes. The Verdict is produced first and
 * mapped to those at the edge (`toActorResult`), so the arbitration exists
 * exactly once and the engine contract is untouched. Wave B moves the engine
 * onto `Outcome` and deletes the mapping.
 */

import type { MutationKind, SentinelStatus } from '@/adapter/ig-surface';

/** What a verdict does to the follow record. */
export type VerdictEffect =
  /** The action landed: write the ledger row and transition the record. */
  | 'commit'
  /** Already in the target state: reconcile the graph, no attempt was made. */
  | 'reconcile'
  /** A real, per-account refusal: a failed attempt for THIS account. */
  | 'fail'
  /** A wall or throttle: the record must be left EXACTLY as it was. */
  | 'untouched'
  /** The click may have landed unverified: mark it for re-observation (ADR 0206). */
  | 'mark-unverified';

/** Everything that was observed about the action, for the log and the meter. */
export interface Evidence {
  /** Which observation decided it. `none` = nothing arbitrated at all. */
  source: 'response' | 'dom' | 'both' | 'none';
  httpStatus?: number;
  /** The server's own words, e.g. `feedback_required — Try Again Later`. */
  serverMessage?: string;
  subjectPk?: string | null;
  controlStateBefore?: string;
  controlStateAfter?: string;
  observedAtMs: number;
  /** Press → response, in ms. Feeds `SurfaceMeter`'s mutation-arrival metric. */
  latencyMs?: number;
}

/** The action landed — the ONLY verdict the ledger writer accepts. */
export interface CommitVerdict {
  kind: 'landed';
  effect: 'commit';
  op: MutationKind;
  evidence: Evidence;
}

export type Verdict =
  | CommitVerdict
  /** The control was already in the target state; nothing was pressed. */
  | { kind: 'noop'; effect: 'reconcile'; op: MutationKind; evidence: Evidence }
  /** An ordinary per-account refusal (unknown message, 404). */
  | { kind: 'refused'; effect: 'fail'; op: MutationKind; evidence: Evidence; detail: string }
  /** Instagram's SERVER said no — definitive; the ladder enters on the first one. */
  | {
      kind: 'throttled';
      effect: 'untouched';
      op: MutationKind;
      evidence: Evidence;
      wall: SentinelStatus;
      detail: string;
    }
  /** An on-screen interstitial / session wall answered instead of the control. */
  | {
      kind: 'walled';
      effect: 'untouched';
      op: MutationKind;
      evidence: Evidence;
      wall: SentinelStatus;
      detail: string;
    }
  /** The click was dispatched and nothing confirmed it — it MAY have landed. */
  | { kind: 'ambiguous'; effect: 'mark-unverified'; op: MutationKind; evidence: Evidence }
  /** Nothing explains what was seen: the surface itself is suspect. */
  | { kind: 'drift'; effect: 'untouched'; op: MutationKind; evidence: Evidence; control: string };

/** Narrow a verdict to the one the ledger writer may be handed. */
export const isCommit = (v: Verdict): v is CommitVerdict => v.kind === 'landed';

/**
 * The record effect of every verdict kind, as a table rather than as branches.
 * `satisfies` makes a new verdict kind a COMPILE error here — which is the
 * point: a kind with no declared record effect is exactly how "untouched on
 * block" gets lost again.
 */
export const VERDICT_EFFECT = {
  landed: 'commit',
  noop: 'reconcile',
  refused: 'fail',
  throttled: 'untouched',
  walled: 'untouched',
  ambiguous: 'mark-unverified',
  drift: 'untouched',
} as const satisfies Record<Verdict['kind'], VerdictEffect>;

/** A one-line description for the log. */
export function describeVerdict(v: Verdict): string {
  const parts = [`${v.op}:${v.kind}`, `effect=${v.effect}`, `via=${v.evidence.source}`];
  if (v.evidence.httpStatus !== undefined) parts.push(`http=${v.evidence.httpStatus}`);
  if ('detail' in v && v.detail !== '') parts.push(v.detail);
  return parts.join(' ');
}
