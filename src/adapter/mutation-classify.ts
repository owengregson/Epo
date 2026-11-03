/**
 * The failure family of a follow/unfollow mutation response, pure over the
 * refusal signatures it is given (`ig-surface.ts` passes the active surface's).
 */

import type { MutationVerdict } from '@/adapter/mutation-types';
import { isShapeMismatch, type ShapeMismatch } from '@/adapter/parse-helpers';
import type { BlockSignature, SentinelStatus } from '@/adapter/surface-types';

// ---------------------------------------------------------------------------
// Follow / unfollow MUTATIONS — the response is the arbiter of an action.
//
// The web client flips the header button OPTIMISTICALLY when it is pressed and
// snaps it back when the server refuses; a throttled follow shows no page-level
// error at all. So the DOM alone can report a phantom success (the flip was seen)
// or an anonymous failure (the snap-back was seen). The mutation's HTTP status +
// body carry the real verdict, and the Actor arms a watch on them BEFORE the click.
// ---------------------------------------------------------------------------

/**
 * The failure family of a mutation response:
 *
 *  - `ok`            — 2xx with an ok verdict: the action landed.
 *  - `rate-limited`  — the server refused the action as throttling
 *                      (`feedback_required` / "Try Again Later" / spam flag /
 *                      HTTP 429 or 5xx): back off, the record is untouched.
 *  - `auth`          — a checkpoint / login wall: the SESSION is the problem.
 *  - `refused`       — an ordinary refusal (unknown message, 404): a real
 *                      failed attempt for THIS account.
 *  - `drift-suspect` — contradictory or unreadable: the DOM decides instead.
 */
export type MutationOutcomeKind = 'ok' | 'rate-limited' | 'auth' | 'refused' | 'drift-suspect';

export interface MutationClassification {
  kind: MutationOutcomeKind;
  /** Human-readable detail (the server's own words when it gave any). */
  detail: string;
  /** The sentinel status of the refusal signature that matched, when one did. */
  wall?: SentinelStatus;
}

/**
 * Classify a mutation response. Version-agnostic: reads the NUMBERS here and
 * matches every pattern against the given refusal signatures (the active
 * surface's). Ambiguity deliberately defaults TOWARD `rate-limited` (waiting is
 * cheap and reversible) — except a 2xx that cannot be read, which is
 * `drift-suspect` so an unreadable body is never claimed as a success.
 */
export function classifyMutationWith(
  httpStatus: number,
  verdict: MutationVerdict | ShapeMismatch,
  refusalSignatures: readonly BlockSignature[],
): MutationClassification {
  const ok2xx = httpStatus >= 200 && httpStatus < 300;
  if (isShapeMismatch(verdict)) {
    if (httpStatus === 401 || httpStatus === 403) {
      return { kind: 'auth', detail: `HTTP ${httpStatus} (unreadable body)` };
    }
    if (httpStatus === 404) return { kind: 'refused', detail: 'HTTP 404 (unreadable body)' };
    if (ok2xx) return { kind: 'drift-suspect', detail: `HTTP ${httpStatus} with an unreadable body` };
    return { kind: 'rate-limited', detail: `HTTP ${httpStatus} (unreadable body)` };
  }
  if (verdict.verdict === 'ok') {
    return ok2xx
      ? { kind: 'ok', detail: verdict.result ?? 'ok' }
      : { kind: 'drift-suspect', detail: `ok verdict on HTTP ${httpStatus}` };
  }
  const text = [verdict.message, verdict.feedbackText]
    .filter((s): s is string => s !== null && s !== '')
    .join(' — ');
  const detail = text !== '' ? text : `HTTP ${httpStatus} ${verdict.verdict}`;
  const signature = refusalSignatures.find((sig) => sig.pattern.test(text));
  if (signature !== undefined) {
    const kind =
      signature.status === 'logged-out' || signature.status === 'challenge' ? 'auth' : 'rate-limited';
    return { kind, detail, wall: signature.status };
  }
  if (verdict.spam) return { kind: 'rate-limited', detail, wall: 'action-blocked' };
  if (httpStatus === 429 || httpStatus >= 500) return { kind: 'rate-limited', detail };
  if (httpStatus === 401 || httpStatus === 403) return { kind: 'auth', detail };
  // A GraphQL errors[] answer is Instagram's evidence, never a success and never "unverified":
  // the screen and the block probe pick its class (ADR 0803 amendment, spec §10.5).
  if (verdict.verdict === 'error') return { kind: 'drift-suspect', detail };
  return { kind: 'refused', detail };
}
