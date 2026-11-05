/**
 * A typed error channel — the replacement for `src/utils/result.ts`, whose
 * `{ ok: false; reason: string }` forces every consumer to re-parse prose
 * (`churn-actions.ts` recovers the real classification with `instanceof` checks
 * on six error classes).
 *
 * `Res` is the small, local answer: a computation that fails in a way the CALLER
 * enumerates. When the failure is an Instagram outcome — refused, broken,
 * genuinely failed, interrupted — use `Outcome` (`./outcome`) instead; that
 * union is the shared vocabulary and this one is a two-case utility.
 */

export type Res<A, E> = { readonly ok: true; readonly value: A } | { readonly ok: false; readonly error: E };

export const ok = <A>(value: A): Res<A, never> => ({ ok: true, value });
export const err = <E>(error: E): Res<never, E> => ({ ok: false, error });

/** Transform the success value; an error passes through untouched. */
export const map = <A, B, E>(r: Res<A, E>, f: (a: A) => B): Res<B, E> =>
  r.ok ? { ok: true, value: f(r.value) } : r;

/** Sequence a second fallible step. The error channels union. */
export const flatMap = <A, B, E, F>(r: Res<A, E>, f: (a: A) => Res<B, F>): Res<B, E | F> =>
  r.ok ? f(r.value) : r;

/** The value, or `fallback` when the computation failed. */
export const unwrapOr = <A, E>(r: Res<A, E>, fallback: A): A => (r.ok ? r.value : fallback);

/** All values, or the FIRST error — the shape a batch of parses wants. */
export function all<A, E>(rs: readonly Res<A, E>[]): Res<A[], E> {
  const values: A[] = [];
  for (const r of rs) {
    if (!r.ok) return r;
    values.push(r.value);
  }
  return { ok: true, value: values };
}
