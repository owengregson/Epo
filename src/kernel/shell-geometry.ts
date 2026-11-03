/**
 * Tier 1 — the window's fixed geometry (spec §12.6, §17.9, Appendix C.2): the
 * column width and the top band, which place the Instagram tab, and the debounce
 * of the saved window bounds. `shell.css` is pinned to these by a renderer test.
 * Layering: `src/kernel/**` imports nothing from the rest of `src/`.
 */

export const SHELL_GEOMETRY = {
  /** Sidebar width = the IG tab's x. Guards: IG breakpoints narrower than today's tab are unmeasured. */
  SIDEBAR_WIDTH_PX: 460,
  /** Top band (stage bar + masthead) = the IG tab's y. Guards: the tab must start under the bar's hairline. */
  STAGE_BAR_HEIGHT_PX: 44,
  /** Saved-bounds debounce. Guards: one disk write per resize or move gesture, not one per frame. */
  BOUNDS_PERSIST_MS: 500,
} as const;
