/**
 * SQLite⇄domain value converters. SQLite has no boolean and no `undefined`:
 * every nullable column reads back as `T | null` and must be written as
 * `T | null`, while the domain types use `T | undefined` for "not observed".
 * These four functions are the only place that translation happens.
 */

/** `0`/`1`/`null` column → `boolean | undefined`. */
export const boolOrUndef = (v: number | null): boolean | undefined =>
  v === null ? undefined : v !== 0;

/** Nullable numeric column → `number | undefined`. */
export const numOrUndef = (v: number | null): number | undefined => (v === null ? undefined : v);

/** Nullable text column → `string | undefined`. */
export const strOrUndef = (v: string | null): string | undefined => (v === null ? undefined : v);

/** `boolean | undefined` → the `0`/`1`/`null` a column stores. */
export const boolToInt = (v: boolean | undefined): number | null =>
  v === undefined ? null : v ? 1 : 0;

/** `T | undefined` → `T | null`, the only shape a bound parameter may take. */
export const orNull = <T>(v: T | undefined): T | null => (v === undefined ? null : v);
