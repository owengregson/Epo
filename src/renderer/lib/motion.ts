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

/** View-transition timings (ms) — must match the `.view` keyframes in layout.css. */
export const VIEW_EXIT_MS = 165;
export const VIEW_ENTER_MS = 340;

/** Growth-chart reveal timings (ms) — match the mockup's draw-in. */
export const GROWTH_REVEAL_DELAY_MS = 300;
export const GROWTH_REVEAL_DUR_MS = 1400;

/** easeOutCubic — the curve the chart reveal rides. */
export function easeOutCubic(x: number): number {
  return 1 - (1 - x) ** 3;
}
