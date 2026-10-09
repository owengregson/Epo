# Epo — instructions for AI-assisted development

Epo (formerly Peanut) is an Electron desktop Instagram growth engine. Read
the pipeline left to right:

- `src/kernel/` — the dependency-free kernel (ADR 06xx): brands and units,
  ONE `Outcome` algebra, `Res`, `Schedule`, `Scope`, `parse` (zod at the
  edges only), capabilities, `Module`/`Session`, and the fundamentals →
  policy → derive → overrides chain. Every numeric constant is either derived
  from a fundamental, a named policy dial, or an override with a reason; a
  golden test pins which is which. Add a constant there, never inline.
- `src/store/` — SQLite knowledge graph on Node's built-in `node:sqlite`
  (`src/store/driver/`, ADR 0702; no native packages, a test enforces it),
  nine repos behind the `KnowledgeStore` facade, a tables manifest,
  append-only migrations (`{id,name,sql}`), Chronos durable timers and
  SpanSink spans.
- `src/surface/` + `src/adapter/` — the Instagram surface. ALL IG literals
  (URLs, selectors, JSON paths) live ONLY in `src/surface/versions/*` and
  `src/adapter/versions/*`; the surface is a validated zod document (ADR
  0801) currently in shadow mode beside the versioned adapter; in-page logic
  is real TypeScript in `src/adapter/page/*` bundled into the committed
  `bundle.generated.ts` (regenerate with `npm run build:page`, freshness is a
  test). Scrubbed fixtures only under `tests/fixtures/surface/`; real
  captures in `docs/adapter/fixtures/` are git-ignored and never published.
- `src/rim/` ports → `src/engine/` (Facts + pure rules with a precedence
  property, an ordered `GATES` table, `Pacer` port, `target-pipeline.ts`,
  typed `HaltReason`, `EFFECT_POLICY` as data).
- `src/main/` composition root (`bootstrap.ts`, `window/shell.ts`,
  `services/*`, modules, `foundation-wiring.ts` — being dismantled in wave B)
  → typed IPC in `src/ipc/contract.ts` (CHANNELS + PUSH + GUARDS; every
  channel name appears exactly once; guards validate and never throw;
  `EpoBridge` is derived from it) → Preact renderer (`src/renderer`:
  `@preact/signals` in ONE shell context, generated tokens from
  `design/scale.ts`, inline SVG icons, WAAPI stagger, a dev gallery route).
- Pure code shared by renderer and engines lives in `src/shared/`. Design
  rationale lives in `docs/adr/` (01xx main, 02xx engine, 03xx adapter,
  04xx renderer, 05xx store/tooling, 06xx kernel, 07xx store v4, 08xx
  surface, 09xx runtime, 10xx toolchain/shell) — read the relevant ADR
  before changing a load-bearing behavior. The v4 design and its wave plan:
  `docs/superpowers/specs/2026-09-02-epo-v4-framework-design.md`.

## Mandatory design principles

Read `docs/PRINCIPLES.md` before writing or reviewing collection/store code.
Non-negotiable highlights:

- **Facts stream; verdicts wait** (§1): every observed fact (profile row,
  relationship edge, event) is written to the KnowledgeStore the moment it is
  parsed — never buffered until a batch/walk/scan completes. Only
  absence-based verdicts (lost followers, candidate sets, baselines) may gate
  on a verified-complete walk. A new collection path must deliver per-item
  callbacks or write through per item.
- **The UI mirrors the graph, live** (§2): renderer data derives from store
  projections pushed on store mutation (throttled) — counts tick DURING
  scans/sweeps. Never gate a display on an operation finishing when the graph
  already holds the number.
- **Schedules are durable** (§3): configured cadences persist their last-run
  timestamp (Settings/store meta) and evaluate at startup — work that came
  due while the app was closed runs first, never one interval later.
- No silent catches; shape drift returns `SHAPE_MISMATCH`, never a
  fabricated "empty/false" fact.
- Instagram literals (URLs, selectors, JSON paths) live ONLY in
  `src/adapter/versions/*`; everything else consumes the `IgSurface`
  interface.
- Background-run survival: the CDP input dispatch and the anti-throttling
  switches (`main.ts`, `tab.ts`) are all load-bearing — never remove a layer
  (see `docs/HANDOFF.md`, 2026-08-14 entries).

## Verification

`npm run check` runs every gate and must be green before a change is done:
`gen:targets:check` and `gen:tokens:check` (generated files are current),
`npm run typecheck` (`tsc` over `src` AND `tests` — tests are type-checked
too), `npm run lint` (`biome ci src tests`), `npm run boundaries`
(dependency-cruiser; 0 errors, warnings are the wave-B backlog and must not
grow), `npm run build:page:check`, `npx jest` (fast, in-memory), `npm run
build:dev`. `npm run knip` is advisory. The line budget test (300 lines per
`.ts/.tsx` file, monotone allow-list in `scripts/gen-line-budget.mjs`)
refuses new oversize files. Shared test fakes live in `tests/kit/` (setup,
store helpers, port fakes) — extend those rather than hand-rolling a fake per
suite. DOM-level adapter or surface changes additionally need
`npm run livetest` against a real session; `npm run surface` opens the
surface lab.
