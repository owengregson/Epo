# 1005 — The spacing ramp, type ladder and control sizes are generated from a scale

Status: accepted (2026-09-02)

## Context

`tokens.css` hand-wrote a seven-step spacing ramp (each an independent
`clamp()` triple), a seven-step type ladder, a second seven-step spacing ramp in
`shell.css` for the console's container-query scope, and a four-step control
ramp. Its own comment admitted the type sizes were *snapped* to a scale after
the fact. "Make everything 5% denser" was a thirteen-line edit with no way to
tell a deliberate value from a typo — and the renderer's canvases (`GraphStage`,
`GrowthChart`) hardcode px that ought to come from the same numbers.

The brief ("constants are produced by the fundamentals of the codebase") could
have been satisfied by inventing a clean scale and retuning the UI to it. That
would have been a redesign wearing a refactor's clothes.

## Decision

`src/renderer/design/scale.ts` holds the fundamentals and a pure
`renderTokensCss()`; `scripts/gen-tokens.mjs` is a thin CLI over it with a
`--check` mode mirroring `build:page:check`; `tests/renderer/tokens.test.ts`
fails when the committed `tokens.generated.css` drifts from the module, and
separately asserts the shipped values as a golden table. The palette, radii,
hairlines, fills, gradients, elevation and `--ease` — judgement calls with no
generating rule — stay hand-authored in `tokens.palette.css`.

**Every constant was FITTED to the shipped values, not chosen and rounded to.**
The introduction had to be a pure move. What actually derives:

| Token group | Rule | Reproduces |
|---|---|---|
| Spacing mids | `4px × [0.5,1,2,3,4,5,6]` — LINEAR, not geometric | 7 / 7 |
| Spacing min shoulder | `0.75 × mid` | 7 / 7 |
| Spacing max shoulder | `floor(1.125 × mid)` | 5 / 7 |
| Root preferred value | `mid × 100 / 1240.5` vw, 3 dp | 7 / 7 |
| Console preferred value | `mid × 100 / 470.5` cqi, 2 dp | 6 / 7 |
| Type ladder | `12px + [-3.5,-3,-2,-1,0,1,3]` — LINEAR | 7 / 7 |
| Control sizes | `24px + 2n` | 4 / 4 |

Three findings are worth keeping:

1. **Neither ramp is geometric.** The ideation proposal assumed
   `sp-n = BASE × 1.5^(n-1)` and a 1.125 "major second" type ratio. The major
   second reproduces **none** of the seven shipped font sizes; the spacing ramp
   is plain multiples of the 4px base. The design's real rule was simpler than
   the one we were about to impose on it.
2. **The design width is 1240.5px, and it was measured, not picked.** It is the
   only width at which all seven `vw` values round to what shipped. The console
   container width fits the same way at 470.5px.
3. **Three values do not fall out of a rule and are carried as explicit
   overrides with their reasons**, rather than being smoothed away:
   `--sp-0`/`--sp-1`'s upper shoulders (at 2px and 4px, `floor(1.125 × mid)`
   collapses onto the mid and the token stops being fluid at all, so the mockup
   widened them to `1.25 × mid`), and the console ramp's `--sp-5`, which ships
   `4.26cqi` where the derivation gives `4.25cqi` — a 0.01cqi hand-value worth
   about 0.05px, preserved because a pure move may not quietly retune.

The six `--fs-fluid-*` clamps stay a literal table inside `scale.ts`: they are
hand-tuned per role and provably cannot share one container width (`cap` needs
C ∈ (491.8, 494.1], `title` needs C ∈ (502.5, 504.2] — disjoint). Keeping them
in the scale module puts all type in one file without pretending they derive.

## Consequences

- `tokens.css` is gone, replaced by `tokens.palette.css` + `tokens.generated.css`
  at the same position in `index.css`'s import order (which IS the cascade
  order). The console ramp moved out of `shell.css` into the generated file;
  nothing else declares `--sp-*` at that scope, so the cascade is unchanged.
- The renderer can import `SPACE_PX` / `TYPE_PX` for canvas layout, so the
  charts and the graph stage can stop hardcoding px against the same numbers.
- A new gate: `npm run gen:tokens -- --check`. Until the two scripts land in
  `package.json` it is `node scripts/gen-tokens.mjs --check`, and the jest
  freshness test covers it either way.
- Changing a fundamental now changes thirteen custom properties at once — which
  is the point, and also the risk: the golden test is what keeps that power from
  becoming an accidental retune.

## Amendment — 2026-11-03: the readable type ladder (ADR 0405)

The overhaul deliberately replaces the fitted 12 px ladder with semantic text roles based on a
15 px body, larger controls and extended spacing. The fluid type-role table is retired. Tokens still
derive from `design/scale.ts` and are regenerated, with goldens for the chosen values and contrast
checks for the revised palette. Bundled Inter and tabular numerals keep layout stable during updates.

## Amendment — visual cleanup after owner review

The owner found inconsistent padding, unused card space and poorly grouped controls in the rendered
overhaul. Spacing now uses the scale's fixed values: 2, 4, 8, 12, 16, 20, 24, 32 and 40 CSS pixels.
The fitted viewport and nested-container clamps are retired. A 16 px card inset is therefore the same
in the sidebar, a wide stage and a nested column. Container queries still change columns and wrapping;
they no longer change the meaning of a spacing token. The generator, freshness gate and explicit
golden values remain authoritative. Typography and control heights are unchanged.

Stage pages use 24 px outer gutters, with a 1280 px reading-width limit for People and Prune.
Content surfaces use 16 px insets and 12–16 px internal separation. Empty states collapse to an honest
explanation instead of reserving chart or metric space. Growth plots measure their width in CSS pixels
and keep a fixed plot height, so widening the window cannot enlarge axis labels.
