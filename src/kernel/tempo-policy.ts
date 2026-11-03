/**
 * Tier 1 — the tempo dials and bounds the plan-derived timing needs (ADR 0607).
 * Each entry carries one guard line: what it keeps from going wrong. The tempo
 * registry (`./tempo/specs.ts`) and `deriveMotion` read these; nothing else
 * scales a wait.
 *
 * Layering: `src/kernel/**` imports nothing from the rest of `src/`.
 */

import { MS_PER_MINUTE } from './units';

export const TEMPO_POLICY = {
  /** motion = pace^this: cursor work stretches less than reading waits do. */
  MOTION_ELASTICITY: 0.5,
  /** Speed–accuracy keys scale by motion^−this: a brisker gesture scatters slightly more. */
  SPEED_ACCURACY_ELASTICITY: 0.5,
} as const;

export const PLAN_POLICY = {
  /** Retries cover an ordinary failure streak with this confidence (three at today's fail rate). */
  RETRY_CONFIDENCE: 0.99,
} as const;

export const TEMPO_BOUNDS = {
  /** A stored instant later than now + this reads as clock drift, never as the future. */
  CLOCK_TOLERANCE_MS: 5 * MS_PER_MINUTE,
  /** The shortest list-scroll wheel step: a smaller nudge can fail to load the next page. */
  MIN_SCROLL_STEP_PX: 600,
} as const;

export const { CLOCK_TOLERANCE_MS, MIN_SCROLL_STEP_PX } = TEMPO_BOUNDS;
