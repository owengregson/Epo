# 1002 — Boundaries are a gate, and severity is the ledger

Status: accepted (2026-09-02)

## Context

The v4 design's §1 states what may import what: the kernel imports nothing from
`src`; the renderer sees only `shared`, the IPC contract and itself; engines
reach Instagram through rim ports, never the adapter; the adapter knows nothing
about policy or process lifetime; SQL and its dependencies stay inside the
store. Until now that was prose. Biome's `noRestrictedImports` enforces the one
fence expressible per-module (`better-sqlite3` → `src/store` only); a *layer*
rule needs the graph, which no linter has.

Measured on today's tree, the §1 rules are not all true. `src/renderer` reaches
`src/types.ts` 58 times; five engine modules import `src/adapter/sentinel.ts`;
three adapter modules import `src/store/types.ts`; the store reaches
`src/timing` and `src/utils`; 34 module cycles exist. A gate that fails on all
of that on day one is a gate somebody turns off.

## Decision

`dependency-cruiser` 18, run by `npm run boundaries`, with **two severity
tiers** and a rule that severity only ever moves one way:

- **`error`** — the half of each §1 rule that already holds. `kernel` imports
  nothing outside itself; the renderer never reaches the store, adapter, engine,
  rim or main; engines never import main or the renderer; the adapter never
  imports an engine or main; the store never imports anything above it. These
  can only be broken by a *new* import, so they are a real gate immediately.
- **`warn`** — the same rule in full, with the edges that exist today named in
  its comment. When a wave deletes the last edge, the rule is promoted to
  `error` and the comment is deleted with it.

Severity is therefore the migration ledger, and the diff that promotes a rule is
the proof the debt is gone.

Two rules are structural rather than layered: `no-circular` (34 today, all
routed through `src/types.ts` acting as a shared barrel) and `no-orphans`, whose
allow-list holds the five real entry points. `src/kernel/**` is exempt from
`no-orphans` for one wave — wave A lands the kernel before its consumers by
design — and the exemption is written to be deleted, not renewed.

`npm run boundaries` calls `scripts/boundaries.mjs`, not the `depcruise` CLI.
The CLI asserts the *developer's* Node against its own `engines` field
(`^22||^24||>=26`) and refuses to start on anything else; the library beneath
has no such gate. What this gate tests is the rule set, and CI pins Node from
`.node-version` regardless.

## Consequences

- Five gates, not four: `typecheck`, `lint`, `boundaries`, `test`, `build`.
  `npm run check` runs the full sequence locally; CI runs it per matrix leg.
- The graph is cruised with `tsPreCompilationDeps: true`, so a type-only import
  counts. A renderer that imports a store row type is coupled to the store's
  shape whether or not the import survives transpilation.
- `electron` is exempted from the "no devDependency in src" rule on purpose: it
  is a devDependency precisely because the *runtime* provides it, and esbuild
  marks it external.
- The warn tier is loud (113 edges). It is printed one line per rule, with
  `--verbose` for the edges, so a newly-introduced warn is visible instead of
  buried.
