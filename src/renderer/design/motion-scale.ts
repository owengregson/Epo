/**
 * The renderer's presentation timings (ADR 0405; spec §3 deviation 1, §12.7):
 * every animation duration, the splash dwell and its caption delays, as a rule
 * over one perception unit. The renderer may not import the kernel, so this
 * module holds its own copy of that unit; `tests/renderer/motion-scale.test.ts`
 * pins it to `EMPIRICAL.DISPLAY.perceptionMs` and the CSS tokens to `DUR`.
 * None of these touches Instagram. No imports (like `scale.ts`).
 */

/** One perception unit, in ms: the shortest change a person reads as "it moved". */
export const PERCEPTION_MS = 100;

/** The duration ladder's multipliers of 1.2 perception units: `--dur-1 … --dur-5`. */
export const DUR_STEPS = [1, 5 / 3, 8 / 3, 4, 7.5] as const;

/** `--dur-1` 120 · `--dur-2` 200 · `--dur-3` 320 · `--dur-4` 480 · `--dur-5` 900 ms. */
export const DUR = {
  1: Math.round(PERCEPTION_MS * 1.2 * DUR_STEPS[0]),
  2: Math.round(PERCEPTION_MS * 1.2 * DUR_STEPS[1]),
  3: Math.round(PERCEPTION_MS * 1.2 * DUR_STEPS[2]),
  4: Math.round(PERCEPTION_MS * 1.2 * DUR_STEPS[3]),
  5: Math.round(PERCEPTION_MS * 1.2 * DUR_STEPS[4]),
} as const;

/** One breath of the two loops (the mark's ring, the Live dot): 26 perception units. */
export const BREATH_MS = 26 * PERCEPTION_MS;

/** Sections, rows and zones arrive this far apart (the intro's 60 ms stagger). */
export const STAGGER_MS = 0.6 * PERCEPTION_MS;

/** The splash: its shortest dwell, when a caption first appears, when it admits a slow start. */
export const BOOT_UI = {
  MIN_SPLASH_MS: 6 * PERCEPTION_MS,
  CAPTION_DELAY_MS: 12 * PERCEPTION_MS,
  SLOW_COPY_MS: 25 * PERCEPTION_MS,
} as const;

/** The growth chart's default range, in calendar days (a display bound, not a timing). */
export const CHART_DEFAULT_DAYS = 14;
