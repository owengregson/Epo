/**
 * ARBITER — the single place a follow/unfollow click's outcome is decided.
 *
 * The arbitration ORDER is unchanged and still right (ADR 0304): the mutation
 * response first, the DOM as fallback, a block probe when the DOM disagrees,
 * drift only when nothing explains what was seen. What changes is that it
 * happens ONCE, here, instead of being duplicated across `followDriven` and
 * `unfollowDriven` — two copies of a decision that must never diverge.
 *
 * The output is a {@link Verdict}, which carries its own record effect. The
 * Actor maps it to today's `Result` / error classes at the edge so
 * `churn-actions.ts`'s `ChurnActionOutcome` contract is untouched this wave.
 */

import type { MutationKind, SentinelStatus } from '@/adapter/ig-surface';
import type { MutationObservation } from '@/adapter/mutation-watch';
import type { Evidence, Verdict } from '@/adapter/verdict';

export interface ArbiterInput {
  op: MutationKind;
  /** A label for the logs, e.g. `actor.follow`. */
  label: string;
  /** The classified mutation response, or `null` when none arrived in the window. */
  observed: MutationObservation | null;
  /** False when the tab has no response seam at all — the DOM-only path. */
  watchAvailable: boolean;
  /** Press → response, in ms; `null` when nothing arrived. */
  latencyMs: number | null;
  /** The button state read BEFORE the press, for the evidence trail. */
  stateBefore?: string;
  /** Poll the action button until it reaches the expected post-state. */
  verifyPostState: () => Promise<boolean>;
  /**
   * Read what is ACTUALLY on screen when the DOM did not confirm: the matched
   * block signature, or `null` when nothing block-shaped is showing.
   */
  probeBlock: () => Promise<string | null>;
  now: () => number;
}

/**
 * Decide one dispatched click. Never throws for a NORMAL outcome — every wall,
 * refusal and drift is a returned value; only a genuinely exceptional condition
 * (an aborted wait, a destroyed tab) still escapes as an exception, from the
 * callbacks themselves.
 */
export async function arbitrate(input: ArbiterInput): Promise<Verdict> {
  const base = (source: Evidence['source']): Evidence => ({
    source,
    observedAtMs: input.now(),
    controlStateBefore: input.stateBefore,
    httpStatus: input.observed?.httpStatus,
    serverMessage: input.observed?.classification.detail,
    subjectPk: input.observed?.pk ?? null,
    latencyMs: input.latencyMs ?? undefined,
  });

  if (input.observed !== null) {
    const outcome = input.observed.classification;
    switch (outcome.kind) {
      case 'ok': {
        // The response is authoritative; the DOM is read once more only as a
        // log echo, so a slow re-render can never turn a confirmed follow into
        // a failure.
        const settled = await input.verifyPostState();
        return {
          kind: 'landed',
          effect: 'commit',
          op: input.op,
          evidence: { ...base(settled ? 'both' : 'response'), controlStateAfter: settled ? 'settled' : 'unsettled' },
        };
      }
      case 'rate-limited':
        // DEFINITIVE: Instagram's server said no. The ladder enters on the
        // FIRST one rather than proving a streak, because every further attempt
        // deepens the block — and the record is left exactly as it was.
        return {
          kind: 'throttled',
          effect: 'untouched',
          op: input.op,
          evidence: base('response'),
          wall: outcome.wall ?? 'action-blocked',
          detail: outcome.detail,
        };
      case 'auth':
        return {
          kind: 'walled',
          effect: 'untouched',
          op: input.op,
          evidence: base('response'),
          wall: outcome.wall ?? 'challenge',
          detail: outcome.detail,
        };
      case 'refused':
        return {
          kind: 'refused',
          effect: 'fail',
          op: input.op,
          evidence: base('response'),
          detail: outcome.detail,
        };
      case 'drift-suspect':
        // Contradictory or unreadable: fall through to the DOM, exactly as
        // before. An unreadable 2xx is never claimed as a success.
        break;
    }
  }

  const verified = await input.verifyPostState();
  if (verified) {
    return {
      kind: 'landed',
      effect: 'commit',
      op: input.op,
      evidence: { ...base(input.observed === null ? 'dom' : 'both'), controlStateAfter: 'settled' },
    };
  }

  const blocked = await input.probeBlock();
  if (blocked !== null) {
    // A block interstitial in place of the expected control is Instagram
    // throttling the ACTION, not selector drift: the record stays untouched or
    // every throttled unfollow burns a candidate (observed live 2026-08-15).
    return {
      kind: 'walled',
      effect: 'untouched',
      op: input.op,
      evidence: base(input.observed === null ? 'dom' : 'both'),
      wall: 'action-blocked',
      detail: blocked,
    };
  }

  return {
    kind: 'refused',
    effect: 'fail',
    op: input.op,
    evidence: base(input.observed === null ? 'dom' : 'both'),
    detail: 'post-click state not confirmed',
  };
}

/** The wall a verdict names, when it names one. */
export const wallOf = (verdict: Verdict): SentinelStatus | null =>
  verdict.kind === 'throttled' || verdict.kind === 'walled' ? verdict.wall : null;
