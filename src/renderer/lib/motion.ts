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

/** Canonical easing curve (matches the CSS `--ease` token). */
export const EASE = 'cubic-bezier(0.22, 0.9, 0.28, 1)';

/**
 * Card entrance stagger — the single source for the `.view.entering .card`
 * animation in primitives.css. The App root publishes these as CSS custom
 * properties (--card-in-dur / --card-stagger-step / --card-stagger-base /
 * --card-stagger-cap), so the CSS delay math and the entering hold below can
 * never drift apart. CAP bounds the delay so a long page's tail still finishes
 * inside the hold.
 */
export const CARD_STAGGER = {
  /** Per-card delay step (ms). */
  STEP_MS: 65,
  /** Base delay before the first card (ms). */
  BASE_MS: 60,
  /** The cardIn animation's duration (ms). */
  DUR_MS: 450,
  /** Stagger index cap (indices beyond this share the last slot). */
  CAP: 8,
} as const;

/**
 * How long the `.entering` class is held after a view swap — derived from the
 * stagger table so the LAST staggered card (start CAP·STEP + BASE, plus DUR)
 * fully completes before the class is cleared, with a small settle margin.
 */
export const VIEW_ENTER_HOLD_MS =
  CARD_STAGGER.CAP * CARD_STAGGER.STEP_MS + CARD_STAGGER.BASE_MS + CARD_STAGGER.DUR_MS + 70;

/** Growth-chart reveal timings (ms) — match the mockup's draw-in. */
export const GROWTH_REVEAL_DELAY_MS = 300;
export const GROWTH_REVEAL_DUR_MS = 1400;

/** easeOutCubic — the curve the chart reveal rides. */
export function easeOutCubic(x: number): number {
  return 1 - (1 - x) ** 3;
}
