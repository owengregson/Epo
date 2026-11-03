/**
 * Probation from the ledger and the plan-day windows (ADR 0213, spec §9.11, C21): a session re-enters
 * gently when the account's last mutation is at least one plan-day length before its start, or when
 * a complete plan-day lies strictly between the two. Pure, no state, DST-safe.
 * Layering: `src/kernel/**` imports nothing from the rest of `src/`.
 */

import { MS_PER_DAY } from '../units';

/** True when the session starting at `sessionStartAt` owes probation after the last mutation. */
export function probationOwed(lastMutationAt: number | null, sessionStartAt: number,
  windowOf: (t: number) => { readonly startsAt: number; readonly endsAt: number }): boolean {
  if (lastMutationAt === null || lastMutationAt > sessionStartAt) return false;
  if (sessionStartAt - lastMutationAt >= MS_PER_DAY) return true;
  const following = windowOf(windowOf(lastMutationAt).endsAt);
  return following.endsAt <= sessionStartAt;
}
