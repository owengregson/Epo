/**
 * Tier 1 — the plan runtime's loop bounds that are not registry keys (the golden pins the registry,
 * ADR 0605), each derived from a fundamental with one guard line (spec §5.16, §17.9).
 * Layering: `src/kernel/**` imports nothing from the rest of `src/`.
 */

import { EMPIRICAL } from './fundamentals';

export const RUNTIME_POLICY = {
  /** Two perception frames: an idle beat toward an event already due never spins a zero-delay loop. */
  IDLE_FLOOR_MS: 2 * EMPIRICAL.DISPLAY.perceptionMs,
} as const;
