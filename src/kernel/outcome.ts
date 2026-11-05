/**
 * The one outcome algebra.
 *
 * Every layer answers the same four-way question in a different vocabulary
 * today: `StepResult` (11 bare strings), `HaltReason`, `ChurnActionOutcome`
 * (a struct with three optional causes, so `{status:'ok', cause:'drift'}` is a
 * legal value), `AcquireEndReason`, `EnvelopeKind`, `MutationOutcomeKind`,
 * `Result<T>`. They all encode the split this codebase discovered empirically:
 *
 *   Instagram refused us · OUR machinery broke · the attempt genuinely failed ·
 *   the user stopped us · it worked.
 *
 * Naming that split once turns three prose rules into arithmetic. The `EFFECT`
 * table below says what each tag does to a follow record, and `applyOutcome`
 * (wave B, `src/engine`) becomes the ONLY function permitted to write one — so
 * "the record is untouched when Instagram blocks" stops being a paragraph in
 * `churn-actions.ts` and becomes a lookup. See ADR 0602.
 */

import { absurd } from './absurd';
import type { Ms } from './units';

/**
 * Why the session cannot proceed. Mirrors `SentinelStatus`
 * (`src/adapter/ig-surface.ts:223`) minus its `'ok'`, which is not a refusal.
 */
export type AuthStatus = 'action-blocked' | 'challenge' | 'logged-out';

/** Instagram said no. The account is fine; the request was declined. */
export type Refusal =
  | { readonly kind: 'rate-wall'; readonly httpStatus: number; readonly detail: string }
  | { readonly kind: 'interstitial'; readonly matchedText: string }
  | { readonly kind: 'auth'; readonly status: AuthStatus };

/** Our own machinery broke. Says nothing about Instagram or the account. */
export type Breakage =
  | { readonly kind: 'tab-unresponsive'; readonly component: string; readonly timeoutMs: Ms }
  | { readonly kind: 'tab-gone' };

/** The attempt itself failed, for this account, in a way retrying may fix. */
export type Failure =
  | { readonly kind: 'drift'; readonly selector: string }
  | { readonly kind: 'unverified'; readonly expected: string };

/**
 * `A` is the success payload. Each non-Ok variant carries the evidence its
 * consumers need and NOTHING optional — the illegal combinations the optional
 * `cause?`/`alreadyInState?`/`unverifiedClick?` fields permit are gone.
 */
export type Outcome<A> =
  | { readonly _tag: 'Ok'; readonly value: A }
  /** Record UNTOUCHED. `definitive` refusals skip the blocked streak (ADR 0201 §3). */
  | { readonly _tag: 'Refused'; readonly by: Refusal; readonly definitive: boolean }
  /** Record UNTOUCHED and no recovery rung consumed — this is not Instagram's doing. */
  | { readonly _tag: 'Broken'; readonly by: Breakage; readonly clickMayHaveLanded: boolean }
  /** A genuine failed attempt for this account: burns one retry. */
  | { readonly _tag: 'Failed'; readonly by: Failure }
  /** A user stop/pause. Touch nothing; the owed gap survives (ADR 0204). */
  | { readonly _tag: 'Interrupted' };

export type OutcomeTag = Outcome<never>['_tag'];

/** What an outcome may do to the follow record it was produced for. */
export type RecordEffect = 'transition' | 'untouched' | 'burn-retry';

/**
 * The law, as a table. `satisfies` makes it TOTAL: a new `Outcome` variant does
 * not compile until it declares what it does to the record.
 */
export const EFFECT = {
  Ok: 'transition',
  Refused: 'untouched',
  Broken: 'untouched',
  Failed: 'burn-retry',
  Interrupted: 'untouched',
} as const satisfies Record<OutcomeTag, RecordEffect>;

export const ok = <A>(value: A): Outcome<A> => ({ _tag: 'Ok', value });
export const refused = (by: Refusal, definitive: boolean): Outcome<never> => ({ _tag: 'Refused', by, definitive });
export const broken = (by: Breakage, clickMayHaveLanded: boolean): Outcome<never> => ({
  _tag: 'Broken',
  by,
  clickMayHaveLanded,
});
export const failed = (by: Failure): Outcome<never> => ({ _tag: 'Failed', by });
export const interrupted = (): Outcome<never> => ({ _tag: 'Interrupted' });

export const isOk = <A>(o: Outcome<A>): o is { readonly _tag: 'Ok'; readonly value: A } => o._tag === 'Ok';

/** Transform the success payload; every other variant passes through unchanged. */
export const mapOk = <A, B>(o: Outcome<A>, f: (a: A) => B): Outcome<B> =>
  o._tag === 'Ok' ? { _tag: 'Ok', value: f(o.value) } : o;

/** What this outcome is allowed to do to the record. Total by construction. */
export const effectOf = <A>(o: Outcome<A>): RecordEffect => EFFECT[o._tag];

/**
 * A stable key for logs, spans and the halt vocabulary. `switch` + `absurd`, so
 * a new variant — or a new refusal/breakage/failure kind — is a `tsc` error
 * here rather than a silently unlabelled row.
 */
export function reasonKey<A>(o: Outcome<A>): string {
  switch (o._tag) {
    case 'Ok':
      return 'ok';
    case 'Refused':
      switch (o.by.kind) {
        case 'rate-wall':
          return 'refused:rate-wall';
        case 'interstitial':
          return 'refused:interstitial';
        case 'auth':
          return `refused:auth:${o.by.status}`;
        default:
          return absurd(o.by);
      }
    case 'Broken':
      return o.by.kind === 'tab-gone' ? 'broken:tab-gone' : `broken:tab-unresponsive:${o.by.component}`;
    case 'Failed':
      return o.by.kind === 'drift' ? `failed:drift:${o.by.selector}` : 'failed:unverified';
    case 'Interrupted':
      return 'interrupted';
    default:
      return absurd(o);
  }
}
