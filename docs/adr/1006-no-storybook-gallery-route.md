# 1006 — A `?gallery=1` route instead of Storybook

Status: accepted (2026-09-02)

## Context

The renderer has ~25 cards whose interesting states — parked, halted, offline,
at the ceiling, logged out, prune-scanning, prune-running — are reachable in the
real app only by driving a real Instagram session into them. Reviewing a
typography or spacing change meant running the engine and waiting.

Storybook is the reflex answer and was rejected on measured grounds. It is a
second build pipeline (its own bundler, its own config, ~40 MB of dev
dependencies) for an app whose entire renderer builds in well under a second;
its preview iframe does not carry `index.html`'s `default-src 'none'` CSP, so
components would be reviewed under different security and font-loading rules
than they ship under; and its story format would re-declare, per card, props
that the components no longer take — after ADR 1004 the cards read the shell's
signals, so a "story" is a projection, not a wrapper.

## Decision

A dev-only route in the app's own bundle: `?gallery=1` mounts `Gallery` instead
of `App`.

- **A story is a set of projections.** `SCENARIOS` in
  `renderer/gallery/fixtures.ts` are `{ status, prune }` pairs; picking one
  writes `statusSignal` / `pruneSignal`. Everything downstream — cards, the
  `[data-state]` cascade, the transport posture — follows for free, because that
  is exactly how the running app works.
- **It renders the real views inside the real `.console` markup**, so container
  queries, the generated tokens (ADR 1005), the entrance stagger and the
  cascade behave as they do in the app. A card in a white box would test none of
  those.
- **A proxy bridge stands in for `window.epo`.** The views still pull
  (`chain:detail`, `queue:list`, `growth:series`) as their §2 backstop, and a
  rejected pull would show loading states instead of the design. Unknown methods
  resolve to `undefined` rather than throwing, so adding an IPC channel can
  never break the gallery.
- **The fixtures live in `src/renderer/gallery/`, not `tests/`.** `src/**` must
  not import `tests/**` (the layering gate), and the settings fixture cannot
  come from `@/settings/settings` at all: that module reads `node:fs` at import
  time and dragging it into the renderer fails the build outright. It is written
  out as a typed literal instead — so adding a settings knob breaks the fixture
  at compile time, which is the reminder to give the new knob a gallery value.

## Consequences

- Zero new dependencies, one build, the same CSP, the same tokens, the same
  cascade. Cost: ~13 KB in the shipped renderer bundle (esbuild inlines the
  dynamic import because the renderer is not split) plus ~45 lines of CSS for
  the picker rail. The route is unreachable without the query flag.
- The gallery exercises the signals plumbing as a side effect: if a card stops
  reading its signal, the scenario picker visibly stops moving it.
- It is a review surface, not a test. It asserts nothing; `tests/renderer/`
  still owns the assertions, and `view-liveness.test.tsx` covers the same
  push-moves-the-number property automatically.
- If per-component isolation is ever genuinely needed (one card, one prop, no
  view around it), the same file can grow a card grid without adopting a
  framework — the fixtures are already plain data.
