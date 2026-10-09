# Maintainability refactor — design (2026-09-02)

**Goal (owner's words):** "review the entire codebase structure, framework, etc. adversarially and
recode most things with much more proper setup that allows the app to be significantly more
maintainable (rather than manual css animations, use a framework, etc.) — migrate towards more
simple maintainable code."

**Method:** five parallel adversarial reviews (renderer · main/IPC/settings · engine/timing ·
adapter/rim/harnesses · store/tests/tooling), each producing a findings table with `file:line`
evidence, a do-not-touch list, and a migration order that keeps the four gates green. This document
records what was decided from them and how the work is partitioned. The full reports live in the
session scratchpad; their substance is summarised here.

## 1. What the reviews agreed on

- The architecture is sound; a handful of objects escaped it. Six files hold most of the
  maintenance cost: `foundation-wiring.ts` (2,724 lines, 39 methods, 14 mutually-constraining
  flags), `engine.ts` (2,081; a 254-line `step()` with 24 returns), `prune-engine.ts` (1,450; a
  second copy of the conductor loop), `knowledge-store.ts` (1,614; 64 methods over 12 tables),
  `versions/2026-08-12.ts` (1,450; 504 lines of page JS inside template literals, 132 duplicated
  lines across 8 click/locate twins), `GraphStage.tsx` (1,000; ~600 inside one effect).
- **Tests were neither type-checked nor linted** (`tsconfig`/`biome` scoped to `src/**`). Fixed in
  wave 0: `tsconfig.test.json`, `npm run typecheck`, `npm run lint` now covers `tests/**`.
- Comment density is ~37% in the engine layer, much of it incident narrative and references to a
  numbering scheme (`R4`, `f12`, `amendment C`, `§`) that exists nowhere in the repo.
- Concrete defects found along the way (fixed by the owning agent, listed in §5).

## 2. Framework decisions (adopt / reject, with the reason)

| Proposal | Decision | Reason (measured) |
|---|---|---|
| Tailwind v4 / CSS Modules for the renderer | **Reject** | 547 selectors, 1 orphan class, 636 token references, a fluid `clamp()`/`cqi` scale. Tailwind adds a build step and deletes zero lines; CSS Modules rewrites 191 class references for no reduction. Biome's CSS linter/formatter and a re-cut by feature fix the real problems. |
| Animation library (`motion`, `@formkit/auto-animate`) | **Reject library; adopt the Web Animations API** | 13 keyframes ≈ 60 lines nothing beats. The sink is a 4-file stagger contract plus an `index` prop drilled through 16 interfaces / 39 call sites. A ~25-line native WAAPI helper deletes ≈200 lines with zero deps. `motion` stays the drop-in upgrade if springs are ever wanted. |
| `@preact/signals` store | **Defer** (adopt the lite version) | Fix the two duplicate subscriptions and move `confirm`/`toast` to `createContext`: ~70% of the win for ~20% of the churn. Signals remain an option once `App.tsx` is decomposed. |
| jsdom + `@testing-library/preact` | **Adopt** | The renderer had zero render tests; helpers were exported only for tests. Installed in wave 0; per-file `@jest-environment jsdom`. |
| `xstate` for the conductor | **Reject** | Eleven ordered guards do not need an actor runtime. An ordered gate table (~30 lines, no deps) is the contract; `RecoverySupervisor` already proves hand-written durable FSMs read well here. |
| `kysely` / `drizzle-orm` for the store | **Reject (for now)** | The painful statements (`healAbandonedInWindow`, `netGrowthSeries`, `graphSnapshotRows`) would all land in `sql` escape hatches; the types are hand-written either way; 20k `prepare()` = 78 ms so perf is not a motive. A column manifest + repo split behind the existing facade gets ~90% of the drift protection. |
| `vitest` / `tsup` | **Reject** | Jest 30 + SWC runs 1,044 tests in ~2 s; esbuild config is 60 lines. Nothing to buy. |
| `electron-trpc` / `@electron-toolkit/typed-ipc` | **Reject; hand-roll a 40-line typed contract** | 32 channels; a `contract.ts` map makes every channel name appear exactly once and derives `EpoBridge`. `electron-trpc` adds 3 deps and duplicates the preload listener registry. |
| `zod` for settings | **Adopt, conditionally** | 49 knobs are declared 4× with a 14-line block copy-pasted twice. A schema as the single source is the standard tool. Condition: `tests/settings/settings.test.ts` passes unmodified (the legacy-pattern migration must survive as an explicit pre-parse step). |
| Page scripts as real TypeScript | **Adopt** | `src/adapter/page/*.ts` compiled by a dedicated esbuild step into a committed, freshness-tested bundle string; the version module supplies only literals. First real DOM tests for the adapter. |

## 3. Cross-cutting policies

**Comment policy (three tiers).** Keep in code: invariants a reader must know to edit the line, ≤3
lines, present tense, no dates. Move to `docs/adr/NNNN-slug.md`: why a design beat its alternative.
Delete: incident narrative ("used to", "the 2026-08-13 run…") and tag references (`R4`, `f12`,
`amendment C`, `§n`). Git history is the changelog. ADR numbers per area: main 01xx, engine 02xx,
adapter/rim 03xx, renderer 04xx, store/tooling 05xx.

**Shared test kit.** `tests/kit/` — `setup.ts` (log level, via `setupFilesAfterEnv`), `store.ts`
(`withStore`/`memoryStore`), `fakes.ts` (the former rim fakes). Areas add their own harness files
(`tests/kit/<area>-*.ts`) rather than editing each other's.

**Gates.** `npx jest`, `npm run typecheck`, `npm run lint`, `npm run build:dev` — green after every
step. DOM-level adapter changes additionally need `npm run livetest`.

## 4. Do NOT touch (union of the five reviews)

- CDP `Input.dispatchMouseEvent` transport and its serializing chain; the three anti-throttling
  switches in `main.ts` (must run before `app.whenReady()`); `backgroundThrottling:false` and
  `Emulation.setFocusEmulationEnabled` in `tab.ts`; the remove-then-add debugger listener
  re-registration; `powerSaveBlocker('prevent-app-suspension')`.
- Text/role matching, never class names; the header-only anchor for the action button;
  `SHAPE_MISMATCH` semantics (drift never collapses to the typed empty end-of-list shape);
  `listEndProbeCursor` end verification.
- Facts-stream per-row writes and `onMutation` per write with the 300 ms trailing push of all
  three projections (status, pruneStatus, chainList); `chainListKey`/`countKey` refetch keys.
- One IG action per iteration; durable deadlines (`action_delay_deadline_at`, `recovery_state`,
  `pacing_state` after every step, persisted `sweepLastRunAt`); `stop()` keeps the owed gap.
- Recovery semantics (diagnose the tab before holding; unhealthy tab consumes no rung; drift needs
  two windows; heal once per reset); jitter guarantees (resume-day seeding, separate noise rng).
- The live-graph guard in prune; the raw-timer fence in biome; `better-sqlite3` confined to
  `src/store/*`; `migrations.ts`' refusal to open a future-versioned DB; append-only migrations.
- Updater isolation (`updater.ts` imports electron at load; `autoDownload=false`).
- CSP/offline: no CDN, no runtime CSS-in-JS via eval.
- The ABI rebuild scripts until a two-platform smoke test confirms they are vestigial (drop `-f` only).
- `LICENSE` vs `package.json` licence mismatch (AGPL text vs MIT declaration) is the owner's decision.

## 5. Partition and scope of this pass

Five agents work concurrently in one tree with **disjoint file ownership**; anything outside an
agent's set is read-only for it. Cross-ownership seams are handled in a serial integration pass.

| Agent | Owns | Delivers (priority order) |
|---|---|---|
| **M** main/IPC/settings | `src/main/**`, `src/settings/**`, `src/types.ts`, `src/ipc/**` (new), the three `*-main.ts` harness entries, `tests/main/**`, `tests/settings/**` | typed IPC contract (one name per channel, `EpoBridge` derived, `update:*` in the disposer, `safe()` wrapper), delete the dead `IpcInvokeChannel`; extract `buildGraph()`; de-electron `Foundation` (inject `userDataDir` + cookie reader); `TabLease`; shared `bootstrap.ts` with the survival switches applied by all four entries; single-instance lock; settings consolidated (zod if the tests stay unmodified); dead prune cool-down gates fixed; main test-kit |
| **G** engine/timing | `src/engine/**`, `src/timing/**`, `src/governors/**`, their tests | disarm the source-grep tripwire; `decisions.ts` pure extractions; typed `HaltReason` (string-compatible on the status surface); `WaitRunner`; `applyOutcome` + required `streaks()`; gate table for `step()`; prune `superseded()`; `recovery-healer.ts`; timing paper cuts; comment sweep of the three big files |
| **A** adapter/rim/interaction | `src/adapter/**`, `src/rim/**`, `src/interaction/**`, harness bodies (`capture-harness.ts`, `classify.ts`, `steps.ts`, `injection.ts`), their tests | livetest wired with an Interactor (production input path); dead surface members; `fetchJson`; per-row edge writes in the dialog fallback; `probeFollowRequestHead`; unified tab ports; delete the JS-click fallback; page scripts as TypeScript with jsdom tests and a committed generated bundle; capture harness routed through `SURFACE`; kit fakes |
| **R** renderer | `src/renderer/**`, `tests/renderer/**` | dead code; SVG icon map (FontAwesome import removed); WAAPI stagger and `index` de-drilling; one positioner; duplicate subscriptions + contexts; `useBridgeEvent`; `App.tsx` split into hooks; duplicate helpers; CSS re-cut by feature; jsdom render tests; `GraphStage` split if time allows |
| **S** store/tooling | `src/store/**`, `src/utils/**`, `tests/store/**`, `tests/kit/{setup,store}.ts`, `jest.config.js`, `tsconfig*.json`, `biome.json`, `esbuild.config.mjs`, `package.json` scripts/devDeps, `.gitignore`, `.github/**`, `scripts/**`, `src/readme/**` | repo split behind the `KnowledgeStore` facade (`MetaRepo` first, then the rest); `ACCOUNT_COLUMNS` manifest; migrations as `{id,name,sql}`; `username_history` change-check; injectable `now`; esbuild dedupe + target bump + `--watch`; drop `-f`; FontAwesome to devDeps; CI matrix on Electron's Node; gitignore trims |

Deferred to a later pass (high risk or cross-layer): prune as a conductor mode (P1), the rim walk
engine unification (D9), the tab split (D14), the outcome-union across layers (D13), constant
co-location (T1), the observations-table decision (E3), signals (R5 full), LICENSE.

## 6. Integration pass (serial, after the agents)

Re-run all gates; resolve the seams (`HaltReason` consumers in wiring/UI, the renderer→engine
layering leak, FontAwesome dependency removal, `build:page` script), write the HANDOFF entry, and
update `docs/PRINCIPLES.md`/`CLAUDE.md` where the structure changed.
