/**
 * What the click review decided for one action (spec §9.7): `proceed` lets the dispatch run; every
 * other verdict consumes the work, thrown as an `ActionReviewedError` for the scheduler to settle.
 * Pure; the adapter, rim and engine share it.
 */
import type { ProtectedBy, ProtectionVerdict } from './unfollow-protection';

/** Which protection rule kept an account: the protection predicate's own vocabulary (spec §7.3). */
export type { ProtectedBy } from './unfollow-protection';

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

/** The click verdict a protection verdict consumes the work with (step 5); null when `clear` lets it go on. */
export function protectionClickVerdict(v: ProtectionVerdict): ClickVerdict | null {
  switch (v.kind) {
    case 'clear':
      return null;
    case 'protected':
      return { kind: 'protected', by: v.by, match: v.match };
    case 'unknown':
      return { kind: 'protection-unknown', missing: v.missing };
    case 'paused':
      return { kind: 'protection-paused', state: v.state };
  }
}
