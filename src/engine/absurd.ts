/**
 * The exhaustiveness witness.
 *
 * `switch (x.kind) { … default: return absurd(x) }` makes an unhandled variant a
 * COMPILE error: the default branch only typechecks while `x` has narrowed to
 * `never`. Adding a variant to any closed union therefore fails `tsc` at every
 * site that matches on it — which is why a flat `kind` algebra needs no matching
 * library (ADR 0902).
 *
 * SEAM (wave B): `src/kernel/absurd.ts` is the permanent home. The runtime wave
 * may not import the kernel yet, so this file is a byte-compatible local copy;
 * deleting it is a one-line import change at each call site.
 */
export function absurd(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}
