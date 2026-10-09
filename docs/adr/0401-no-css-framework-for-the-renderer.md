# 0401 — No CSS framework for the renderer; re-cut by feature instead

Status: accepted (2026-09-02)

## Context

The renderer's stylesheets were 2,454 lines over seven files cut by *kind*
(tokens / base / layout / primitives / cards / graph / tour), not by feature.
Finding a component's CSS meant grepping three files: `.prune-page` lived in
`graph.css` while the prune cards' `.pcomp-*` lived in `cards.css`, and card
scaffolding was split between `primitives.css` and `cards.css`. The shell had a
comment documenting where prune styles hide.

The reflex fix — Tailwind or CSS Modules — was measured against what is actually
there: 547 selectors, exactly one orphan class, 636 `var(--token)` references,
and a genuine fluid type scale built on `clamp()`/`cqi`.

## Decision

Keep plain CSS with custom properties. Re-cut the files by feature:
`tokens` → `base` → `shell` → `controls`, then one file per feature
(`graph`, `overview`, `chain`, `queues`, `prune`, `settings`, `tour`).
`styles/index.css`'s import order IS the cascade order and is preserved.

Tailwind was rejected: the fluid scale can only be expressed as arbitrary
values, it adds a build step, and it deletes zero lines — the classes move from
one file to another. CSS Modules was rejected for a harder reason: the console's
state cascade is `.console[data-state="running"] .thing`, which under esbuild's
`local-css` needs `:global()` on every ancestor, and all 191 class references
would be rewritten for no reduction in rule count.

The real defect was tooling, not language: `biome.json` never looked at CSS
(`files.includes` is TS-only, `formatter.enabled: false`), which is why
`display:flex` and `display: flex` coexisted in the same files. That is fixed by
pointing Biome at `src/**/*.css` (owned by the tooling pass), not by adopting a
framework.

## Consequences

- One feature's CSS is in one file; a component deletion can be completed
  confidently.
- The re-cut is a pure move: comparing the built `dist/renderer/index.css`
  selector/declaration pairs before and after shows no rule lost or added apart
  from the deliberately deleted `@keyframes cardIn` (see 0402).
- Until Biome's CSS formatter is enabled, the older files stay compact
  (`prop:value`) and the newer ones spaced. Only `display:` was normalized in
  this pass; a formatter run will settle the rest in one commit.
- `styles/index.css` must stay ordered — moving an `@import` line moves a rule's
  cascade position. The header says so.
