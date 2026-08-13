/**
 * Derived-settings math. The Daily-activity rate is the single master for per-day
 * volume; the hard ceiling and daily plan derive from it (mockup rule), so the UI
 * never lets those drift independently.
 */

/** Hard ceiling = round(rate × 1.3), capped at 150. */
export function ceilFor(rate: number): number {
  return Math.min(150, Math.round(rate * 1.3));
}

/** Daily plan = round(rate × 1.1), capped at 120. */
export function planFor(rate: number): number {
  return Math.min(120, Math.round(rate * 1.1));
}

/** Audience-yield slider (0..100) → multiplier (×0.50..×1.50; 50 = ×1.00). */
export function yieldMultFromSlider(sliderValue: number): number {
  return 0.5 + sliderValue / 100;
}

/** Inverse of {@link yieldMultFromSlider}. */
export function sliderFromYieldMult(mult: number): number {
  return Math.round((mult - 0.5) * 100);
}
