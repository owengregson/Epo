/**
 * Capabilities: obligations moved from prose into signatures.
 *
 * Four of Epo's rules are enforced today by remembering them. Each becomes a
 * value that only one component may create, so a function that needs the right
 * cannot be CALLED without holding the proof:
 *
 *   ADR 0205 "one action per iteration"  → one `BudgetToken` per authorisation,
 *                                          consumed by value.
 *   ADR 0104 "a wedged loop must not free the tab" → `TabCap.generation`.
 *   PRINCIPLES §1 "verdicts wait"        → `VerifiedWalk`, required by every
 *                                          absence-based verdict.
 *   The prune guard "never unfollow someone who follows us back" →
 *                                          `UnfollowPermit`, unmintable while
 *                                          they do.
 *
 * HONEST LIMIT: TypeScript has no linear types. The TYPE enforces "you may not
 * act without authorisation"; single-use is a RUNTIME check (`once`) with a
 * property test. Do not claim otherwise in an ADR.
 */

import type { Brand, Pk } from './brand';
import type { Ms } from './units';

/** A value carrying `Fields` that only its named minter may construct. */
export type Minted<K extends string, Fields> = Fields & Brand<unknown, K>;

/** Proof this code owns the one Instagram tab. Minted ONLY by the tab lease. */
export type TabCap = Minted<'TabCap', { readonly owner: 'growth' | 'prune'; readonly generation: number }>;

/** Proof the governor authorised exactly one action. Minted ONLY by the rate governor. */
export type BudgetToken = Minted<'BudgetToken', { readonly kind: 'follow' | 'unfollow'; readonly authorisedAt: Ms }>;

/** Proof a list walk reached a VERIFIED end. Minted ONLY by the list-page walker. */
export type VerifiedWalk = Minted<'VerifiedWalk', { readonly of: 'followers' | 'following'; readonly endedAt: Ms }>;

/** Proof this account may be unfollowed. Minted ONLY by the prune candidate rule. */
export type UnfollowPermit = Minted<'UnfollowPermit', { readonly subject: Pk; readonly issuedAt: Ms }>;

/** Minted ONLY by `TabLease.claim()` (`src/main/tab-lease.ts`). */
export const tabCap = (owner: 'growth' | 'prune', generation: number): TabCap =>
  ({ owner, generation }) as unknown as TabCap;

/** Minted ONLY by the rate governor's `authorise()` (`src/governors/*`). */
export const budgetToken = (kind: 'follow' | 'unfollow', authorisedAt: Ms): BudgetToken =>
  ({ kind, authorisedAt }) as unknown as BudgetToken;

/** Minted ONLY at a walker's verified end of list — never on a truncated walk. */
export const verifiedWalk = (of: 'followers' | 'following', endedAt: Ms): VerifiedWalk =>
  ({ of, endedAt }) as unknown as VerifiedWalk;

/**
 * Minted ONLY by the prune candidate rule, and `null` while the subject follows
 * us — the live-graph guard becomes the constructor's precondition instead of a
 * check somebody has to remember to run first.
 */
export const unfollowPermit = (
  subject: Pk,
  issuedAt: Ms,
  evidence: { readonly theyFollowUs: boolean },
): UnfollowPermit | null => (evidence.theyFollowUs ? null : (({ subject, issuedAt }) as unknown as UnfollowPermit));

/** Thrown when a single-use capability is consumed a second time. */
export class AlreadyConsumedError extends Error {
  constructor(label: string) {
    super(`${label} was already consumed`);
    this.name = 'AlreadyConsumedError';
  }
}

/**
 * The runtime half of single-use. `const take = once(token, 'budget')` — the
 * first `take()` yields the value, every later one throws. Property-tested:
 * for any call count n ≥ 2, exactly one call succeeds.
 */
export function once<T>(value: T, label: string): () => T {
  let taken = false;
  return () => {
    if (taken) throw new AlreadyConsumedError(label);
    taken = true;
    return value;
  };
}
