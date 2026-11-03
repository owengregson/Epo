/**
 * What the click review decided for one action (spec §9.7): `proceed` lets the
 * dispatch run; every other verdict consumes the work and is thrown as an
 * `ActionReviewedError` for the scheduler to settle. Pure; the adapter, rim
 * and engine share it.
 */

/** Which protection rule kept an account (the protection predicate's vocabulary, spec §7.3). */
export type ProtectedBy = 'account' | 'verified' | 'bio-word' | 'source';

export type ClickVerdict =
  | { readonly kind: 'proceed' }
  | { readonly kind: 'reheld' }
  | { readonly kind: 'not-due' }
  | { readonly kind: 'request-pending' }
  | { readonly kind: 'already-gone' }
  | { readonly kind: 'unavailable'; readonly evidence: 'absent' | 'renamed' | 'unreadable' }
  | { readonly kind: 'protected'; readonly by: ProtectedBy; readonly match: string }
  | { readonly kind: 'protection-unknown'; readonly missing: 'bio' | 'verified' }
  | { readonly kind: 'protection-paused'; readonly state: 'needs-review' | 'unavailable' }
  | { readonly kind: 'deferred'; readonly reason: string; readonly until: number | null };

/** Every verdict kind, in the review's precedence order. */
export const CLICK_VERDICT_KINDS = [
  'proceed', 'reheld', 'not-due', 'request-pending', 'already-gone', 'unavailable',
  'protected', 'protection-unknown', 'protection-paused', 'deferred',
] as const satisfies readonly ClickVerdict['kind'][];
