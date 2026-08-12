export type Result<T> = { ok: true; value: T } | { ok: false; reason: string };
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const err = (reason: string): Result<never> => ({ ok: false, reason });
