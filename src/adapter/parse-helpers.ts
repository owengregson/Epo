/**
 * Version-agnostic parse helpers.
 *
 * Small, Instagram-free utilities shared by the Reader and the versioned
 * surface modules (`src/adapter/versions/*`). Nothing in this file may ever
 * carry an Instagram fact (URL, selector, JSON path, app id) — those live
 * exclusively in the version modules.
 */

/** Narrow an unknown to a plain (non-array) object record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Sentinel returned by mutation extraction when a body is PRESENT but does not
 * match the expected shape — so callers can distinguish "genuinely absent /
 * no relationship" from "unparsed / shape drift". Defined here (not in
 * `ig-surface.ts`) so the version modules can import it at runtime without a
 * module cycle; `ig-surface.ts` re-exports it as part of the stable interface.
 */
export const SHAPE_MISMATCH: unique symbol = Symbol('shape-mismatch');

export type ShapeMismatch = typeof SHAPE_MISMATCH;

/** Type guard for {@link SHAPE_MISMATCH}. */
export function isShapeMismatch(value: unknown): value is ShapeMismatch {
  return value === SHAPE_MISMATCH;
}
