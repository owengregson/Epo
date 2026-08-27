# Epo — instructions for AI-assisted development

Epo (formerly Peanut) is an Electron desktop Instagram growth engine: SQLite
knowledge graph (`src/store`) → governors → versioned IG adapter
(`src/adapter`, all IG literals live in `src/adapter/versions/*`) → rim ports
(`src/rim`) → engines (`src/engine`) → composition root
(`src/main/foundation-wiring.ts`) → Preact renderer (`src/renderer`).

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

`npx jest` (fast, in-memory), `npx tsc --noEmit`, `npm run lint`
(`biome ci src` — lint + format + import organizing), `npm run build:dev`.
All four must be green before a change is done. DOM-level adapter changes additionally need
`npm run livetest` against a real session.
