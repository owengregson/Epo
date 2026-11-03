/**
 * Tier 1 — Actor guardrails that are not registry keys (the golden pins the registry, ADR 0605),
 * one guard line each (spec §17.8). Layering: `src/kernel/**` imports nothing from the rest of `src/`.
 */

export const ADAPTER_BOUNDS = {
  /** One re-navigate clears a stale rect or a leftover modal; a third attempt only repeats the same page. */
  OPEN_LIST_ATTEMPTS: 2,
} as const;
