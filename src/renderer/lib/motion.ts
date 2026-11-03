/**
 * Motion primitives — durations, easing, and the reduced-motion gate.
 * Kept in one place so every animated component and hook agrees on timing
 * and uniformly collapses under `prefers-reduced-motion`.
 */

/** True when the user asked the OS to minimize animation. Read at call time. */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** The presentation timings, one rule over perception (design/motion-scale.ts). */
export {
  BOOT_UI,
  BREATH_MS,
  CHART_DEFAULT_DAYS,
  DUR,
  PERCEPTION_MS,
  STAGGER_MS,
} from '@/renderer/design/motion-scale';

/** Canonical easing curve (matches the CSS `--ease` token). */
export const EASE = 'cubic-bezier(0.22, 0.9, 0.28, 1)';

/** Arrivals and settles (matches `--ease-out`). */
export const EASE_OUT = 'cubic-bezier(0.16, 1, 0.3, 1)';

/** Loops and slides (matches `--ease-in-out`). */
export const EASE_IN_OUT = 'cubic-bezier(0.65, 0, 0.35, 1)';

/**
 * How long the `.entering` / `.exiting` classes are held after a view swap.
 * Mirrors the `viewIn` animation in shell.css (0.34s) plus a settle margin;
 * the CARD entrance is no longer part of this contract — it is played by
 * lib/stagger.ts through the Web Animations API.
 */
export const VIEW_SWAP_MS = 400;

/** Growth-chart reveal timings (ms) — match the mockup's draw-in. */
export const GROWTH_REVEAL_DELAY_MS = 300;
export const GROWTH_REVEAL_DUR_MS = 1400;

/**
 * Per-frame delta cap (ms) for the reveal's elapsed-time accumulator — about
 * two frames at 60Hz. Wall-clock rAF deltas materialize a main-thread stall
 * (whole-App re-renders, the view-enter teardown) as one giant jump — or end
 * the tween inside the stall entirely. Capping each frame's contribution makes
 * dropped frames SLOW the draw instead of skipping it.
 */
export const GROWTH_REVEAL_MAX_FRAME_MS = 34;

/** Opacity fade (ms) for the line/dot/area when the reveal's hold ends. */
export const GROWTH_REVEAL_FADE_MS = 200;

/**
 * Advance a reveal accumulator by one rAF frame, capping the contribution at
 * {@link GROWTH_REVEAL_MAX_FRAME_MS}. The first frame (no previous timestamp)
 * and clock anomalies (non-increasing timestamps) contribute nothing.
 */
export function accumulateFrame(elapsed: number, lastTs: number | null, ts: number): number {
  if (lastTs === null) return elapsed;
  return elapsed + Math.max(0, Math.min(ts - lastTs, GROWTH_REVEAL_MAX_FRAME_MS));
}

/**
 * easeInOutCubic — the curve the chart reveal rides. Gentle entry (derivative
 * 0 at x=0, so the first post-hold frame never jumps at 3× average speed the
 * way easeOutCubic did), fast middle, settled tail.
 */
export function easeInOutCubic(x: number): number {
  return x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2;
}
