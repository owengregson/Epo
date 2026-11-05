/**
 * Nominal types for a structurally-typed language.
 *
 * Every id in Epo is a `string` today — `accountPk`, `targetPk`, `ownPk` and
 * `username` are mutually assignable, so an argument-order slip in the
 * reconciler compiles. A brand attaches a phantom marker that no runtime value
 * carries, which makes the four of them distinct types at zero runtime cost.
 *
 * Brands COMPOSE: the marker is a record keyed by brand name, so
 * `Pk & Brand<string, 'Own'>` is a strict subtype of `Pk` (an `OwnPk` flows
 * where a `Pk` is wanted; a bare `Pk` does not flow the other way).
 *
 * The mint functions below are the ONLY sanctioned way to produce a branded id.
 * `as Pk` / `as Username` is permitted in exactly one place — the row codecs in
 * `src/store/repos/*`, where SQLite hands back untyped rows and the brand is
 * applied once per column instead of at 64 call sites. A Biome
 * `noRestrictedSyntax` rule confines it there; everywhere else, call `pk()`.
 */

declare const brand: unique symbol;

/** `T` tagged with the nominal marker `B`. Erased at runtime. */
export type Brand<T, B extends string> = T & {
  readonly [brand]: { readonly [K in B]: true };
};

/** An Instagram account primary key: the opaque numeric-string account id. */
export type Pk = Brand<string, 'Pk'>;

/** The signed-in account's own pk. Minted once, at graph build. */
export type OwnPk = Pk & Brand<string, 'Own'>;

/** A seed/target account's pk — the account we harvest followers from. */
export type TargetPk = Pk & Brand<string, 'Target'>;

/** An Instagram handle. Invariant: lowercase, no leading `@`, no whitespace. */
export type Username = Brand<string, 'Username'>;

/** Instagram handles: letters, digits, `.` and `_`, 1–30 characters. */
const HANDLE = /^[a-z0-9._]{1,30}$/;

/** A pk we would accept: digits only, no leading zero unless it is `0`. */
const PK = /^\d{1,25}$/;

/** `s` as a `Pk`, or `null` when it is not a well-formed account id. */
export function tryPk(s: string): Pk | null {
  const t = s.trim();
  return PK.test(t) ? (t as Pk) : null;
}

/** `s` as a `Pk`. Throws when `s` is not a well-formed account id. */
export function pk(s: string): Pk {
  const v = tryPk(s);
  if (v === null) throw new TypeError(`not a pk: ${JSON.stringify(s)}`);
  return v;
}

/**
 * `s` as a `Username`, or `null` when no normalisation makes it a handle.
 * Normalises: trims, strips one leading `@`, lowercases. Refuses everything
 * else rather than inventing a handle Instagram would not resolve.
 */
export function tryUsername(s: string): Username | null {
  const t = s.trim().replace(/^@/, '').toLowerCase();
  return HANDLE.test(t) ? (t as Username) : null;
}

/** `s` as a `Username` (normalised as {@link tryUsername}). Throws on refusal. */
export function username(s: string): Username {
  const v = tryUsername(s);
  if (v === null) throw new TypeError(`not a username: ${JSON.stringify(s)}`);
  return v;
}

/** Narrow a pk to the signed-in account's. Called ONLY by the graph builder. */
export const asOwn = (p: Pk): OwnPk => p as OwnPk;

/** Narrow a pk to a seed target's. Called ONLY by the target resolver. */
export const asTarget = (p: Pk): TargetPk => p as TargetPk;
