/**
 * The Epo kernel — the vocabulary every other layer is a projection of.
 *
 * RULE: `src/kernel/**` imports NOTHING from `src`. The single external
 * dependency is `zod`, and only inside `parse.ts`. That is what lets the kernel
 * land as an unconsumed leaf, prove itself with its own property suites, and be
 * adopted layer by layer without a big-bang merge (ADR 0601).
 *
 * ADOPTION ORDER (each step is independently revertible; the one after it
 * assumes the one before has landed):
 *
 *   1. `fundamentals`/`derive` consume `units` + `schedule`; `timing/config.ts`
 *      becomes a shim, gated by exact-equality against today's 119 constants.
 *   2. The adapter parse boundary: `asFetchEnvelope`'s cast and every `extract*`
 *      guard return `Parsed<T>`. Highest bug-value, DOM-free, already tested.
 *   3. The outcome algebra: `ChurnActionOutcome` → `Outcome`, `applyOutcome`
 *      becomes the sole record writer, `haltReasonKey` gets `switch` + `absurd`,
 *      `src/utils/result.ts` is deleted.
 *   4. Brands at the store boundary: `Pk`/`Username` in the row codecs (the only
 *      place `as Pk` is permitted), then outward.
 *   5. Capabilities: `TabCap`/`BudgetToken`/`VerifiedWalk` in the actor, walker
 *      and churn signatures.
 *   6. `Scope` in the conductor, replacing generation tokens, `superseded()`,
 *      `owedResume`, `parkedNow` and `awaitParked`.
 *   7. `FollowRecord` as a discriminated union — last, because it touches store
 *      projections and the renderer's queue lists.
 *
 * Trip-wire (from the source design): if step 7 needs more than ~200 changed
 * lines outside the store, stop at the outcome algebra. Ceremony that costs more
 * edits than it catches bugs is a defect.
 */

export { absurd } from './absurd';
export type { Brand, OwnPk, Pk, TargetPk, Username } from './brand';
export { asOwn, asTarget, pk, tryPk, tryUsername, username } from './brand';
export type { BudgetToken, Minted, TabCap, UnfollowPermit, VerifiedWalk } from './capabilities';
export {
  AlreadyConsumedError,
  budgetToken,
  once,
  tabCap,
  unfollowPermit,
  verifiedWalk,
} from './capabilities';
export * from './derive';
export { retryLimit } from './derive-lifecycle';
// Landed by other wave-A agents; re-exported so the kernel has one door.
export * from './fundamentals';
export * from './module';
export type { AuthStatus, Breakage, Failure, Outcome, OutcomeTag, RecordEffect, Refusal } from './outcome';
export {
  broken,
  EFFECT,
  effectOf,
  failed,
  interrupted,
  isOk,
  mapOk,
  ok,
  reasonKey,
  refused,
} from './outcome';
export * from './overrides';
export type { Drift, Parsed } from './parse';
export { isDrift, parseWith } from './parse';
export * as plan from './plan';
export * from './policy';
export type { Res } from './result';
export {
  all as resAll,
  err as resErr,
  flatMap as resFlatMap,
  map as resMap,
  ok as resOk,
  unwrapOr as resUnwrapOr,
} from './result';
export type { Rng, Schedule } from './schedule';
export {
  attempts,
  describe as describeSchedule,
  draw,
  exponential,
  formatMs,
  jittered,
  logNormal,
  normal01,
  once as scheduleOnce,
  recurs,
  truncate,
} from './schedule';
export type { Resource, Scope } from './scope';
export { rootScope, ScopeClosedError } from './scope';
export * from './session';
export type { Fraction, Ms, PerDay, PerHour } from './units';
export {
  ceilTo,
  clampMs,
  days,
  divMs,
  fraction,
  hours,
  MS_PER_DAY,
  MS_PER_HOUR,
  MS_PER_MINUTE,
  MS_PER_SECOND,
  minutes,
  ms,
  mulMs,
  perDay,
  perHour,
  seconds,
} from './units';
