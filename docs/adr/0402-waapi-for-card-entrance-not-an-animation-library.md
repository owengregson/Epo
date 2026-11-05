# 0402 — The Web Animations API owns the card entrance; no animation library

Status: accepted (2026-09-02)

## Context

The renderer's motion was not expensive — 13 `@keyframes`, 18 `animation:`
declarations, 48 `transition:` declarations, about 60 lines nothing beats. The
expensive part was one effect: the card-entrance stagger was a **four-file
timing contract**.

- `lib/motion.ts` declared `CARD_STAGGER` (step / base / duration / cap).
- `App.tsx` serialized that table into four CSS custom properties on the shell
  root as a style string.
- `primitives.css` did the delay arithmetic in
  `calc(min(var(--i), var(--card-stagger-cap)) * var(--card-stagger-step) + …)`.
- `useView.ts` held an `.entering` class for `VIEW_ENTER_HOLD_MS`, a constant
  *derived* from the same table so a `setTimeout` would outlive a CSS animation.

Feeding `--i` required an `index` prop drilled through **16 Props interfaces and
39 call sites** — every card's public API carried an animation ordinal, and
`OverviewView` had to offset every index by one when the sign-in gate led.

## Decision

Animate from one place with the Web Animations API — native in the Chromium the
app ships, zero dependencies, CSP-safe. `lib/stagger.ts` (~40 lines) takes the
newly-activated host element, walks its `.card` descendants in document order,
and plays one keyframe pair with a capped delay ramp. `ViewStage` calls it when
the active view changes; `App` calls it when the stage switches to Prune.

Deleted: `CARD_STAGGER`, `VIEW_ENTER_HOLD_MS`, the four CSS custom properties,
`@keyframes cardIn`, its `.view.entering .card` rule, and `index` from 16
interfaces and 39 call sites. `useView` keeps `entering`/`exiting` (they drive
the view crossfade, which is still CSS) but its timer now reads one
`VIEW_SWAP_MS` that mirrors a single `viewIn` duration rather than being derived
from the card table.

`motion@^12` and `@formkit/auto-animate` were both rejected. `motion` would be
the drop-in upgrade if springs or layout animation are ever wanted, but nothing
here needs them. `auto-animate` only helps list add/remove, which is three
places already covered by two keyframes — a dependency to delete eight lines.

## Consequences

- Card order is DOM order. The sign-in gate's index offset disappears because
  the gate simply renders first.
- `prefersReducedMotion()` is checked once, in `staggerCards`, at play time —
  so an OS-level toggle takes effect on the next view switch without a remount.
- `Element.animate` is absent in jsdom; `staggerCards` returns early there, so
  render tests see cards at their end state rather than a mid-animation opacity.
- Re-running cancels the previous pass, so rapid tab presses always animate the
  latest activation instead of stacking delays.

## Amendment — 2026-11-03: stage motion and live preferences (ADR 0405)

The larger stage pages use the shared semantic motion scale and `staggerSections`; deadline rings,
number changes, feed arrivals and the launch sequence use the same gesture vocabulary. Reduced motion
is a live preference, including the native stage transition, which cuts without its curtain. Infinite
animation is limited to the mark ring and Live dot; loading placeholders do not add another loop.
