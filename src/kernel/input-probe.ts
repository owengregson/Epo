/**
 * Tier 2 — the tab's input probe (D4; ADR 1007 amendment): after a synthetic
 * pointer move, how often and how many times the probe looks for the page's
 * listener to fire. Derived from the display frame; not registry keys.
 *
 * Layering: `src/kernel/**` imports nothing from the rest of `src/`.
 */

import { EMPIRICAL } from './fundamentals';

/** Probe intervals snap to this grid, finer than a probe can resolve. */
const PROBE_GRID_MS = 50;

export const INPUT_PROBE = {
  /** Polls before the probe reports input lost: ten span half a second, past any live acknowledgement. */
  ROUNDS: 10,
  /** Three display frames between polls (on the 50 ms grid): the page has painted before each look. */
  INTERVAL_MS: Math.round((3 * EMPIRICAL.DISPLAY.frameMs) / PROBE_GRID_MS) * PROBE_GRID_MS,
} as const;
