/**
 * Tier 1 — main-side boot guardrails (spec §12.8, Appendix C.2): the launch deadlines, the stage curtain and
 * the veil's own fade, derived from the display and latency fundamentals wherever a formula exists.
 * Layering: `src/kernel/**` imports nothing from the rest of `src/`.
 */

import { EMPIRICAL } from './fundamentals';

const P = EMPIRICAL.DISPLAY.perceptionMs;
const F = EMPIRICAL.DISPLAY.frameMs;

export const BOOT = {
  /** Guards: an invisible app when the dashboard never finishes loading (the window shows anyway). */
  SHOW_FALLBACK_MS: 1_500,
  /** Guards: a slow disk or a long migration trapping the user behind the splash (skeletons reveal instead). */
  DATA_DEADLINE_MS: 4_000,
  /** Guards: a slow page holding the splash; p95 home hydration plus two median navigations, derived. */
  IG_READY_DEADLINE_MS: EMPIRICAL.LATENCY.hydration.p95 + 2 * EMPIRICAL.LATENCY.nav.p50,
  /** Guards: crash resume depending on the renderer (ADR 0210); main proceeds when no reveal is reported. */
  SETTLE_DEADLINE_MS: 8_000,
  /** Guards: an unpainted curtain; past six frames the stage cuts plainly, derived. */
  CURTAIN_PAINT_MAX_MS: Math.ceil(6 * F),
  /** Guards: a jarring cut into Live; the curtain fades over three perception units, derived. */
  CURTAIN_FADE_MS: 3 * P,
  /** Guards: the now line blinking between steps; an activity null is held two perception units, derived. */
  ACTIVITY_NULL_HOLD_MS: 2 * P,
  /** Guards: a veil that hides before its fade ends; four perception units, as veil.html animates, derived. */
  VEIL_FADE_MS: 4 * P,
  /** Guards: one page push per cursor move; moves coalesce to one display frame in whole ms, derived. */
  VEIL_CURSOR_FLUSH_MS: Math.floor(F),
} as const;
