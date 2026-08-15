# Epo Next-Gen Implementation Plan

> **For agentic workers:** phases run in sequence with a green gate (`npx tsc --noEmit` + `npx jest` + `npm run build`) between each. Fable agents implement; the orchestrator verifies.

**Goal:** Add async external-change reconciliation, rename Peanut → Epo (product, code, brand), design an Epo logo/wordmark, rewrite the README Mental-style, and harden the repo/build for production (latest deps, CI, `npm run dist` standalone app, GitHub repo polish).

**Architecture:** Electron `BaseWindow` + `WebContentsView` control center (Preact/TS renderer, esbuild). A version-marked Instagram adapter feeds a local event-sourced SQLite knowledge graph; a paced engine drives follow/hold/unfollow churn.

**Tech Stack:** TypeScript (strict), Preact, esbuild, better-sqlite3 (WAL), Electron, Jest, ESLint 9 (flat), electron-builder.

## Global Constraints

- No silent `catch {}` — typed no-match + `warn`; throw only on DOM-stale.
- All Instagram literals stay in `src/adapter/versions/*` (version-marked adapter).
- Keep all existing tests green; add tests for every new behavior (TDD).
- No user data migration needed (no users yet) — DB file may be renamed freely.
- Async policy: **leave-alone** — Epo only ever unfollows accounts IT followed.
- Rename depth: **full** (product, package, `window.epo` bridge, `epo.db`, strings).
- Deps: **latest incl. breaking** (ESLint 9 flat config, newest Electron/TS/Jest/esbuild).
- Brand: **minimal geometric monogram** + custom wordmark.

**Logo decision (locked, visually verified):** concept **A "aperture‑e"** — a geometric
lowercase‑`e` monogram (Epo's initial): a ring masked open at the lower‑right aperture +
a rounded crossbar, in brushed silver (`--silver` / `currentColor`), with a single brass
(`--warn` #d8b768) "growth‑node" satellite at the upper‑right. Verified legible at 96/40/22px
on dark and light. Master geometry (viewBox 0 0 64 64):
`mask wedge M32 32 L64 32 L64 64 L40 64 Z` · `ring circle r=21 stroke-width=8` ·
`crossbar line 13,32→53,32 stroke-width=8 round` · `node circle 49.7,11.3 r=5.2 brass`.

---

## Phase A — Async external-change reconciliation

**Problem.** The engine assumes it is the only actor on the account's follow graph.
`show_many` / `friendship-show` / `web_profile_info` responses carry OUR true
follow-status toward accounts (`following` / `followed_by_viewer`) but are parsed
NOWHERE in the live flow. So when an external system (the user or another app)
follows/unfollows, Epo's `follow_records` + `edges` diverge from reality:

- **Ghost unfollow (A):** external unfollows an account Epo is holding → the timer
  eventually queues an unfollow; the Actor finds a "Follow" button, no-ops, and the
  scheduler records a phantom unfollow (consumes a ceiling slot, skews stats).
- **Stolen follow (B):** external follows a `queued` candidate → the Actor finds
  "Following", no-ops, and the scheduler records it as OUR follow → Epo later
  unfollows an account the user deliberately followed. **Service disruption.**
- **Pool leak (C):** `candidatePksForTarget` excludes only follow-records + skipped,
  never accounts we already follow → the user's manual follows re-enter the queue.

**Design — two complementary layers, one policy sink.**

### A1. Store: reconciliation sink + terminal `external` state + pool fix

`src/store/types.ts`: add `'external'` to `FollowState` (terminal — an external actor
owns the relationship; Epo backs off). No schema migration (state is free-text TEXT).

`src/store/knowledge-store.ts`:
- `activeFollowRecords()` query: add `'external'` to the terminal `NOT IN (...)` list.
- Add optional own-pk field set at build time: `setOwnPk(pk: string): void` (stored on
  the instance; used only for the pool exclusion below). Keeps the store constructor
  signature stable.
- `accountsWeFollow(): Set<string>` — `src_pk = ownPk` active `follows` edges' `dst_pk`.
  Returns empty set when own-pk unset.
- `candidatePksForTarget(targetPk)`: also exclude `accountsWeFollow()` (never queue an
  account we — or the user — already follow).
- `reconcileOwnFollow(pk: string, weFollow: boolean, at: number): 'noop' | 'dropped-queued' | 'dropped-held' | 'edge-only'`
  — the single policy sink. Requires own-pk set (no-op + one-time warn if unset).
  1. Upsert edge `ownPk → pk` to `active = weFollow` at `at` (truth from observation).
  2. Reconcile the follow-record (leave-alone policy):
     - record ∈ {`pending_followback`,`followed_back`,`unfollow_queued`} and
       `weFollow === false` → external removed / follow reverted → set state
       `'external'`, `setRole(pk,'skipped')`, NO ledger row → `'dropped-held'`.
     - record === `queued` and `weFollow === true` → external already follows →
       set state `'external'`, `setRole(pk,'skipped')` → `'dropped-queued'`.
     - otherwise (consistent, or terminal, or no record) → `'edge-only'`/`'noop'`.
  - Never writes an `action_ledger` row (reconciliation is not our action).

Tests (`tests/store/knowledge-store.test.ts` or new `reconcile.test.ts`): each branch,
pool exclusion of already-followed accounts, own-pk-unset no-op.

### A2. Reader: relationship facts extractor (version-agnostic; already has parsers)

`src/adapter/reader.ts`: add
`relationshipFacts(url, body, at): Array<{ pk: string; weFollow: boolean }>` that routes
by `matchEndpoint(url)`:
- `show-many` → `parseShowMany` → `{pk, weFollow: following}` per entry.
- `friendship-show` → pk via `extractPkFromUrl`, `parseFriendshipShow` → `{pk, weFollow: following}`.
- `web-profile-info` → `parseProfileInfo` (pk) + `profileFollowedByViewer` (weFollow);
  emit only when both present.
- else → `[]`.
Pure, no store. Tests reuse existing fixtures.

### A3. Reconciler + passive install (mirrors `installRequestMetering`)

`src/rim/relationship-reconciler.ts`:
- `class RelationshipReconciler { constructor({store, ownPk, reader, clock}) ; ingest(resp: TabResponse): Promise<void> }`
  — reads the body once, calls `reader.relationshipFacts`, and for each fact calls
  `store.reconcileOwnFollow(pk, weFollow, at)`. Skips its own account. No silent catch.
- `installRelationshipReconciler(tab, reconciler): Unsubscribe` — `tab.onResponse` that
  fires `reconciler.ingest` for matching endpoints only (cheap `matchEndpoint` pre-check).

Wire in `foundation-wiring.ts build()`: `store.setOwnPk(ownPk)`, construct the
reconciler, `installRelationshipReconciler(this.tab, reconciler)`, and add its
unsubscribe to teardown alongside `requestMeteringUnsub`.

Tests (`tests/rim/relationship-reconciler.test.ts`): a `show_many` body flips a held
record to `external`; a `friendship-show` `following:false` drops a held record; a
`web_profile_info followed_by_viewer:true` drops a queued candidate.

### A4. Point-of-action overlap handling (the definitive in-flight signal)

The Actor already computes `clicked` (false ⇒ already in the target state). Surface it:

- `src/adapter/actor.ts`: `follow`/`unfollow` return `Result<{ clicked: boolean }>`
  (`clicked:false` = idempotent no-op; the button was already in the target state).
- `src/engine/churn-scheduler.ts`: `ChurnActionOutcome` gains `alreadyInState?: boolean`.
- `src/rim/churn-actions.ts`: map `result.value.clicked` → `alreadyInState: !clicked`
  on `ok`.
- `ChurnScheduler.executeFollow`: on `ok` with `alreadyInState` → account was already
  followed externally → `store.reconcileOwnFollow(pk, true, now)` (drops to `external`),
  NO ledger, NO `pending_followback`. On `ok` clicked → today's behavior.
- `ChurnScheduler.executeUnfollow`: on `ok` with `alreadyInState` → already not
  following → `store.reconcileOwnFollow(pk, false, now)` then set record `unfollowed`,
  NO ledger. On `ok` clicked → today's behavior.
- `foundation-wiring.recordManualOutcome`: same `alreadyInState` awareness (don't record
  a phantom manual action/edge when nothing was clicked).

Update `livetest/steps.ts` + all Actor/churn tests for the new return shape.

**Phase A gate:** tsc clean, jest green (new tests included), build clean.

---

## Phase B — Global rename Peanut → Epo

One focused sweep AFTER Phase A (so it covers new files). Full depth:
- Product/UI strings: `Peanut` → `Epo` (Header `<h1>`, titles, `index.html <title>`,
  comments/JSDoc where it reads as the product name).
- IPC bridge: `window.peanut` → `window.epo` (preload + all 26 renderer sites + types).
- Package: `name` → `epo`, description refresh; `main` path unchanged.
- DB: `IG_DB_FILE = 'peanut.db'` → `'epo.db'`; `peanut-livetest.db` → `epo-livetest.db`.
- Any `peanut`-prefixed identifiers/log tags → `epo`.
- Leave the brand glyph in `Header.tsx` as a placeholder; Phase C replaces it.
- Do NOT touch `docs/adapter/fixtures/**` (captured data) or the memory dir.

**Phase B gate:** `grep -rin peanut src` returns only intentional residue (none expected);
tsc clean, jest green, build clean.

---

## Phase C — Epo logo/wordmark + brand integration

- Design assets under `project/assets/` (mark, wordmark, hero, favicon source):
  minimal geometric monogram from `e`/`o`, monochrome + one accent, theme-aware.
- `Header.tsx`: replace placeholder glyph with the Epo mark (inline SVG component).
- `index.html`: title + inline favicon.
- App icon: `build/icon.png` (1024²) rasterized from the master SVG for electron-builder
  to derive `.icns`/`.ico`.
- Feed the hero/mark into the README (Phase D-README).

**Phase C gate:** build clean; mark renders in header; icon present.

---

## Phase D — Production hardening (deps · CI · dist · repo · README)

- **Deps (latest, breaking):** Electron, TypeScript, Jest 30 + ts-jest, esbuild,
  better-sqlite3, preact, @types/*, ESLint 9 → migrate `.eslintrc.cjs` to
  `eslint.config.mjs` (flat, typescript-eslint). Native rebuild; all tests green.
- **Build CLI harness:** a cohesive `scripts/epo.mjs` (or `bin/`) exposing
  `build | dev | dist | test | lint | typecheck` with clear help; wire npm scripts.
- **`npm run dist`:** add `electron-builder` + config → standalone macOS (dmg+zip)
  and Windows (nsis) targets, `build/` icons, `asarUnpack` for `better-sqlite3`,
  `files` allowlist. Unsigned (note in README). `npm run dist` builds for the host OS.
- **GitHub Actions** (`.github/workflows/`): `ci.yml` (lint+typecheck+test, node
  matrix), `release.yml` (mac+win electron-builder matrix on tag → artifacts/release),
  `codeql.yml` (js-ts), `scorecard.yml`, `dependency-review.yml`.
- **Repo polish:** `.github/` — `dependabot.yml`, `SECURITY.md`, PR template,
  issue templates (bug/feature), `RELEASE-TEMPLATE.md`, `FUNDING`(optional).
- **SEO:** set 20 GitHub topics + refreshed description + homepage via `gh repo edit`
  (outward-facing; explicitly requested).
- **README:** ground-up rewrite Mental-style (hero, feature grid, getting started,
  how it works, safety model, async reconciliation, configuration, build/dist, FAQ).

**Phase D gate:** `npm run lint`, `npx tsc --noEmit`, `npx jest`, `npm run build` all
green; `npm run dist` produces an installable artifact on the host OS.

---

## Phase E — Nav responsiveness tweak (Phase 4 and earlier)

The view/tab switch currently waits for the outgoing transition to finish before the
incoming one plays, so rapid tab presses feel laggy. Make swaps **interrupt immediately**:
pressing a nav item switches the active view at once (the fade still plays, but the new
view's enter animation starts the instant the tab is pressed — no queueing on the
previous animation). Touch `src/renderer/app/ViewStage.tsx`, `src/renderer/hooks/useView.ts`,
and the relevant transition CSS. Keep the fade; remove the delay/animation-end gate.
(Isolated to the renderer view layer; safe to do before Phase B.)

---

## Phase 5 — Auto-prune (unfollow non-followers-back)

A SEPARATE routine from growth churn: a one-shot (or scheduled every X) sweep that walks
our OWN entire following + followers lists, and **unfollows every account we follow that
does NOT follow us back**, except accounts on a configurable, persisted **whitelist**.

**Separation & resource-sharing (the core constraint).** It shares the ONE Instagram tab,
the store, the Sentinel, and the request-budget metering, so it MUST NOT run concurrently
with the growth engine (R3 tab-serialization already forbids two drivers on one
WebContents). Design:
- A dedicated `PruneEngine` (own module) with its OWN daily action budget/ceiling
  (`pruneDailyLimit`) and pacing, entirely separate from the growth `RateGovernor`
  counters (so pruning can't starve or be starved by growth's daily cap). It reuses the
  shared `RequestBudget` metering (request volume is the ban vector — one shared budget)
  and the shared `Sentinel`.
- **Mutual exclusion** with growth via a foundation-level "active driver" lock: starting a
  prune run pauses/holds the growth loop (or refuses to start while growth is running,
  surfaced in the UI), and vice-versa — never two drivers on the tab at once. Pick the
  cleaner of {auto-pause growth for the prune run, then resume} vs {refuse + prompt};
  lead the design — recommended: a single `TabLease`/driver-token the foundation grants,
  with the UI reflecting who holds it.
- **Data:** walk own-following (who we follow) + own-followers (who follows us) via the
  existing paginated readers (`FollowersPageReader` / own-followers source), reuse
  `edges` + `reconcileOwnFollow` truth. A non-follower-back = active `ownPk→pk` edge with
  no active `pk→ownPk` edge. Whitelist bypasses. Each unfollow goes through the shared
  Actor + is reconciled + laddered by the prune budget/pacing, interruptible like growth.
- **Settings (persisted):** `pruneWhitelist: string[]` (usernames/pks), `pruneDailyLimit`,
  `pruneSchedule` (off | every N days) + last-run timestamp. Save like other settings.
- **UI:** its OWN tab ("Prune" / "Cleanup") — a candidate list (who would be pruned),
  whitelist editor, run/stop + progress, last-run summary, and a schedule control. Lead
  the layout using the existing card/primitive system; match the console aesthetic.
- **Safety:** dry-run honored; same active-hours/ceiling philosophy; a confirm before a
  destructive full run; never prune whitelisted or mutual accounts; fully interruptible.

Sequenced LAST, after Phases A–E land and are green. Gets its own sub-plan before build.
