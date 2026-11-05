/**
 * The exhaustiveness witness.
 *
 * `switch (x._tag) { … default: return absurd(x) }` makes an unhandled variant a
 * COMPILE error: the default branch only typechecks while `x` has narrowed to
 * `never`. Adding a variant to any kernel union therefore fails `tsc` at every
 * site that matches on it, which is the whole reason the algebra is flat.
 *
 * `haltReasonKey` (`src/engine/halt-reason.ts:37`) documents exactly this
 * property and then uses a ternary, so its claim is false today. A `switch` plus
 * `absurd` makes it true, at zero dependency cost — this is the reason
 * `ts-pattern` is not needed (ADR 0602).
 */
export function absurd(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}
