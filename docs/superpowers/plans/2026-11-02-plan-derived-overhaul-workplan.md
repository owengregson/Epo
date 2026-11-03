# Plan-derived overhaul — workplan

**Date:** 2026-11-02 · **Spec (normative):** `docs/superpowers/specs/2026-11-02-plan-derived-overhaul-design.md`
(cited as "spec §N") · **Base:** `feat/plan-derived-overhaul` @ `f5e7e50` · **Checkpoint:** `refs/backups/pre-plan-overhaul-2026-11-02`

This plan splits the overhaul into a foundations phase (F), an owner gate (G0), parallel workstreams in isolated git
worktrees (P), an integration phase (I) and a strictly sequential live-test phase (L). Every stream spec below is
self-contained: goal, **exclusive file ownership**, files it may touch minimally (with the note it must leave),
dependencies, steps in test-first order, acceptance criteria (tests and laws that must exist), and gates.

**Revision 2** (2026-11-02) answers the integration critique: the merge order now keeps every merge green (the old
renderer is decoupled from engine-facing types; field removals the old UI reads move to a Phase I removal sweep), every
cross-stream seam is created in Phase F (plan-day clock, surface gate, preflight and requester ports, the protection
predicate, posture, kernel skeletons), PR is split into S1/S2/S2b/S2r with retirements after their last consumer, the
static-timing gate moves to its own agent (F2c) with a real ratchet, boundaries are re-baselined to 100, pre-release
launches use an isolated profile, and the owner answers every behaviour-changing question before Phase P.

---

## 0. How to use this plan

### 0.1 Inputs every agent reads first

1. The spec (normative and self-sufficient). Read §3 (axioms and deviations), §4 (architecture), §14 (contradictions
   resolved), §15 (contracts), §16 (data), §17 (constants), §18.2 (the owner's recorded answers), the section(s) your
   stream implements, and **the spec's Appendix for your area** (A plan/tempo/Boost, B settings/protection + copy,
   C sidebar/boot/feed + copy, D parse + guard lines + copy, E reopen + copy): every full field list, interface, guard
   line and copy deck lives there, reconciled with the spec body.
2. `CLAUDE.md`, `docs/PRINCIPLES.md`, and the ADRs your files cite.
3. **Optional background only**: the five topic designs (derivations, scratch evidence). Nothing an agent needs is
   only there. If the lead provides copies, they sit in the untracked `.overhaul/` folder (excluded through the common
   git dir, F0) and are never committed (they carry account-specific evidence; a test fails if any path under
   `.overhaul/` is tracked). **The spec wins on every conflict.**

### 0.2 Ground rules (all streams)

- **Test first.** Each step: write the failing test (or law), make it pass, refactor, commit. Commit as you go; every
  commit is green on `npm run check` (typecheck incl. tests, `biome ci`, boundaries 0 errors, page bundle fresh, jest,
  `build:dev`). Never commit red to share work.
- **Ownership is exclusive.** You may create files under your owned paths and edit your owned files freely. A file
  listed under "touch minimally" may receive at most the edit described, and the commit body must say
  `minimal-touch: <file> — <why>`. Any other edit outside your ownership is a stop-and-ask to the lead.
- **Phase F seams.** Phase F lands every cross-stream contract (types, IPC rows, migrations, CSS files, status fields)
  and every at-ceiling split, plus **ports with today's behaviour** (for example `TempoSource` = reference,
  `JournalGate` = today's global check, `SurfaceGate` = never paused). Streams replace the implementation behind a port
  in their own files and swap it at their own wiring module. Do not re-shape a Phase F contract without the lead.
- **Line budget** (300 lines per `.ts/.tsx`; `tests/tooling/line-budget.allow.json` may only shrink). Split before you
  grow. Re-seed downward with `node scripts/gen-line-budget.mjs --against overhaul/integration` (it refuses any upward
  entry) in the commit that shrinks a listed file; a file that
  drops to ≤ 300 leaves the list in the same commit. Upward re-seeds are forbidden in streams.
- **Static timing** (spec §20.4). `tests/tooling/no-static-timing.test.ts` + `tests/tooling/static-timing.allow.json`
  (F2c) scan all of `src` except `src/kernel` and `src/renderer`: any numeric literal other than 0/±1/unit multipliers
  in any syntactic position, any property access to a tempo-prior key outside `src/kernel/tempo`, and any
  `Math.random` fail unless allow-listed. The allow-list is a **ratchet**: `node scripts/gen-static-timing-allow.mjs`
  only prunes; when you move an allowed literal (a split, a rename) use `--move <old-key> <new-key>` (the reason
  travels); a new entry is a stop-and-ask to the lead. Keys are `file :: enclosing function/declaration :: callee or
  property :: literal text`.
- **Boundaries.** 0 errors; warnings ≤ **100** from F1a step 0 on (147 before it) and must not grow. Record per-rule
  counts in every commit body (`boundaries: 0 error, N warn (renderer-allow-list a, no-circular b, …)`). New renderer
  files import only `src/renderer/**`, `src/shared/**`, `@/ipc/contract`. New backend modules never import `@/types`
  (the cycle hub). **Every new `src` module has a `src` importer in its own commit** (test-only importers do not count
  for `no-orphans`), **or** an entry in `tests/tooling/pending-wiring.json` naming the stream that wires it; the
  stream that wires a module removes its entry in the same commit; the list is empty at Phase I.
- **Kernel.** `src/kernel/**` imports only kernel siblings and zod. New numbers go in new tier-1 modules with a one-line
  guard comment each; derivations in new `derive-*.ts` modules with laws. Never edit `tests/kernel/legacy-config.snapshot.ts`.
- **Store.** Every store repo, old or new, receives kernel values through `KnowledgeStore` options (`StorePolicy`,
  assembled by main) or method arguments (a plan-day window from `PlanDayClock`), **never by import** (spec §14 C24).
- **Day boundaries.** Anything keyed by "day" reads the `PlanDayClock` port (F2a). Never compute a calendar day, a
  local midnight or a rolling 24 h of your own.
- **Launching the app.** Any launch before Phase L uses the isolated profile (`EPO_USER_DATA_DIR=<fresh temp dir>
  EPO_BLOCK_NETWORK=1`, F1a). Never open the real `<appData>/Epo` before Phase L: the integration build would migrate
  the owner's store past what the installed release can open (`src/store/migrations.ts:16`).
- **Facts stream, verdicts wait; no silent catches; `SHAPE_MISMATCH` never becomes empty/false; IG literals only in
  `src/surface/versions/*` and `src/adapter/versions/*`; never compose a request the web client does not make; neutral
  vocabulary** (no bot/human/emulate/stealth/mimic/spoof/detect/natural in names, comments or copy). Comments ≤ 3 lines,
  present tense, no dates.
- **No live Instagram traffic from any agent.** No `npm run dev/start/livetest/probe/capture/inspect` against a real
  session. `node scripts/background-probe.mjs` (local fixture, zero Instagram traffic) is allowed where listed, and
  visual checks run in the isolated profile only. Phase L is the lead's.
- **Do not touch**: survival layers (CDP input chain, `bootstrap.ts` switches, `backgroundThrottling:false`, focus
  emulation, `powerSaveBlocker`, re-stack concealment), `src/adapter/tab.ts` beyond the Phase F constant import,
  `src/main/window/shell.ts` beyond BL's additive options.
- **Docs.** Draft your ADR(s) in `docs/adr/` with the number allocated in spec §19. Do **not** edit
  `docs/HANDOFF.md` (Phase I only). Release notes are Phase I.
- **Commits.** `type(scope): imperative summary`; body = what and why, bullets, then
  `npm run check green: <N> tests; boundaries 0 error, <M> warn (…); line-budget <entries>`; then any
  `minimal-touch:` lines; then the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

### 0.3 Worktree protocol

```bash
# lead, once (F0):
git switch feat/plan-derived-overhaul && git switch -c overhaul/integration
echo .overhaul/ >> "$(git rev-parse --git-common-dir)/info/exclude"   # once: applies to every linked worktree
# per stream (after the stream's dependencies are merged into overhaul/integration):
git worktree add ../Peanut-wt/<code> -b overhaul/<code> overhaul/integration
cd ../Peanut-wt/<code> && npm ci          # (optional) the lead copies background designs into .overhaul/
# while working: rebase on overhaul/integration when a dependency merges; regenerate generated files, never hand-merge:
node scripts/gen-line-budget.mjs --against overhaul/integration
node scripts/gen-static-timing-allow.mjs --against overhaul/integration
npm run build:page; npm run gen:tokens
# finish: npm run check; push the branch; the lead merges (Phase I order).
```

In a linked worktree `.git` is a file, so a per-worktree `.git/info/exclude` append fails and leaves `.overhaul/`
untracked-but-visible; the common-dir exclude plus `tests/tooling/no-overhaul-files.test.ts` (fails if anything under
`.overhaul/` is tracked) close that. One test run per worktree at a time is fine; never run Electron from a worktree
against the real `userData` (use the isolated profile).

### 0.4 Stream map

| Code | Stream | Wave | Depends on (merged) | Size | Spec |
|---|---|---|---|---|---|
| F0 | Lead setup + the owner-question packet | F | — | 45 min | §18.2 |
| F1a | Splits: engine, main, settings, store; hub edge; isolated profile; F1 seams | F | F0 | 4.5 h | §14 C27–C28, §16 |
| F1b | Splits: adapter, surface, rim, renderer | F | F0 (∥ F1a) | 3 h | §10.3 |
| F2a | Contracts: timing, adapter, engine seams, kernel skeletons | F | F1a, F1b | 5 h | §5.9–5.11, §9.7, §12.9 |
| F2b | Contracts: data, settings schema, protection predicate, posture, IPC, shared, renderer kit | F | F1a, F1b; starts ∥ F2a, merges after it | 6 h | §6.9–6.10, §7.3, §12.3, §15, §16 |
| F2c | The static-timing gate and the ratchets | F | F2a (∥ F2b; seeds after F2b merges) | 3 h | §20.4 |
| G0 | **Owner gate**: every ● question in spec §18.2 answered and recorded | gate | F0 packet | — | §18.2 |
| PC | PLAN-CORE: kernel plan, PlanService, Boost backend | P1 | F, G0 | 5.5 h | §5, §8 |
| PR | PLAN-RUNTIME: S1 one writer · S2 cadence switch · S2b activity clock · S2r retirements | P2 | PC; SC before S2; RO-b and S2b before S2r | 3 h + 5 h + 2 h + 2.5 h | §5.13–5.16, §17 |
| SC | SETTINGS-CORE: model, service, migration, seed check | P1 | F, G0 | 5.5 h | §6, §13 |
| SU | SETTINGS-UI: the Settings stage, Clean up page | P1 (CSS after TK) | F, G0; TK for CSS | 5.5 h | §6.4–6.8, §7.8, §8.6 |
| UD | UNFOLLOW-DECISIONS: (a) protection, (b) journal + verify-at-act | P1 | F, G0 | 4 h + 4 h | §7, §9.7–9.9, §11 F6 |
| RO | REOPEN: (a) store + kernel, (b) the sweep + following check | P1 / P2 | F, G0; (b) PC, BL, UD-b, PR S1 | 4 h + 6 h | §9 |
| PP | PARSE-PIPELINE: (a) hazards + transport, (b) one parser + recovery | P1 / P2 | F, G0; (b) PH corpus | 4 h + 5.5 h | §10 |
| PH | PARSE-CORPUS-HEALTH: corpus, sink, tables, report, UI | P1 | F, G0 | 5 h | §10.7–10.8 |
| CF | CONFIRM: confirm layers, one admission | P1 | F | 3.5 h | §11 |
| BL | BOOT: hidden window, boot sequence, stage controller, menu | P1 | F, G0 | 5.5 h | §12.4, §12.8 |
| LD | LIVE-DATA: activity relay, feed, projections, log ring, updater | P1 | F, G0 | 4 h | §12.9, §13 |
| TK | TOKENS: direction boards (owner sign-off), type ladder, palette, Inter, motion tokens, restyle | P1 | F, G0 | 1.5 h + 4 h | §12.6–12.7 |
| SH | SHELL: stage hosting, People page, tour | P1 (CSS after TK) | F, G0; TK for CSS | 5 h | §12.4–12.5 |
| SB | SIDEBAR: posture, zones, Boost control, splash/intro, Diagnostics | P2 | SH, TK, LD, BL, SU | 6 h | §12.1–12.3, §12.7–12.8 |

At most 12 streams run at once (P1: PC, SC, SU, UD, RO-a, PP-a, PH, CF, BL, LD, TK, SH). P2 streams start as their
dependencies merge. **CF needs no owner answer and may start right after Phase F.** **Critical path:** F → G0 → PC →
PR (S1 → S2 → S2b → S2r) → Phase I. **Live preconditions:** CF and UD-b (F6) merged before the production engine ever
runs again.

Owner labels in the spec map directly to these codes (spec §15.1 "boot (BL)" and "live-data (LD)"; spec §17's
stream column uses the same codes).

---

## Phase F — Foundations

Run first. F1a ∥ F1b (disjoint files), then F2a ∥ F2b ∥ F2c (disjoint files; F2b and F2c merge after F2a because they
consume `TEMPO_KEYS`, `SurfaceGate`, `PlanDayClock` and the threaded call sites). The lead merges in the order F1a,
F1b, F2a, F2b, F2c, regenerating `line-budget.allow.json` after each merge; F2c seeds `static-timing.allow.json` once,
against the merged F2b head. **No behaviour change in Phase F**: every existing test passes unchanged except the pinned
lists Phase F deliberately updates. Phase F lands every contract, seam and skeleton a later stream needs, so that **no
stream imports a type, port or module that another stream creates later** (each case found by the critique is now an F
step: the plan-day clock, the surface gate, the preflight and requester ports, the protection predicate, posture,
`rng.ts`, `settings-policy.ts`, `reentry-policy.ts`, the renderer kit's `onError`, the Boost copy).

### F0 — Lead setup (lead, 45 min)

1. Create `overhaul/integration` from `feat/plan-derived-overhaul`; append `.overhaul/` once to
   `"$(git rev-parse --git-common-dir)/info/exclude"` (§0.3).
2. Record the baseline: `npm run check` (2 225 tests; boundaries 0 error / 147 warn; biome 2 warn).
3. **The owner-question packet** (gate G0): every ● question of spec §18.2 (Q1, Q3, Q5, Q9, Q10, Q13, Q14, Q16, Q17,
   Q19, Q20, Q25, Q28, Q29, Q30, Q37–Q41) in plain words with the default and its consequence (Q5 and Q41 carry their
   numbers). Phase P does not start until the owner has answered; the lead records each answer in spec §18.2 (an
   "Answer" note per row) in one docs commit. A reversed default is applied to the spec before the affected stream
   starts.
4. Optional: copies of the five topic designs (background only; the spec's appendices hold every contract) into
   `.overhaul/` of a worktree that asks for them. Sources for this run (ephemeral):
   `/private/tmp/claude-501/-Users-owengregson-Documents-Peanut/226625ae-1b84-462d-ada4-a75d72f62f4d/scratchpad/design/*--FINAL.md`.
   Nothing breaks if they are gone.
5. Confirm `~/Library/Application Support/Epo/epo-runtime.json` reads `"desired":"stopped"` and leave it so until
   Phase L (spec §22). Back up `~/Library/Application Support/Epo/` (store + both settings files) to the scratchpad.
6. Locate the preserved 2026-11-02 probe outputs (raw bodies) for PH's corpus step; record the absolute path for PH.
   Never copy them into a repo.

### F1a — Splits: engine, main, settings, store (one agent)

**Goal.** Pure moves with re-export shims that give every later stream an exclusive file, and free line budget; the
boundaries hub edge; the isolated-profile launch mode; the F1 seams. No behaviour change. **Every extraction is
verbatim with today's (v1) types**: F1a creates no new interface; F2b re-types the extracted modules in the same commit
that lands their contract types.

**Ownership (create/edit):** every file named below.

**Steps** (one commit per numbered item; each green; re-seed the line budget downward in each):

0. **The boundaries hub edge** (first commit). `src/adapter/tab-ports.ts:11` becomes `import type { ResponseHandler,
   Unsubscribe } from '@/shared/tab-response'` (that module was written for exactly this, its header says so), and
   `src/types.ts` re-exports `TabResponse`, `ResponseHandler`, `Unsubscribe` from it. Measured on a scratch copy:
   `no-circular` 54 → 8, `no-orphans` 8 → 7, total warnings **147 → 100**. From this commit on the "must not grow"
   number is 100 (re-baselined in the commit body), and the module carve-outs below add no cycle (before it, a 4-line
   `engine-actions.ts` alone raised `no-circular` 54 → 56).
1. `src/settings/settings.ts` (593) → `src/settings/v1/settings-v1-types.ts` (the v1 `Settings` interface),
   `src/settings/v1/settings-v1-rules.ts` (helpers, `PATTERN_ALLOWED`, `sanitizePattern`, `RULES`, `AT_LEAST/AT_MOST`),
   `src/settings/v1/settings-v1.ts` (`SETTINGS_KEYS`, `DEFAULT_SETTINGS`, `sanitizeSettings`, `loadSettings`,
   `migrateLegacyPattern`, `saveSettings`), `src/settings/mappers.ts` (the eight `toXConfig`). `settings.ts` becomes a
   re-export shim (leaves the allow-list). `settings-v1-types.ts` is the **frozen** v1 interface the old renderer keeps
   compiling against (`src/types.ts` keeps exporting it as `Settings`) until SU's last commit.
2. `src/main/foundation-wiring.ts` (1934) → extract, with one-line delegates kept, **v1 types only**:
   - `src/main/modules/settings-service.ts`: `getSettings`, `resetSettings`, `updateSettings`, `reloadConfigs`,
     `resolveSettings`, `settingsFilePath` (`:1753-1880`) with today's semantics and signatures, plus `onChange(fn)`
     (fires after today's reload). No `effective()`, `protection()`, `setCapabilities()` or `setPlanPort()` here: F2b
     adds them with their types.
   - `src/main/modules/seed-check.ts`: `checkSeed`, `checkSeedHeld` (`:1648-1712`), today's semantics.
   - `src/main/modules/startup-steps.ts`: `landOnOwnProfile` (`:398-458`) and `restoreRuntimeIntent` (`:1086-1097`) as
     step factories with a local `{name: string, when(), run(signal)}` shape; Foundation still calls them as today.
   - `src/main/modules/prune-control.ts`: `startPrune`, `scanPrune`, `stopPrune`, `pausePrune`, `resumePrune`,
     `maybeRunScheduledPrune` and its watcher (`:631-735`, `:1131-1144`, `:1412-1499`), **and `pruneCandidates`
     (`:620-630`)**, so the read UD annotates sits in a file with an owner. Deps gain `boostActive: () => boolean`
     (default `() => false`), the seam PC's Boost guard uses.
   - `src/main/modules/status-compose.ts`: the `builtStatus()` composition, now `composeStatus(engineStatus,
     contributors, graph, now)` with an empty contributor list (0 net lines in Foundation).
3. `src/main/main.ts` (297) → `src/main/launch.ts` (`createWindow` `:56-177` as `launchWindow(env)`).
4. `src/types.ts` (422): `StageMode` (`:309-314`), `UpdateMode`/`UpdateStatus` (`:357-378`), `LogLevel`/`LogEntry`
   (`:76-88`) become re-exports of `src/shared/{stage-mode,update-status,log-entry}.ts` (make the shared copies
   canonical; verify they are identical first; this removes three orphan warnings).
5. `src/store/knowledge-store.ts` (686) → `src/store/knowledge-store-base.ts` (`KnowledgeStoreBase`: DB open,
   migrations, `assertSchema`, `changed()`/`onMutation`, repo construction as `protected readonly`, the ownPk anchor);
   `KnowledgeStore extends KnowledgeStoreBase` keeps every delegation (public surface unchanged).
6. `src/store/schema.ts` (301) → `src/store/schema/late-migrations.ts` (`LATE_MIGRATIONS = [REENTRY_MIGRATION]`;
   `schema.ts` ends `...LATE_MIGRATIONS`).
7. `src/store/repos/analytics.ts` (319) → `src/store/repos/growth.ts` (`netGrowthSeries`, `netFollowersSince`
   unchanged; the facade delegates).
8. `src/engine/engine.ts` (1103) → `src/engine/engine-actions.ts` (`performAction`, `actChurn`, `actWovenUnfollow`,
   `setActionDeadline` behind an `EngineActionContext`), `src/engine/engine-journal-effects.ts` (the `reconcile` effect
   case and the `ReconciliationRunner` use), `src/engine/engine-sweep-effects.ts` (the `sweep-followback` case).
9. `src/engine/churn-scheduler.ts` (552) → `src/engine/churn-pick.ts` (`nextDue`, ordering, `fresh`, `isRetained`);
   `nextDue(now, kind?: 'follow' | 'unfollow')` with `kind` undefined = today's behaviour. Churn deps gain
   `hasActiveRequest: (pk: string) => boolean` (default `() => false`), the requester seam RO implements and UD and
   RO-a consume.
10. `src/engine/ports.ts` (313) → `src/engine/plan-port.ts` (`EnginePacing`, `EngineRate`, re-exported).
11. `src/engine/engine-facts.ts` (229) → `src/engine/facts-plan.ts` (`pacing` + `action` sources),
    `src/engine/facts-cadence.ts` (the sweep part of `cadence`), `src/engine/facts-journal.ts` (the `reconcile` part).
12. `src/engine/prune-engine.ts` (1262) → `src/engine/prune-scan-guards.ts` (`assertFetchComplete`,
    `assertScanCoverage`, `:1143-1184`), `src/engine/prune-pacing.ts` (run pacing, daily plan, active-hours gates:
    `:476-490`, `:583-588`, `:1190-1197`, `:1240-1246`), `src/engine/prune-feed.ts` (the woven feed:
    `nextCandidate`, `selectPruneCandidate`, `:775-801`).
13. `src/engine/target-pipeline.ts` (435) → `src/engine/resume-target.ts` (`peekResumeTarget`, the pure pick of
    `adoptActiveTargetFromStore`; the method calls it and keeps its writes).
14. `src/engine/rules.ts` (303): move `followbackRule` into `src/engine/lifecycle-rules.ts` (id unchanged; order
    unchanged; `tests/engine/rules.test.ts` green).
15. `src/main/services/graph-builder.ts` (504) → `src/main/services/plan-wiring.ts` (the pacing block `:323-348`,
    read-budget limits), `src/main/services/reopen-wiring.ts` (follow-back watcher, `managedRelationships`, reentry,
    sweep-cadence wiring `:249`, `:279-283`, `:310-321`, `:433`), `src/main/services/surface-wiring.ts` (Reader and
    observer construction), `src/main/services/unfollow-wiring.ts` (churn config, `createMutationPolicy` deps, prune
    whitelist and bio wiring, `:459-472`). `graph-builder.ts` calls them in the same order.
16. `src/main/services/mutation-policy.ts` (141) → `src/main/services/mutation-admission.ts` (`budgetOpen`,
    `beforeMutation`, `onAccepted`, `canAccept`; the reconciliation check behind a `JournalGate` port whose default
    implementation is today's global `reentry` check), `src/main/services/click-review.ts` (`prepareProfile`),
    `src/main/services/own-stats.ts` (`refreshOwnStats`, `resolveIdentity`), **`src/main/services/prepare-mutation.ts`**
    (`prepareMutation`, `:126-139`, verbatim: it calls `reconcileEffects`, `reentry` and `followback().check()`, all of
    which UD and RO replace, so it gets its own UD-owned file); `mutation-policy.ts` composes them
    (`createMutationPolicy` signature unchanged).
17. **The engine harness, split per concern**: `tests/kit/engine-harness.ts` (696) → `tests/kit/engine-harness.ts`
    (the core builder), `tests/kit/harness-plan.ts` (pacing / sweep-cadence fakes, `:404-548` — PR owns it after F),
    `tests/kit/harness-journal.ts` (reconcile / effect fakes — UD), `tests/kit/harness-reopen.ts` (reentry,
    follow-back sweep fakes — RO). The core re-exports them; no test changes.
18. **Isolated-profile launch mode** (`src/main/app-identity.ts`, `src/main/services/ig-session.ts`): `EPO_USER_DATA_DIR`
    is honoured before `app.setName` (`app.setPath('userData', dir)`; the legacy-dir migration is skipped for it), and
    `EPO_BLOCK_NETWORK=1` sets the IG partition's `session.setProxy` to an unroutable proxy. Test: with the env set,
    `app.getPath('userData')` is the temp dir and no file under the default `<appData>/Epo` is touched. Every
    pre-Phase-L visual check uses it; the README of `docs/qa/` (Phase I) documents it.
19. Re-seed the line budget; record the new allow-list in the commit body.

**Acceptance.** All existing tests pass unchanged (except import paths in tests that reached into moved private
symbols, which follow the move); `npm run check` green; boundaries **≤ 100** warnings after step 0 and no new cycle or
orphan after it; every split file ≤ 300 lines; `settings.ts`, `schema.ts`, `analytics.ts`, `ports.ts` and `main.ts`
leave or stay under the budget; allow-list strictly shrinks.

**Gates.** `npm run check`.

### F1b — Splits: adapter, surface, rim, renderer (one agent, parallel with F1a)

**Goal.** T4's S0 splits plus the rim/adapter splits the later streams need. Pure moves; no behaviour change.

**Steps** (one commit per item; re-seed downward):

1. `src/adapter/reader.ts` (485) → `src/adapter/reader-shadow.ts` (`shadow()`, `compareList`, the four comparator
   lambdas as named functions), `src/adapter/reader-relationships.ts` (`relationshipBearing`, `relationshipFacts`,
   `parseShowMany`, `parseFriendshipShow` as functions over the Reader). The class delegates.
2. `src/adapter/versions/2026-08-12.ts` (493) → `src/adapter/versions/2026-08-12.extractors.ts` (lines 129–337 and
   their helpers); the façade assembles `SURFACE`.
3. `src/surface/versions/2026-08-12/literals.ts` (450) → `literals-json.ts` (`JSON_PATHS`, `MUTATION_JSON`),
   `literals-dom.ts` (`SELECTORS`, `ROLES`, `SCOPES`, identity regexes), `literals-signals.ts` (URL/TEXT/refusal
   signatures, `CAPTURE_PATTERNS`); `literals.ts` keeps provenance, ids, URLs, paths, op names, mime and mutation URLs,
   and re-exports the rest.
4. `src/surface/schema/surface.ts` (313) → `src/surface/schema/projection.ts` (fact types, `Projection`, `RowIssue`,
   `ProjectCtx`, `emptyProjection`), re-exported.
5. `src/surface/schema/endpoints.ts` (300) → row/body schemas move to `src/surface/versions/2026-08-12/schemas.ts`;
   `endpoints.ts` keeps the PII vocabulary, `pii()`, `ENDPOINT_KINDS`, `EndpointKind`; `ig-surface.ts`'s duplicate
   `EndpointKind` becomes a re-export.
6. `src/surface/lab/shape.ts` (295) → `src/surface/versions/2026-08-12/scrub-shapes.ts` (`SCRUB_SHAPES`,
   `NOVELTY_SHAPES`); `src/surface/lab/scrub.ts` → DOM pass to `src/surface/lab/scrub-dom.ts`.
7. `src/adapter/ig-surface.ts` (546) → `src/adapter/envelope.ts` (`FetchEnvelope`, `asFetchEnvelope`,
   `envelopeLooksLikeHtml`, pure `classifyEnvelopeWith(env, signatures)`), `src/adapter/mutation-classify.ts` (pure
   `classifyMutationWith`), `src/adapter/surface-types.ts` (result, locate and sentinel types). The new modules import
   **nothing** from `ig-surface` (no new cycle).
8. `src/rim/follow-notifications.ts` (340) → `src/rim/feed-capture.ts` (the `onResponse` capture closure, merge,
   `awaitCaptured`, the captured-state type).
9. `src/rim/list-page-walker.ts` (413) → `src/rim/list-walk-end.ts`: today's end-claim logic (`:276-301`,
   `:344-376`) as a pure `decideStep(…)` with **identical behaviour** (a table test pins today's decisions).
10. `src/adapter/actor.ts` (817) → `src/adapter/actor-scroll.ts` (`scrollNotificationsList`, `scrollFollowersDriven`,
    `MIN_SCROLL_STEP_PX`).
11. `src/renderer/gallery/fixtures.ts` (278) → `src/renderer/gallery/settings-fixture.ts` (`GALLERY_SETTINGS`).
12. Re-seed the line budget.

**Acceptance.** All tests pass unchanged; `build:page:check` unaffected (no `src/adapter/page/*` change); seven
allow-list entries leave; boundaries do not grow; no cycle through `ig-surface`.

**Gates.** `npm run check`.

### F2a — Contracts: timing, adapter, engine seams (one agent, after F1a + F1b)

**Goal.** The tempo registry at identity and its threading into every consumer; the typed live activity; the click
verdict vocabulary; the drawer-read seam; the plan-day clock, surface-gate and preflight seams; the kernel skeletons
several streams need first. After F2a, the plan-backed tempo and the plan-day clock are one-line swaps at wiring, and
no consumer file needs to change for them. (The static-timing gate is F2c's.)

**Ownership:** `src/kernel/tempo/**` (new), `src/kernel/tempo-policy.ts` (new), `src/kernel/motion-roles.ts` (new),
`src/kernel/motion-policy.ts`, `src/kernel/exploration-policy.ts` (new entries only), `src/kernel/rng.ts` (new:
`mulberry32`, `fnv1a`; `src/timing/noise.ts` re-exports them), `src/kernel/settings-policy.ts` (new **skeleton**:
`BOOST`, `KEEP_RECHECK_DOUBLINGS`, `TEMPO_OVERRIDE_MAX_FACTOR`, `MAX_DAYS_OFF`, guard lines; SC owns it afterwards),
`src/kernel/reentry-policy.ts` (new: `MIN_ROWS_PER_PAGE`, `FRONTIER_PAGES_MAX`; RO owns it afterwards),
`src/kernel/census-policy.ts` (new **skeleton**: `CENSUS_POLICY` with today's `coverageFloor` 50 and `scanCoverageMin`
0.85 **moved** from `prune-engine.ts:1163-1164` — they travelled into `prune-scan-guards.ts` with F1a's split, which
now imports them — plus `maxWalkPages` 1 000, guard lines; PP owns it afterwards), `src/engine/prune-scan-guards.ts`
(that import only),
`src/kernel/input-probe.ts` (new: `INPUT_PROBE` derived from `DISPLAY.frameMs`), `src/kernel/plan/types.ts` (new; types
only, incl. `PlanDayClock`), `src/governors/plan-types.ts` (new; types only: `PlanView`, `Admission`, `AdmitRefusal`,
`UsageTally`, `PlanStore`, `PlanServiceDeps`, `PlanPreviewPort`), `src/governors/plan-day-clock.ts` (new: the
local-midnight default `calendarPlanDayClock()`), `src/engine/plan-port.ts` (add `EnginePlan`, `PlanFacts` types —
unconsumed), `src/interaction/{interactor,motion-profile,windmouse}.ts`, `src/adapter/{tab-interactor,actor-scroll,
instagram-adapter,actor-types,activity-reporter,errors,drawer-read(new)}.ts`, `src/adapter/actor.ts` (LiveOp sites
only), `src/adapter/tab.ts` (line 27 only, line-neutral), `src/timing/{config,page-pacing}.ts`,
`src/rim/{profile-visit,list-page-walker,list-walk-types,followers-page-reader,follower-acquisition,feed-capture,
follow-notifications,request-acceptance,profile-enricher,churn-actions}.ts`, `src/engine/{engine,engine-actions,
target-pipeline,target-recovery,churn-types}.ts` (wait bases and the `reviewed` outcome only),
`src/engine/prune-pacing.ts` (park base only), `src/governors/read-budget.ts` (`use` field only),
`src/main/services/click-review.ts` (the two seams of step 9 only), `src/main/foundation-wiring.ts` (the wake-settle
line only), `src/main/overlay/veil-view.ts` (`VeilInfo` type import only), `src/shared/{live-op,click-verdict,
surface-gate}.ts` (new), `src/surface/sink.ts` (new: `SurfaceSink` interface + `MemorySink`),
`tests/kernel/{motion.snapshot.ts,tempo-identity.test.ts,motion-golden.test.ts}`, `tests/kit/tempo.ts` (new).

**Steps:**

1. **Tempo registry at identity.** Write `tests/kernel/tempo-identity.test.ts` first: every `TempoKey` (spec §5.11) at
   `REFERENCE_TEMPO` deep-equals its prior; every RIM/ENGINE/NOISE band and `MOTION` duration key is claimed by exactly
   one spec or listed in `NOT_TEMPO` with a reason; every key has a call site or sits in `PENDING_CONSUMERS`
   (`src/kernel/tempo/pending.ts`: `gap.action`, `check.spacing` until PR/PC; `pause.after-task` leaves the registry in
   S2b with PR's declared touch). Then `src/kernel/rng.ts`, `src/kernel/tempo/keys.ts` (the **28** keys: the 25 of
   revision 1 + `pause.retry`, `pause.wake-settle`, `walk.rest-every`), `specs.ts` (`as const satisfies
   Record<TempoKey, TempoSpec>`: axis `pace | pace-up | motion | depth`, prior, floor, identity), `resolve.ts`
   (`scaleAbove`, the one-sided `pace-up` rule, `resolve`, `drawResolved`), `source.ts` (`TempoSource` incl.
   `enabled(key)`, `REFERENCE_TEMPO`, `referenceTempoSource(launchSeed?)` with one `mulberry32(fnv1a(key) ^ launchSeed)`
   stream per key), `src/kernel/tempo-policy.ts` (`TEMPO_POLICY` incl. `SPEED_ACCURACY_ELASTICITY`, `PLAN_POLICY`,
   `CLOCK_TOLERANCE_MS`, `MIN_SCROLL_STEP_PX`, guard lines), and the skeletons `settings-policy.ts`,
   `reentry-policy.ts` (with `WEEKLY_CYCLE` derived in `derive-reentry.ts` stub).
2. **MOTION snapshot and roles.** Freeze `tests/kernel/motion.snapshot.ts` **before** any `MOTION` edit; add
   `prePressMs` [30, 120], `driftProbability` 0.15, `driftPx` 3, and the initial-cursor bands as **absolute GEOM**
   values `initialCursorXPx` [180, 720], `initialCursorYPx` [160, 560] (the draw happens in the synchronous
   constructor, `interactor.ts:44-51`, before the async `viewport()` at `:179` exists; a viewport-relative fraction
   would need a deferred first draw and change the RNG order — a later PR commit with its own re-baseline), with an
   `ADDED` ledger; `src/kernel/motion-roles.ts` (`MOTION_ROLE` for every key: `tempo | speed-accuracy | shape |
   guardrail | device`; every shape dial with a guard line and provenance); `src/kernel/tempo/motion.ts`
   (`MotionPolicy`, `MOTION_REFERENCE`, `deriveMotion(m)` scaling tempo-role durations by `m` and speed–accuracy keys
   by `m^(−SPEED_ACCURACY_ELASTICITY)` within the guardrails — identity at `m = 1`); `tests/kernel/motion-golden.test.ts`.
3. **Thread the reference tempo (identity).** Add `tempo?: TempoSource` deps (default `referenceTempoSource()`) and
   replace direct band reads: `interactor.ts` (`gesture()` resolved once per gesture: pre-press, hover-settle, drift,
   initial cursor), `motion-profile.ts`/`windmouse.ts`
   (`policy: MotionPolicy = MOTION_REFERENCE` parameter; delete the six import-time constants), `tab-interactor.ts`,
   `instagram-adapter.ts`, `actor-types.ts` (option), `actor-scroll.ts` (`scroll.depth.*`; the depth spread stays
   **off** at identity: spread 0 until PR enables it), `profile-visit.ts` (`dwell.visit`), `list-page-walker.ts`
   (`walk.page`, `walk.rest`, `walk.rest-every`, the fetch retry → `pause.retry`), `followers-page-reader.ts`
   (`scroll.wait.dialog`), `follower-acquisition.ts` (`scroll.wait.acquire`), `feed-capture.ts` /
   `follow-notifications.ts` (`scroll.wait.drawer`, `drawer.close-settle`), `request-acceptance.ts` (`gap.accept`),
   `page-pacing.ts` (`pause.retry`), `foundation-wiring.ts` `reconcileWake` (`pause.wake-settle`; the `Math.random` at
   `:1307-1310` goes), engine wait bases (`park.blocked`, `backoff.walled`, `beat.transient` — `pace-up` axis —,
   `pause.after-task`) in `engine.ts`, `engine-actions.ts`, `target-pipeline.ts`, `target-recovery.ts`,
   `prune-pacing.ts`. The **new** sites (`dwell.before-press`, `ui.step-pause`) get their call sites wired but
   **disabled at identity** (`tempo.enabled(key)` returns false for added keys under `referenceTempoSource`), so
   behaviour is unchanged. `tests/rim/*` at the reference tempo still reproduce today's ranges.
4. **Walker hooks (identity).** `WalkArgs.stopAfterPage?: (page) => boolean` (ends the walk with reason
   `caller-stop`, checked right after the page's rows are written, before any pacing sleep) and
   `WalkArgs.readUse?: ReadUse` passed to `readBudget.consume`; `ReadDebit.use?` optional (the v1 validator ignores
   extra fields); tests for both hooks.
5. **Typed live activity.** `src/shared/live-op.ts` (`LiveOp`, `ActivityInfo {kind, op}`, `VeilInfo`, `LiveTab`,
   `liveOpText`, `toVeilInfo`); convert the seven reporter sites (`actor.ts:117,194,341`, `follow-notifications.ts:149`,
   `profile-enricher.ts:105`, `followers-page-reader.ts:127`, `list-page-walker.ts:119`) line-neutrally; an **identity
   test for Phase F only** pins `toVeilInfo` labels to today's seven strings (SB later replaces both surfaces' wording
   with one `liveOpText` under L-COPY and rewrites that test); `veil-view.ts` takes `VeilInfo` from shared.
6. **Click verdicts.** `src/shared/click-verdict.ts` (spec §9.7); `src/adapter/errors.ts`: `ActionReviewedError
   (verdict)` (not a subclass of `ActionDeferredError`) and `ActionDeferredError(msg, {reason?, until?})`;
   `churn-types.ts`: `ChurnActionOutcome.status` gains `'reviewed'` + `verdict?`; `rim/churn-actions.ts` maps
   `ActionReviewedError` → `{status:'reviewed', verdict}` (no producer yet; a unit test throws one).
7. **Drawer read seam.** `src/adapter/drawer-read.ts`: `readDrawerBody(resp, ctx) → {events, pendingPreview, requests:
   {rows, pendingComplete}, tier, partial, failure?}` delegating to today's extractors (identity: `pendingComplete`
   mirrors today's lenient behaviour, `tier:'canonical'`, `partial:false`); `feed-capture.ts` calls it.
8. **Surface sink seam.** `src/surface/sink.ts`: `SurfaceSink` interface (`record(signal)`, `hint…`), `MemorySink`,
   `NO_SINK`; not yet called (entry in `tests/tooling/pending-wiring.json`, wired by PH).
9. **Plan types, the plan-day clock, the surface gate and the click-review seams.** `src/kernel/plan/types.ts` and
   `src/governors/plan-types.ts` per spec §5.15 (types only, incl. `PlanDayClock`); `src/governors/plan-day-clock.ts`
   `calendarPlanDayClock()` (local midnight; `onRoll` via one timer) — **every** consumer that keys anything by day
   (UD's reconciler day-roll and re-check delays, RO's census window and backfill, PH's `surface_health` day keys, LD's
   feed day groups) takes this port from its wiring module, and PR S1 swaps the plan-backed clock in at
   `plan-wiring.ts`, the one swap site; add `EnginePlan`, `PlanFacts` to `plan-port.ts` (unconsumed).
   `src/shared/surface-gate.ts`: `PausedActivity = 'unfollows' | 'relationship-reads' | 'cleanup' |
   'follow-back-decisions' | 'exploration'`, `SurfaceGate { paused(a: PausedActivity): boolean }`, `NEVER_PAUSED`
   (re-exported later by F2b's `surface-health.ts`). In `click-review.ts`: a `preflight(kind, writer, now, subject)`
   port called **before** the visit whose Phase F default admits (`{ok: true}`: today's checks keep running at
   `beforeMutation`, so behaviour is identical); PR S2 swaps in `MutationCadence.preflight` at `unfollow-wiring.ts`
   (PR's declared touch) — the anti-goal "no read before preflight" has an owner. And a `surfaceGate` dep defaulting to
   `NEVER_PAUSED` (PH swaps the real gate in at `surface-wiring.ts`). Type-only modules must be imported by something in the same commit
   (re-export from `src/kernel/plan/index.ts` imported by `plan-types.ts`, which `plan-port.ts` imports).
10. **Tab probe constants and new policy entries.** Move `tab.ts:351-352` (`10 × 50 ms`) to the derived
    `src/kernel/input-probe.ts` `INPUT_PROBE = { ROUNDS, INTERVAL_MS = 3 × frameMs (rounded to 50 ms) }` — **not**
    registry keys (the golden pins the 119-key registry, so `TAB` cannot absorb them) — re-exported by
    `src/timing/config.ts`, so `tab.ts:27` becomes `import { INPUT_PROBE, RECOVERY, TAB } from '@/timing/config'`:
    **line-neutral** (`tab.ts` sits at its 646 ceiling; `minimal-touch: src/adapter/tab.ts — line 27 import, line-neutral,
    ADR 1007 amendment pending`). Add the new `EXPLORATION_POLICY` entries with **today's values** and guard lines (spec
    §17.6: `ownFollowersPickMax`, `skipPoolFactor`, `maxCoverageFraction`, `maxEnrichPassesPerCycle`, the
    source-utility and frontier-refill numbers, `maxDiscovered`) so PR and SC only switch consumers.
11. `tests/kit/tempo.ts`: `fixedTempo(pace)`, `recordingTempo()` (records every wait key in order; `enabled` true).

**Acceptance.** No behaviour change: every existing timing test green; tempo-identity, motion-golden, walker-hook,
live-op-label, churn-actions-mapping, plan-day-clock and preflight-default tests exist and pass;
`derive-golden.test.ts` unchanged and green; no `Math.random` in `src/kernel/**`; the kernel imports nothing from `src`.

**Gates.** `npm run check`.

### F2b — Contracts: data, settings schema, IPC, shared types, renderer kit (one agent; starts parallel with F2a, merges after it)

**Goal.** (Starts in parallel with F2a on everything that needs no F2a type — migrations, store, IPC tables, the
settings and protection modules — and rebases onto the merged F2a for `settings-params-tempo.ts` (`TEMPO_KEYS`),
`surface-health.ts` (`SurfaceGate`) and the `PlanDayClock` uses.) Every schema, vocabulary, IPC row, push, projection
row, status field, shared type, pure shared module and
renderer scaffold that more than one stream needs, landed once, so streams only add code in files they own — including
the protection predicate (spec §7.3) and posture (spec §12.3), which the settings migration, the settings service, the
boot stream's window title and the sidebar all need before their owning streams merge.

**Ownership:** `src/store/schema/{review-columns-migration,growth-log-migration,surface-tables,surface-migration,
feed-index-migration}.ts` (new), `src/store/schema/{late-migrations,manifest,tables}.ts`, `src/store/types.ts`,
`src/store/rows.ts`, `src/store/repos/{meta,follow-records,effect-intents,growth,reopen-state(new),feed-reads(new),
surface-drift(new),protection-facts(new)}.ts` (skeleton/mapping only), `src/store/knowledge-store-base.ts`,
`src/store/knowledge-store.ts` (fields + plan-state accessors), `src/store/{spans.ts,repos/accounts.ts}` (retention
injection), `src/kernel/store-policy.ts` (new), `src/ipc/{contract,contract-settings,contract-live,contract-plan,
contract-surface,guards,guards-settings,guards-live,guards-plan}.ts`, `src/main/{ipc,ipc-settings,ipc-boot,ipc-live,
ipc-plan,ipc-surface}.ts`, `src/main/modules/{projections,not-built,status-compose,settings-service,startup-steps}.ts`
(the last two: re-typing only), `src/main/services/{graph-types,graph-builder,live-wiring(new)}.ts` (the contributor
and startup-step aggregation only), `src/types.ts` (one import + `extends`), `src/shared/{stage-mode,status-fields,
settings-intent,settings-model,settings-params,settings-params-tempo,settings-view,settings-ops,settings-facts,
seed-check,boost,plan-projection,reopen-view,surface-health,boot,feed,update-status,unfollow-protection,posture}.ts`,
`src/settings/{doc,doc-rules,migrate-v1,migrate-v1-lists,effective}.ts` (new), `src/settings/v1/derive-v1.ts` (new:
`V1_DERIVED`), `src/renderer/styles/{index,fonts,sidebar,boot,people,diagnostics,settings-stage,compatibility}.css`,
`src/renderer/settings/SettingsStage.tsx` (placeholder), `src/renderer/copy/boost.ts` (new; the Boost copy deck from
spec Appendix B/C), `src/renderer/hooks/useKeepAlivePoll.ts` (the `onError` hook), `src/renderer/gallery/{Gallery.tsx,
fixtures-live.ts,fixtures-surface.ts}`, `tests/kit/{render-bridge,store,configs(new),main-harness}.ts`, the pinned tests
(`tests/main/{ipc-guards,projections-registry}.test.ts`, `tests/store/{tables,migrations}.test.ts`),
`tests/tooling/pending-wiring.{json,test.ts}` (new), `.dependency-cruiser.mjs` (reads `pending-wiring.json` as
`no-orphans` exceptions). **Declared touches** (each line-neutral or with an explicit offset in the same commit):
`src/main/foundation-reads.ts` (the exhaustive `RECORD_STATUS: Record<FollowState, GraphNodeStatus>` at `:226` gains
`kept: 'kept'`; the file sits at its 410 ceiling, so the commit joins two short adjacent lines elsewhere in the file as
the offset), `src/types.ts` (`GRAPH_NODE_STATUSES` gains `'kept'`), `src/renderer/graph/palette.ts` (one `kept` entry
in the followed colour family; SH adds the shield glyph later), `src/livetest/steps.ts`
(731 ceiling: `STORE_POLICY` folds into an existing `@/kernel` import and the argument goes inline — line-neutral),
`src/probe/*`, `src/capture/*` (their `new KnowledgeStore(` sites), and the test files listed in step 4.

**Steps:**

1. **Migrations 14–17** (spec §16.1). Test first: `withLegacyDb(13)` → open → `assertSchema` passes; `tables.test.ts`
   pins the generated DDL of `own_counts`, `follower_changes`, `surface_drift`, `surface_health`; append the four modules
   to `LATE_MIGRATIONS` in id order; manifest declarations for every column and table.
2. **Vocabulary** (spec §16.2): `'kept'` (append to `FOLLOW_STATES`), `'retired'`, `'expired'`, `'requests'`;
   `FollowRecord` gains `keptReason?`, `keptMatch?`, `keptAt?`, `recheckAt?`, `parkReason?`, `checkFailures`,
   `followbackAfter?`; `EffectIntent` gains `attempts`, `nextAttemptAt`; row mapping read/write (unused yet). Update
   tests that enumerate states (zero-filled funnels include `kept`; `additionalCountSince` counts `expired`).
3. **Meta keys and repo skeletons.** `META_KEYS` += `planState`, `reopenState`, `followerChangesBackfilledAt`,
   `surfaceMeter`; facade `getPlanState()/setPlanState(raw)` (raw string, validated by PC);
   `tallySince(since)` and `recentMutationTimes(since)` over the ledger union (`rate-governor.ts:71-75` semantics;
   test: equals `actionsToday` on journal fixtures); skeleton classes `ReopenStateRepo`, `FeedReadsRepo`,
   `SurfaceDriftRepo`, `ProtectionFactsRepo`, `GrowthRepo` (wrapping the F1a-moved functions) constructed in
   `KnowledgeStoreBase` and exposed as `readonly reopen`, `feed`, `surface`, `protectionFacts`, `growth`; also expose
   the existing `followRecords` and `effectIntents` repos as public `readonly` fields (UD adds repo methods without
   touching the facade).
4. **Store policy injection** (spec §14 C24): `src/kernel/store-policy.ts` (`RETENTION_MS` 90 d, `SPAN_RING_ROWS`
   50 000, span internals 32/512/100, guard lines) and the `StorePolicy` options object, which also carries every
   kernel bound a store repo will need (`SURFACE_BOUNDS` retention/caps, `driftConfirmThreshold()`, the `LIVE` feed
   windows, `BOUNDS_REENTRY`, `CLOCK_TOLERANCE_MS`) so PH, LD and RO never import the kernel from the store;
   `KnowledgeStore(path, {policy})`. Construction sites: main via `graph-builder.ts`, `src/livetest/steps.ts`
   (line-neutral, see the declared touches), `src/probe/*`, `src/capture/*`, and the 47 `new KnowledgeStore(` sites in
   ≈ 24 test files, which switch to `openTestStore(path?)` from `tests/kit/store.ts` in one mechanical commit (the
   commit body lists every file); delete the two retention literals and the span literals.
5. **IPC tables** (spec §15.1–15.2). Per-topic contract files spread into `CHANNELS`/`IpcContract`; `PUSH` gains
   `settings`, `settingsFacts`, `activity`, `feed`, `stageRequest` (+ `PushContract`); remove `showTab`/`hideTab`
   everywhere; `checkSeed` **keeps today's result shape on the wire** (the renderer's `useSeedCheck.ts:53` reads
   `r.exists`) while its handler runs on a `SeedCheckResult` core and maps it down with `toLegacySeedCheck()` — SU's
   last commit re-types the channel; `pruneCandidates` re-typed to `PruneCandidateView[]` (`protectedBy: null`,
   `bioUnread: false` today; the old renderer only reads the base fields). Guards per topic (`SETTINGS_OPS` zod union
   per spec §6.7 incl. the `migration` op, `SEED`, `QUERY`, `SCOPE`, `PAGE`, `HOURS`, `BOOST_OPTS`, `BOOL`) spread into
   `GUARDS`; update the pinned sorted list. Handler modules `ipc-settings.ts`, `ipc-boot.ts` (`bootRevealed`),
   `ipc-live.ts` (`activityNow`, `feedView`, `logTail`, `setLogStream`, `openLogFolder`, `updateStatus`), `ipc-plan.ts`
   (`startBoost`, `endBoost`, `previewBoost`), `ipc-surface.ts` (`surfaceReport`) with **typed stubs that return their
   fallback values** (or today's behaviour where one exists); spread into `src/main/ipc.ts`. The `setStage` handler
   validates with `isStageMode` and logs `stage: unknown mode refused`.
6. **Projections.** `ProjectionSource` += `settingsFacts()`, `feed()`, `expiresAt?()`; `PROJECTIONS` =
   `status, pruneStatus, chainList, settingsFacts, feed` with a `dedupe` flag on `feed` (implementation may be a
   no-op until LD); not-built shapes (`notBuiltFacts`, `notBuiltFeed`); the pinned registry test.
7. **Status fields and their registration** (spec §15.3, §14 C22). `src/shared/status-fields.ts`; `EpoStatus =
   EngineStatus & StatusFields` (`src/types.ts`: one import line, offset); `EngineStatus.pacing` and `.reentry` are
   marked deprecated-optional (the old renderer reads them; the Phase I removal sweep deletes them); `notBuiltStatus`
   sets `basis:'not-built'` and every optional field `null`. `src/main/services/graph-types.ts`: `BuiltGraph` gains
   `startupSteps: StartupStep[]` and `statusContributors: StatusContributor[]`; **each wiring module returns** its
   steps and contributors (`plan-wiring`, `reopen-wiring`, `unfollow-wiring`, `surface-wiring`, and the new, empty
   `live-wiring.ts` that LD fills), and `graph-builder.ts` aggregates them **once per build** (no global `register()`:
   a rebuild or account switch never duplicates one). `status-compose.ts` reads the current graph's list plus its own
   graph-independent `boot`, `account`, `basis` contributors. `idleStatus` in the kit gains `basis:'built'`; gallery
   fixtures compile.
8. **Shared types and pure modules** (each imported in this commit): `stage-mode.ts` (`STAGE_MODES =
   ['tab','people','graph','prune','settings']`, `isStageMode`), `settings-*.ts` (spec §6.9 and **Appendix B**, which
   holds every field), `seed-check.ts` (spec §13), `boost.ts` (spec §8.5 incl. `'paused'` and the `why` reasons),
   `plan-projection.ts` (spec §5.17 incl. `detail` and `kinds.accept`), `reopen-view.ts` (spec §9.13, Appendix E),
   `surface-health.ts` (re-exports F2a's `SurfaceGate`/`PausedActivity`/`NEVER_PAUSED`; `SurfaceArea`, `AreaState`,
   `SurfaceSummary`, `SurfaceReport` per Appendix D), `boot.ts` (incl. `ig`), `feed.ts` (spec §12.9),
   `update-status.ts` (+ `'unchecked' | 'unavailable'`, `checkedAt`), and two **pure modules** with their laws:
   - `unfollow-protection.ts` (spec §7.3: types, `protectionVerdict`, `compileProtection`, `foldText`,
     `normalizeHandle`; the truth-table and L-PROT tests). UD owns it afterwards (UD wires it; it does not create it),
     and the migration (step 9) and SC's `protection()` use this one implementation.
   - `posture.ts` (spec §12.3: the `POSTURE_RULES` table, `derivePosture`, `postureHeadline`; L-POSTURE). SB owns it
     afterwards (copy and refinements); BL's stage controller uses it for the window title and Dock badge from its first
     commit, so BL never waits for SB.
9. **Settings v2 schema and pure migration** (spec §6.9–6.10). `src/settings/doc.ts` (`SettingsDocV2`,
   `RECOMMENDED_INTENT`, `DEFAULT_DOC`, `MigrationRecord`, `LegacyCarry`), `doc-rules.ts` (coercion ADR 0103 style,
   `satisfies`-linked; never throws), `migrate-v1-lists.ts` (raw-list normalization with counts, through
   `normalizeHandle`/`foldText` from `unfollow-protection.ts`), `src/settings/v1/derive-v1.ts` (`V1_DERIVED`: today's
   derived values at the 30 grid points and the personas, pinned against `tests/kernel/legacy-config.snapshot.ts`),
   `migrate-v1.ts` (`migrateV1(raw, {now, legacyAccountPk})` → doc or `MigrationRefused`; the derived-number rule
   against `V1_DERIVED`; the slower-only rules for gaps, `pruneScan*` and `followbackSweepHours`; the
   `pruneScheduleDays` × cleanup mapping; the list and seed post-conditions; the effective-equality post-condition is
   SC's), `effective.ts` (`EffectiveSettings` per spec §6.9 + `effectiveFromV1(v1)`, which today's engine keeps
   running on and which a refused migration uses). Tests first: `tests/settings/doc-rules.test.ts` (coercion never
   throws; garbage dropped and counted), `tests/settings/migrate-v1.test.ts` (golden fixtures for default/each persona
   incl. **cautious**/custom/numbers-only/messy lists/`pruneScheduleDays` × cleanup (`off`+schedule → `trickle`)/`deep`/
   `lowWater: 40`/hand-edited active hours/`pacingModel:'legacy'`/a faster `pruneScan`/corrupt JSON; laws: protection
   monotone, no list shrinks, idempotent, every default persona → zero overrides).
10. **Re-type the F1a extractions** to their contracts, now that the types exist: `settings-service.ts` gains the spec
    §6.9 interface (`effective()`, `protection()` (compiled from today's v1 lists **with the new predicate**: the old
    follow-back-only semantics are not preserved behind it, spec §7.3), `setCapabilities()`, `setPlanPort()`, `view()`
    returning the transitional view) with v1 internals; `startup-steps.ts` uses `StartupStepName` and `StartupStep`
    from `src/shared/boot.ts`; `status-compose.ts` uses `StatusContributor`. SC then replaces only internals.
11. **Renderer kit.** Stub CSS files appended to `styles/index.css` in the final cascade order (`fonts.css` first;
    then today's order; then `sidebar.css`, `people.css`, `settings-stage.css`, `compatibility.css`, `boot.css`,
    `diagnostics.css`); `src/renderer/settings/SettingsStage.tsx` placeholder rendering today's `SettingsView`;
    `useKeepAlivePoll` gains the `onError` hook (SU's settings pull and SH both use it); `src/renderer/copy/boost.ts`
    (the Boost copy deck, SU-owned afterwards, imported by SB's control); `Gallery.tsx` concatenates scenario arrays
    exported by `fixtures.ts`, `fixtures-live.ts`, `fixtures-surface.ts` (new arrays empty; SH owns `Gallery.tsx` and
    `gallery-bridge.ts` afterwards); `tests/kit/render-bridge.ts` gains every new method (resolving to fixtures) and
    emit channel, `FakeBridgeData` fields for the new pushes; `tests/kit/configs.ts` builds every engine config from
    `DEFAULT_SETTINGS` (so later streams can delete `*_DEFAULTS`).
12. **Pending wiring.** `tests/tooling/pending-wiring.json` + `pending-wiring.test.ts` + the `.dependency-cruiser.mjs`
    hook (spec §20.4): F's own unwired modules (`src/surface/sink.ts`, the settings v2 modules until SC wires them)
    are the first entries.

**Acceptance.** No behaviour change visible to the user; all pinned lists updated deliberately (guards, projections,
tables DDL, migrations); `push-channels.test.ts` green; `view-liveness` green; the old renderer typechecks unchanged
(it still sees the v1 `Settings`, the old `checkSeed` shape and the deprecated status fields); boundaries ≤ the F1
count (no new warnings: renderer files import shared/contract only; every new module is imported or pending); the
settings migration laws and the L-PROT and L-POSTURE laws pass.

**Gates.** `npm run check`.

### F2c — The static-timing gate and the ratchets (one agent, after F2a; parallel with F2b; seeds after F2b merges)

**Goal.** Spec §20.4: the gate that enforces owner item 1, with no syntactic holes and a real ratchet.

**Ownership:** `tests/tooling/{no-static-timing.test.ts,static-timing.allow.json,no-overhaul-files.test.ts}` (new),
`scripts/gen-static-timing-allow.mjs` (new), `scripts/gen-line-budget.mjs` (the `--against` flag), `src/utils/entropy.ts`
(new: the one `node:crypto` entropy root), and — in the seeding commit only — the `?? Math.random` default sites
(`profile-visit.ts:63`, `list-page-walker.ts:91`, `followers-page-reader.ts:90`, `interactor.ts:46`, `primitives.ts:72`,
`page-pacing.ts:12`, `delay-manager.ts:62`, `engine.ts:250`, `recovery.ts:103`, `prune-engine.ts:207`,
`rate-governor.ts:27`, `schedule-manager.ts:131`, `knowledge-store.ts:92` (install entropy now from the entropy root),
`spans.ts:129`, `graph-builder.ts:339`) and the probe/traffic harness sleeps.

**Steps:**

1. The scanner (TypeScript compiler API): scope all of `src` except `src/kernel/**` and `src/renderer/**`; every
   numeric literal other than 0/±1/`kernel/units` multipliers in any syntactic position (call argument, default
   parameter, object-literal property, class field, local/top-level `const`, arithmetic operand, array element);
   property access to every key a tempo spec claims (generated from `src/kernel/tempo/specs.ts`, so new claims are
   picked up) outside `src/kernel/tempo/**`; `Math.random` anywhere. Test fixtures under `tests/tooling/fixtures/` prove
   each position is caught (incl. `ACQUISITION_DEFAULTS {maxCoverageFraction: 0.5}`, `READ_RETRY {base: 2_000}`, a
   default parameter, a class field, `RIM.SCROLL_WAIT_MS` through `import { RIM }`).
2. `gen-static-timing-allow.mjs`: keys `file :: enclosing function/declaration :: callee or property :: literal text`;
   **prune-only** by default; `--seed` (this agent, once, against the merged F2b head) writes every remaining violation
   with `class` (`GEOM` / `HARNESS` / `PENDING`) and a reason ≥ 20 chars — every `PENDING` entry names the stream that
   removes it (e.g. `"PR S2: legacy pacer, deleted with the cadence switch"`); `--move <old> <new>` keeps the reason;
   `--against <ref>` refuses any key absent at the ref. The seeding commit also deletes every `?? Math.random` default
   (injected seeded streams from the launch seed; the store's install entropy from `src/utils/entropy.ts`).
3. `gen-line-budget.mjs --against <ref>`: refuses any upward entry relative to the ref.
4. `no-overhaul-files.test.ts`: `git ls-files -- .overhaul` is empty.

**Acceptance.** The fixtures prove every syntactic position, property access and `Math.random` are caught; the seeded
allow-list passes; the generators refuse growth; `npm run check` green; no behaviour change (the replaced randomness is
statistically identical).

**Gates.** `npm run check`.

---

## Gate G0 — the owner's answers (between Phase F and Phase P)

**Closed 2026-11-02.** The owner delegated the build, so the lead answered every ● question and recorded the answers in
spec §18.3, which wins over any conflicting text. Two defaults were reversed and folded into the spec: **Q5** (Boost
may lift each plan-day's automatic volume up to `automaticDayMax(P0)`; owned by PC's Boost backend and SB/SU copy) and
**Q28** (the user-facing word is **Prune**, not "Clean up": every stream title, page name and copy string below that
says "Clean up" means "Prune"; internal identifiers are unchanged). The final sign-off in I.4 only confirms.

---

## Phase P — Parallel workstreams

Each stream starts from `overhaul/integration` after its dependencies merged, works in its own worktree, commits as
it goes, and hands its branch to the lead. "Owns" is exclusive. "Touch minimally" lists the only edits allowed outside
ownership.

### PC — PLAN-CORE: the kernel plan, `PlanService`, the Boost backend

**Goal.** Implement spec §5 (kernel and governor halves) and §8 (the Boost window, commands, preview, projection) as
pure, tested, **unwired** modules (each listed in `tests/tooling/pending-wiring.json` with `wiredBy: PR`). PR wires them.

**Owns.** `src/kernel/plan/{seed,circadian,volume,gap,tempo,layout,reads,draw,boost,probation,index}.ts` (types.ts from
F2a), `src/kernel/derive-lifecycle.ts`, `src/kernel/derive-reads.ts`, `src/governors/plan-{state,view,service,
projection,preview,boost}.ts`, `src/governors/plan-day-clock.ts` (adds the plan-backed clock beside F2a's default),
`src/timing/tempo-source.ts` (the plan-backed `TempoSource`), `src/settings/plan-intent.ts`,
`src/main/modules/boost-control.ts`, `src/main/ipc-plan.ts` (replace F stubs), `src/shared/{plan-projection,boost}.ts`
(helpers; types from F2b), `src/timing/{circadian,distributions}.ts`, `tests/kit/plan.ts`, `scripts/plan-qc.mjs`,
`docs/adr/0607-the-day-plan-is-the-source-of-timing.md` (draft), `docs/adr/0904-explore-boost-is-a-plan-modifier.md`,
and the tests under `tests/kernel/plan/`, `tests/governors/plan-*.test.ts`, `tests/main/boost-control.test.ts`.
(`src/kernel/rng.ts`, `settings-policy.ts` and `reentry-policy.ts` already exist from F2a; PC reads them.)

**Touch minimally.** `src/kernel/index.ts` (append exports); `src/main/modules/prune-control.ts` (one guard using the
F1a seam: `if (deps.boostActive()) return refused('boost-active')` in `startPrune`/`scanPrune`; PR owns the file).

**Depends on.** F, G0.

**Steps (test first each):**

1. `seed.ts`: `planSeed`, `u`, `z` (Acklam Φ⁻¹) over `src/kernel/rng.ts`; the phase coordinate is install-seeded
   (`u(installEntropy, 'phase')`, spec §5.2). Laws: order independence; `u ∈ (0,1)`; A→B→A; repair is an identity for
   the current window.
2. `circadian.ts`: `intensityAt` (moved; `timing/circadian.ts` re-exports and loses `samplePhaseOffset`,
   `sampleNextSessionStart`), `quietMinute(shape, phase, quietHours)` (masked argmin, ties → centre of the longest run),
   `planDayWindow`, `transitionDay` (every day counter prorated below 23 h, spec §4.4), `massQuantileAt`, `massBetween`.
   Law L9 (DST tiling for `America/Los_Angeles` 2026-11-01 and 2027-03-14; transition 12–36 h). Delete unused
   `distributions.ts` functions.
3. `volume.ts`: day mask (days off ≤ 6), **the day law** (spec §5.4 step 2: `min(lognormal day, band day)` with the
   kept `PATTERN.CYCLE_PLAN_*` band; `automaticDayMax(P0)`), `allocateKinds` (spec §5.7, incl. the accept budget `A`),
   `acceptsPerPass`. Laws L1 (incl. `V ≤ automaticDayMax(P0)` at every grid point and override), L6 (KS against the
   in-test `min(planner volume, cyclePlan)` oracle at every consistency), L12; `day-law.test.ts`.
4. `gap.ts`: `targetMeanMs` (with the slower-only effective overrides), `gapCapMax`, memoized `stationaryMeanGapMs`
   (seeded simulation including Δt = 0 excitation), `solveGapSpec` (closed form / bisect), `drawGapMs`,
   `velocityWakeAt`. Tests: Balanced 303.9 s ± 1 %; τ = 1 reproduces today's planner formula; laws L2, L4.
5. `tempo.ts`: the session tempo draw (σ_pace per consistency; day + session latent; clamp to the beat band;
   `motion = pace^0.5`; `depth = 1/pace`); `mix` and `probation` fields. Law L10 (incl. pace-up keys ≥ prior).
6. `layout.ts`: count, budgets (largest remainder, per-kind spill), λ_eff-strata placement, separation and merge,
   quiet-hours clipping, proration (later re-plans never re-apportion prorated volume), the late-join effective budget.
   Law L5.
7. `reads.ts`: plan reads (spec §5.8 layer 2); `checksPerDayMax`; `censusFollowerPages`, `censusPagesMax` (bounded by
   `CENSUS_POLICY.maxWalkPages` from F2a's `census-policy.ts` skeleton), `censusWalkMax(session)`, the frontier term
   (`FRONTIER_PAGES_MAX` from F2a's `reentry-policy.ts`), `checkSpacingMin` = the slower of override
   and derived; amend `derive-reads.ts` (`ReadDemand` gains `checksPerDayMax`, `censusPagesMax`, `frontierPages`;
   `verifyReserve`; the trailing-backstop totals; no `windowMs`). Law L8 (incl. head walks never spend the census
   term); amended `derive-reads.test.ts` identity values.
8. `probation.ts`: `probationOwed` (≥ one plan-day length **or** a complete plan-day between; law from the spec §20.1
   reentry list); `draw.ts`: `drawDayPlan`, `replanRemainder` (splice), `applyBoost` (spec §8.3) **called as the final
   step of `drawDayPlan` and of every `replanRemainder` path**, with laws L7 (determinism), L13 (every `ReplanCause`),
   L13b (honesty; Σ future never grows), L14/L14b (backlog, multi-day), L15 (census).
9. `derive-lifecycle.ts`: `retryLimit()` (= 3), `coldFailingThreshold()` mapping (= 7), `blockedStreakThreshold()`,
   `driftConfirmThreshold()` re-exports; tests.
10. `governors/plan-state.ts`: `PlanStateV1 {v:1, phaseOffsetHours, plan, boost, upgradeProbation}` validated parse /
    serialize / deterministic repair; one-time `pacing_state` phase migration; `upgradeProbation` set on the first
    `ensure` of any install with a non-empty ledger and no `plan_state` (regardless of `pacing_state`). Tests: round
    trip; corrupt → repair + warn spy; a valid Boost survives repair and its overlay is re-applied; a legacy-model
    install gets upgrade probation.
11. `governors/plan-view.ts` (**pure**): session states, the late-join rule and the effective budget (spec §5.5),
    `R`, `remaining`, `manualOpen`, `admits` (incl. `'journal'` via the injected gate, `'quiet-hours'`, `'day-off'`,
    `'deferred-by-boost'`, `'unconfirmed'`, `kind-spent` at `P0` follows), `checkDue(lastSweepEndedAt)`, `checkLight`
    (own header kept), `censusDue` (the durable per-session predicate, spec §5.8.3), `acceptsAllowed`, `mixDraw`,
    `planDayStartAfter`, `freshSince`, `nextSessionAt` (may be tomorrow's first: pure draw of the next key, cached;
    `null` → parks end at the next boundary). Test: 10 000 random reads never write (store spy).
12. `governors/plan-service.ts`: `ensure` (writes only on spec §5.6 causes), `onSettings` (digest), `onDemand`,
    `startBoost(durationMs)`/`endBoost('user')` (clock rules spec §8.2; one `setPlanState`), `nextEdgeAt`, `tempo()`,
    `dayStart()`, `planDayClock()` (the plan-backed `PlanDayClock`), `previewDays` (the `PlanPreviewPort`),
    `previewBoost(hours)` (incl. `startsSessionNow`, `why`). Tests: late first open; missed sessions forfeit; the open
    session survives stop/start; settings re-plan keeps the seed and the proration; DST; day-shape transition;
    clock-back; Boost back/forward/tampered; **Boost survives a settings change, the plan-day edge and a repair**.
13. `governors/plan-projection.ts`: `projectPlan(view)` → `PlanProjection` (incl. `detail`, `kinds.accept`,
    `day.dayOff` only from the user's days off, `censusHost`); `governors/plan-boost.ts`: `projectBoost(view, now,
    intent)` → `BoostView` (off/on/waiting/**paused** — paused when the window is open and run intent is stopped —,
    `effectiveFrom`, `followsDuring` from the tally, `lastEnded`); `paceLabel` (`relaxed | normal | quick`).
14. `timing/tempo-source.ts`: `planTempoSource(planService, launchSeed)` (open session's tempo, else ambient; per-key
    noise streams; `gesture()` once per gesture with the speed–accuracy co-variation; tempo overrides applied as
    slower-only reference factors, spec §5.11; `enabled()` true for every key). Tests: streams isolated; the launch seed
    changes sequences; motion resolved once per gesture; reference tempo ≡ `referenceTempoSource()` with added keys on.
15. `settings/plan-intent.ts`: `toPlanIntent(e: EffectiveSettings)` and `intentDigest`; tests at every persona point.
16. `main/modules/boost-control.ts` + `ipc-plan.ts`: `startBoost(hours, {alsoStart})` (clamp to
    `SETTINGS_POLICY.BOOST` from F2a's skeleton; typed refusals incl. `nothing-to-shift` and `backlog`), `endBoost()`,
    `previewBoost(hours)`; **`alsoStart` = advance run intent → write the window and re-plan (insertion sees `desired =
    running`) → start the engine** (queued behind the startup gate) — an order test pins it; session insertion keys on
    run intent, never on the engine's state. The `boost` `StatusContributor` is returned for `plan-wiring` to include.
    Tests with fakes.
17. `scripts/plan-qc.mjs`: 28 plan-days per persona × consistency × caution; exit non-zero on any envelope breach or
    any automatic day above `automaticDayMax(P0)`.
18. ADR 0607 (draft; PR finalizes the RETIRED/CHANGED ledgers and tally) and ADR 0904.

**Acceptance.** Laws L1–L15, L13b, L14b and L9 (DST) green; `plan-determinism.test.ts` (L7; the global randomness scan
is F2c's); `plan-service.test.ts` (view never writes; ensure writes only on causes); `gap-model.test.ts`;
`day-law.test.ts`; `derive-reads.test.ts` amended; tempo-source tests; boost-control tests (incl. the `alsoStart`
order); `plan-qc` exits 0. Nothing is wired into the running app yet (every new module is in `pending-wiring.json`).

**Gates.** `npm run check`; `node scripts/plan-qc.mjs`.

### PR — PLAN-RUNTIME: one writer, the cadence switch, the activity clock, retirements

**Goal.** Wire the plan into the running engine in two behaviour-changing merges (spec §5.13: S1 one writer, S2 the
cadence switch), then the activity-clock slice (S2b) and the retirements (S2r, after the last consumer of every retired
key is gone); retire the legacy pacer, the three day boundaries and the RETIRED registry keys; finish spec §17 rows
marked PR. Four sub-merges, each green and separately estimated (3 h · 5 h · 2 h · 2.5 h).

**Owns.** `src/main/services/{plan-wiring,mutation-cadence(new),mutation-admission,mutation-policy}.ts`,
`src/main/modules/{plan-control(new),prune-control}.ts`, `src/governors/{rate-governor,read-budget}.ts`,
`src/settings/{read-allowance,legacy-pacing-migration(new)}.ts`, `src/engine/{pacers,decisions,engine-waits,facts-plan,
plan-mix(new),plan-port,engine-actions,engine,status-projection,status,facts,prune-pacing,target-pipeline,
target-recovery,exploration-policy}.ts`, `src/rim/{ig-activity-clock(new),profile-enricher,follower-acquisition,
own-followers-target-source}.ts`, `src/timing/{session-planner,cycle-plan,action-gap,primitives,noise,page-pacing,
delay-manager,schedule-manager,wait-runner}.ts` (deletions/trim; `schedule-manager.ts:121` is the follow-back sweep
cadence that reads the retired `NOISE.CADENCE_*`), `src/kernel/{derive,policy,overrides,derive-provenance,
registry-changes(new),exploration-policy}.ts`, `src/main/foundation-reads.ts` (runway fallback),
`tests/integration/plan-*.test.ts`, `tests/integration/lifecycle-reachable.test.ts` (after UD-b hands it over),
`tests/kernel/derive-golden.test.ts`, `tests/kit/harness-plan.ts` (from F1a's split), `tests/engine/engine.test.ts`
(named owner; others append test blocks under the union rule), `tests/main/mutation-policy.test.ts` (named owner; UD
appends), `scripts/{timing-qc,motion-qc}.mjs`, `src/tools/readme/live-charts.ts`, the engine/governor/prune tests these
files own.

**Touch minimally.**
- `src/main/services/unfollow-wiring.ts` (UD owns): the `createMutationPolicy` deps gain the plan and `MutationCadence`
  (S1/S2); swap `MutationCadence.preflight` into click review's F2a `preflight` port (S2).
- `src/engine/prune-engine.ts` (UD owns): call `preflight` per candidate (S2); typed `day-done`/`ceiling` refusal ends
  the run; the consumers of `PRUNE_DELAY_FACTOR` (`:105`) and `PRUNE_SCAN_FRESH_MS` (`:113,292`) go in S2 (the census
  freshness becomes the plan's rule) so S2r can retire the keys.
- `src/rim/profile-visit.ts`, `src/rim/list-page-walker.ts`, `src/rim/feed-capture.ts` (PP/RO own): S2b only — one
  `activityClock.spaceEntry()` call at each Instagram-operation entry point (visit, walk page, drawer open). If a hunk
  would grow an at-ceiling file, inject the clock instead through a wrapper at `plan-wiring.ts` (the walker and the
  drawer already take deps objects).
- `src/kernel/tempo/{keys,specs,pending}.ts` + `tests/kernel/tempo-identity.test.ts` (frozen after F): S2b removes
  `pause.after-task` (key, spec, `NOT_TEMPO` entry) and S2 empties `gap.action`/`check.spacing` from
  `PENDING_CONSUMERS` once their consumers land.
- `src/settings/{doc,effective}.ts`, `src/settings/mappers.ts` (SC owns): S2 deletes `legacyCarry`, the
  `@transitional` pacer and prune fields of `EffectiveSettings`, `toPacingConfig` and the delay fields of the
  rate-governor and prune configs. **`src/settings/v1/*` is frozen** (the migration's input pipeline) — S2r's only
  touch there replaces its two `NOISE.CADENCE_*` references with literal copies plus a reason.
- `src/main/services/graph-builder.ts` (BL owns): build the `PlanService` right after the store, before the interactor,
  via `plan-wiring`; swap the plan-backed `PlanDayClock` (S1).
- `src/engine/{status,status-projection}.ts`, `src/main/services/mutation-admission.ts` are PR's own: S2 removes every
  `reentry` use from them (the JournalGate already replaced the global check at UD-b), so RO-b can delete
  `reentry.ts`; `EngineStatus.reentry`/`.pacing` stay deprecated-optional until the Phase I removal sweep.
- No `foundation-wiring.ts` touch for settings: after F1a `reloadConfigs` lives in SC's `settings-service.ts`, and
  `plan-control.ts` subscribes with `settings.onChange`. The runway swap in `foundation-reads.ts` is PR's own file.

**Depends on.** PC (merged). S2 additionally needs SC merged (the v2 document carries `legacyCarry`) and UD-b merged
(the journal gate). S2b needs PP-a's `profile-visit.ts` changes. **S2r needs RO-b and S2b merged** (the follow-back sweep
cadence and the enrich pace — the last consumers of `NOISE.CADENCE_*` and `RIM.ENRICH_PACE_*` — are gone). PH's surface
gate plugs into the F port; its absence does not block PR.

**Steps:**

*S1 — one writer (pace unchanged):*
1. Integration tests first: I4 (N status reads leave `plan_state` byte-identical), I5 (restart mid-session), I8 (a 6 h
   close → expiry and proration; Start between sessions parks).
2. `plan-wiring.ts`: construct `PlanService` (deps from the store, live `EffectiveSettings` → `toPlanIntent`, the
   demand provider incl. `pendingRequests`/`acceptsRecent`, `lastMutationBefore`, `outsideSince`, the journal gate
   port), the plan-backed `TempoSource` **not yet** swapped in (S1 keeps the reference tempo); **swap the plan-backed
   `PlanDayClock` in** (the one swap site for every day-keyed consumer); return the `plan` and `boost` status
   contributors; hand the `PlanPreviewPort` to `settings.setPlanPort()` and set `capabilities.plan`; remove PC's modules
   from `pending-wiring.json`.
3. `plan-control.ts`: `ensure` triggers (graph build, the edge timer through `ScheduleManager`, resume,
   `settings.onChange`, census completion, Boost commands); `onChanged` pushes status and wakes plan parks.
4. `rate-governor.ts`: `dayStart()` = `plan.startsAt`; `plannedToday` = the plan's `V` (today's law, so the
   automatic-day bound is unchanged); `remainingToday` from the plan; `timing/cycle-plan.ts` deleted (its draw lives in
   the plan).
5. `facts-plan.ts`: `pacing` source → `PlanFacts` via `plan.view(now)` (ensure only if provisional); session and
   ceiling parks exact (a `null` `nextSessionAt` parks to the next boundary); the legacy floor stays (`beforeMutation`
   still stamps `now + rate.nextDelayMs()`; the engine arms `max(store, actAt + gap(τ = 1))`).
6. `status-projection.ts` pure (no planner calls); `status.plan` via the contributor; `status.pacing` stays
   deprecated-optional (the old renderer reads it).
7. Delete `timing/session-planner.ts` (leaves the allow-list). Merge checkpoint **S1**.

*S2 — the cadence switch (one merge; spec §5.13 list):*
8. `tests/integration/plan-rate.test.ts` (I1) **first**, red against S1 for the right reason (incl. the
   `automaticDayMax` and day-law-oracle assertions); then I2, I3, I6, I7, I9, I10, I11, I12, I13.
9. `mutation-cadence.ts`: `preflight` (before any visit; typed `Admission` with `until`; consults the journal gate with
   the subject; `day-done` once `used.auto ≥ V`), `armAtDispatch` (re-check + GapSpec draw + persist),
   `acceptPassEnded`, `manualOpen`; `mutation-admission.ts` uses it and loses every `reentry` use; `budgetOpen` loses
   `atOperatingRate`; accepts: one deadline per pass with `acceptsAllowed` inside the accept budget; swap `preflight`
   into click review at `unfollow-wiring.ts`.
10. `engine-actions.ts`: serve the owed remainder, act, wait on the deadline armed at dispatch; delete the
    `Math.max(store, actAt + pacer.noteAction)`; **the unconfirmed-actions breaker** (spec §11.1 F7: the per-kind
    `unverified` streak, unavailability at `driftConfirmThreshold()`, counting toward `BLOCKED_STREAK_ENTRY` from then
    on; CF's `unverified` cause feeds it) and its `actionsUnconfirmed` status contributor; `pacers.ts`/`decisions.ts`:
    `pacingVerdict` over `PlanFacts` (exact ceiling, session, velocity-window and read-budget parks); delete
    `LegacyPacer`, `legacyVerdict`, `msUntilActiveWindow`, `pruneCycleStart`, `pruneDailyPlan`; `engine-waits.ts`: remove
    `engine:active-hours-park` and the `'daily-boundary'` class, make the ceiling and read-budget parks `exact`, the idle
    base per spec §5.16 (future events only, perception floor); update the noise-registry key lists.
11. `plan-mix.ts` in the `action` source (spec §5.7): `nextDue(now, kind)`, `admits`, `u('mix', s, k)`, the run-time
    transfers (follows ≤ `min(F + slack, P0 − followsDoneToday)`; accepts never from the unfollow share); unfollow work
    unavailable under Boost / protection paused / `SurfaceGate.paused('unfollows')` / the cleanup cool-down / the
    breaker; new-source follow work unavailable under `SurfaceGate.paused('exploration')`; delete the engine's seeded
    weave draw. Re-baseline seeded engine tests once, with a written diff in the commit body.
12. `prune-pacing.ts`: delete the legacy pace, daily plan and active hours; the run uses `preflight` and the shared
    deadline; pre-visit deferrals never mark a candidate visited (spec §9.7; the run test is UD's); `prune-control.ts`:
    delete the scheduled watcher, `pruneScheduleDays`/`pruneLastRunAt` reads and launch jitter (spec §14 C14); the
    `PRUNE_DELAY_FACTOR`/`PRUNE_SCAN_FRESH_MS` consumers in `prune-engine.ts` (declared touch).
13. `read-budget.ts` + `read-allowance.ts`: plan-day accounting **plus the trailing-24 h backstop** (`resumeAt` =
    max(boundary, trailing expiry)); `use` tags; `verifyReserve`; the plan explore sub-limit; the census and frontier
    terms from the own header; `checkSpacingMin` from the slower of override and derived.
14. Settings (engine-facing side only, spec §5.13 item 8): delete `legacyCarry`, the `@transitional` pacer fields and
    `toPacingConfig`; `legacy-pacing-migration.ts` applies the clockwork/trickle mapping once with the notice, and
    `migrate-v1` calls it for v1 files migrated after S2. The old renderer is untouched (frozen v1 `Settings`).
15. Swap the plan-backed `TempoSource` in at `plan-wiring.ts`; enable the added sites (`dwell.before-press`,
    `ui.step-pause` incl. the confirm layers) and the scroll-depth spread; set `capabilities.tempo`.
16. Remove the allow-list entries the switch retired (`node scripts/gen-static-timing-allow.mjs`); merge checkpoint
    **S2**.

*S2b — the activity clock:*
17. `ig-activity-clock.ts` (`lastEndAt`, `noteEnd`, `spaceEntry`), wired before every IG operation (visit, walker,
    drawer — the declared touches or the wiring wrapper); stop consuming `pause.after-task` (key removed, declared
    touch on `src/kernel/tempo/**`); delete the enrich pace in `profile-enricher.ts` (`:194-199`; a non-ok sentinel
    ends the pass). Merge checkpoint **S2b**.

*S2r — retirements (no behaviour change; after RO-b and S2b):*
18. `src/kernel/registry-changes.ts`: the `RETIRED` ledger (the 18 keys of spec §5.12) **and** the `CHANGED` ledger
    (`{path, from, to, adr}` for any registry key, grid point, persona or profile); every golden test (registry, grid,
    personas, profiles, deliberate changes) computes `snapshot − RETIRED ⊕ CHANGED`; delete the retired rows from
    `derive.ts`/`policy.ts`/`overrides.ts`/`derive-provenance.ts` (incl. `NOISE.CADENCE_SIGMA`,
    `NOISE.DAILY_BOUNDARY_JITTER_MAX_MS`, `jitterBoundary`, `POLICY.BACKOFF_BAND`); the reviewed tally **derived 40 /
    policy 34 / override 16 / harness 11**; the frozen v1 rules get literal copies of the two cadence bounds with a
    reason; name the unnamed `derive.ts` literals (spec §17.3; values unchanged); apply `coldFailingThreshold()` (7,
    removing the advisory override); add the applied `PRUNE.CONSECUTIVE_FAIL_HALT` override; move the
    `EXPLORATION_POLICY` additions (spec §17.6) into their consumers; target-pipeline: enrich batches
    `min(profilesPerSlice, explore left)`, skip-pool factor, read-deferral and bootstrap/chain-retry exact parks; the
    revisit and freshness windows through `planDayStartAfter` (spec §5.16).
19. Cautious floor 60 → 70 s in its **own commit** after the ledger (owner Q11): remove the
    `CAUTION.cautious.floorSeconds` override and record the grid point and persona in `CHANGED`; ADR 0606 amendment line.
20. Finalize ADR 0607 (RETIRED/CHANGED ledgers, tally) and the amendments 0202, 0204, 0211, 0212 (deadline drawn at
    dispatch; preflight before the visit), 0605 (pointer), 0901 (executed). Merge checkpoint **S2r**.

**Acceptance.** I1–I13 green (I1 incl. `automaticDayMax` and the day-law oracle); the lifecycle-reachable checkpoint
test green at every PR merge; the noise-registry and rules tests updated deliberately; `derive-golden` computes from
`RETIRED ⊕ CHANGED` with the reviewed tally; tempo-identity still green at the reference; no `Pacer`/`LegacyPacer`/
`cyclePlan`/`session-planner` left; static-timing allow-list shrinks by every PR entry; boundaries do not grow;
`plan-qc` green.

**Gates.** `npm run check`; `node scripts/plan-qc.mjs`; `node scripts/background-probe.mjs --soak-ms 10000` after S2b.

### SC — SETTINGS-CORE: model, service, migration, seed check, facts

**Goal.** Spec §6 (main side), §7.3 predicate data source (`protection()` compiled from the v2 document with F2b's
predicate), §13 (seed status and check). The running app moves to the v2 document behind the transitional v1 adapter;
the old renderer keeps working (frozen v1 types) and finally shows honest save failures.

**Owns.** `src/kernel/{settings-policy,derive-envelope,derive-schedule,derive-audience,catalog}.ts`
(`settings-policy.ts` from F2a's skeleton), `src/settings/{resolve,params,params-pace,params-lifecycle,params-audience,
params-tempo,view,view-options,basis,ops,ops-protection,persist,v1-adapter,doc,doc-rules,migrate-v1,migrate-v1-lists,
effective,mappers}.ts`, `src/settings/v1/*` (frozen; PR S2r's literal-copy touch only), `src/settings/settings.ts`
(shim), `src/main/modules/{settings-service,settings-reload,settings-facts,seed-check,protection-linker}.ts`,
`src/main/ipc-settings.ts`, `src/store/repos/protection-facts.ts`, `src/engine/{scorer,chain-controller,
source-frontier,scanner}.ts` and `src/rim/target-discovery.ts` (defaults and policy moves only; `SCANNER_DEFAULTS`
deleted, `SCORER_DEFAULTS`/`CHAIN_DEFAULTS` one declaration each), the tests under `tests/settings/`,
`tests/kernel/{settings-policy,derive-envelope,derive-schedule,derive-audience,catalog}.test.ts`,
`tests/main/{settings-service,bookkeeping,seed-check,settings-facts,ipc-settings,settings-recovery}.test.ts`,
`docs/adr/{0105-settings-v2,0608-settings-envelope-rule}.md`.

**Touch minimally.** `src/main/foundation-wiring.ts` (construct the v2 service from `userDataDir` + `knowledgeDbExists`
+ push; `restartFromSeed` → `settings.apply([{op:'seed'}], 'system')`; `onIdentityChanged` drops the stamp write;
`busyDriverReason()` → null calls `seedCheck.onTabFree()` — BL owns the file); `src/ipc/contract.ts` (only if a §6.9
type needs a re-export).

**Depends on.** F, G0.

**Steps:**

1. Kernel modules with laws (spec §6.2): `SETTINGS_POLICY` (completes F2a's skeleton), `SETTINGS_GUARDS` (guard-line
   structural test), `ENVELOPE` (min/max over the 30-point grid **and** the plan's briskest draws: slower-only timing
   rows, `checks.everyHours ≥ 0.85 h`; L-ENV), `burstFloorSeconds`, `riskRung`, `shareOfLowWall` (from
   `automaticDayMax(P0)`), `typicalDayRange` (the day law's p10/median/p90), `deriveQuietHours` (pinned per shape),
   `hourlyIntensity`, `sessionMassMasked`, `feasibility`; `audienceCurve`, `audienceRange`; `catalog.ts` (every
   exported kernel tier-1 entry with tier, provenance and guard line, for Under the hood; `catalog.test.ts` asserts
   completeness). `tests/settings/intent-vocabulary.test.ts` (shared tuples = kernel keys).
2. `params*.ts` (the 26 specs of Appendix B + `tempo.*` rows generated from `TEMPO_KEYS` minus `gap.action`,
   `check.spacing`; the gap rows on the effective scale, spec §5.10; `TOPO_ORDER` acyclic) and `resolve.ts` (spec §6.1
   algorithm). Tests: identity at all grid points; containment; restore; persistence; coupled invariants; chaining;
   stale flag; every timing override only lengthens.
3. `ops.ts` / `ops-protection.ts`: `applyOps(doc, ops, ctx) → {doc, adjustments, inverse}`. Laws: idempotent scalars;
   Undo restores; commuting list ops; `protect-link`/`consume-bookkeeping` refused for `user`; reset never touches
   seed/protection/prefs/app; `daysOff` ≤ 6.
4. `persist.ts` (injected fs): write order copy → tmp → fsync → rename → dir fsync; the `.created` marker on the first
   write; **every read-protocol row of spec §6.6 in its order**, incl. "v2 missing with evidence of a previous v2 →
   `.bak` or `remigrated-from-v1`, `needs-review`"; quarantine naming.
5. `settings-service.ts` v2 internals (behind the interface F2b typed): construction-time read/migrate (the
   effective-equality post-condition added to `migrate-v1.ts`); **refusal recovery** (spec §6.10: in-memory state from
   `effectiveFromV1(v1)` + raw-list protection + `dryRun` carried; `migration-pending` refusals except the `migration`
   and `ui` ops; `acknowledge-protection` refused until a successful migration; no v2 written; retried at the next
   launch); the `migration` op (`retry`, `start-from-recommended`, `remigrate-from-v1`); `apply` persist-first → commit
   → change event → push `epo:settings`; `preview` (pure); `basis()` (incl. the catalog); capabilities; `setPlanPort`;
   `protection()` compiled from the v2 document with F2b's `compileProtection`; the bookkeeping carry
   (`consume-bookkeeping` after RO seeds `reopen_state` — expose `takeBookkeeping()` for RO); the older-build union
   import. `settings-reload.ts`: diffed `applyConfig`. Tests: forced write failure → `not-saved`, no reload/push/
   re-plan; one push per success with `rev+1`; `settings-recovery.test.ts` (refusal keeps practice mode, writes no v2
   after any user op, keeps unfollows paused; v2 deleted with `.bak` present → `restored-from-backup` + `needs-review`).
6. `v1-adapter.ts` and the transitional `getSettings/updateSettings/resetSettings` handlers (failures rethrow;
   `toV1Settings` typed as the frozen v1 `Settings`, filling fields the engine no longer has from frozen v1 defaults).
7. `view.ts` / `view-options.ts` / `basis.ts`: `SettingsView` (options for every choice — card numbers from the day
   law's median at the user's consistency —, typical day, params with today's effective values beside the gap rows,
   reads incl. the backstop, notices) cached per rev; deterministic for a fixed doc and clock; capability hiding.
8. `seed-check.ts` typed + queued (spec §13): never at launch; store-fresh (one weekly cycle of plan-days) →
   `fromStore` without a visit; a visit consumes a profile read permit; every busy reason → `queued`, logged; runs once
   on `onTabFree()`; the `SEED` guard; the wire keeps today's shape through `toLegacySeedCheck()` until SU's last commit.
9. `settings-facts.ts` + `protection-facts.ts` repo (followed rows, per-word counts with the folded matcher, kept
   counts, suggestions by prefix with `LIMIT`, the census `tooLarge` flag); not-built shape uses `loading`/`null`, never
   zeros; push on settings change and on store mutation.
10. `protection-linker.ts` (throttled `onMutation` → `protect-link` system ops only on change).
11. `ipc-settings.ts` handlers replace the F stubs; `scorer.ts`/`chain-controller.ts` read `SETTINGS_POLICY`
    (`SCORER_DEFAULTS`, `CHAIN_DEFAULTS` reduced to one declaration each); `scanner.ts`: `SCANNER_DEFAULTS` deleted
    (tests use `tests/kit/configs.ts`); switch the source-utility literals of `source-frontier.ts`,
    `src/rim/target-discovery.ts` (`MAX_DISCOVERED`, `:26`) and `chain-controller.ts` to the `EXPLORATION_POLICY`
    entries F2a added.
12. ADRs 0105 and 0608; amendment 0103.

**Acceptance.** All spec §20.1 settings laws (L-ENV incl. slower-only timing rows; L-MIG incl. every default persona →
zero overrides and refusal recovery); `persist.test.ts`; the service and recovery tests; `seed-check.test.ts` (no hold
before user input at launch); `ipc-settings.test.ts` (malformed op → typed `refused`; handler throw → `refused`; never
`saved`); the pinned guard list; a v1 file migrates at first launch with zero overrides and the notices queued; the
old renderer still typechecks.

**Gates.** `npm run check`.

### SU — SETTINGS-UI: the Settings stage and the Clean up page

**Goal.** Spec §6.4–6.8, §7.8 (Protection UI and the Clean up page changes), §8.6 (the Boost preferences section — the
only place to choose the Boost length), §13 seed field copy; the Advanced "Today's plan in detail" block and the
generated Under the hood. Delete the old settings UI and the transitional adapter in the last commit, which also
re-types `checkSeed`.

**Owns.** `src/renderer/settings/**` (replaces the F placeholder), `src/renderer/hooks/{useSettingsView,
useSettingsFacts,useSettingsCommit,useSuggest}.ts`, `src/renderer/ui/{RadioCards,TimeSelect,DayChips,TokenList,
SaveStatus}.tsx`, `src/renderer/copy/boost.ts` (from F2b), `src/renderer/styles/settings-stage.css`,
`src/renderer/gallery/settings-fixture.ts` (+ settings scenarios), `src/renderer/views/PruneView.tsx`,
`src/renderer/cards/prune/*`, and the tests `tests/renderer/{settings-stage,seed-field,protection-section,
settings-search,plan-detail}.test.tsx`; deletions: `src/renderer/views/SettingsView.tsx`, `src/renderer/cards/settings/*`,
`src/renderer/hooks/{useSettingsDraft,useSeedCheck,useSettings}.ts`, `src/renderer/lib/{strategy-presets,
settings-derive}.ts`, `src/renderer/styles/settings.css`, `src/settings/v1-adapter.ts` (SC hands it over for
deletion), `tests/renderer/{settings-autosave,behavior-pacing}.test.ts` (the latter imports
`cards/settings/BehaviorCard`), and each of `src/renderer/ui/{Slider,DualRange,NumberInput,Chips,CollapsibleCard,
Segmented}.tsx` that no remaining `src` file imports after the deletion (checked in the commit: grep, then delete;
the overview-only ones go with SB); `docs/adr/1011-the-settings-stage.md`.

**Touch minimally.** `src/ipc/contract.ts`, `src/main/ipc.ts`, `src/ipc/guards.ts`, `tests/kit/render-bridge.ts`,
`tests/main/ipc-guards.test.ts`, `src/main/modules/seed-check.ts` (last commit only: remove the three transitional
channels and the `updateSettings` guard; re-type `checkSeed` to `SeedCheckResult` and delete `toLegacySeedCheck`);
`src/types.ts` (last commit: the frozen v1 `Settings` export goes when its last renderer reader goes);
`src/renderer/styles/index.css` (remove the `settings.css` `@import` line only); `src/renderer/app/shell-context.ts`
(add `settingsViewSignal`, `settingsFactsSignal` if SH has not; SH owns).

**Depends on.** F (types, placeholder, fixture, the `onError` hook, the Boost copy), G0. CSS work after TK merges. Real
behaviour against SC; build against the fixture and the fake bridge until SC merges.

**Steps:**

1. Gallery scenarios first (`settings-easy`, `settings-advanced`, `settings-not-saved`, `settings-needs-review`,
   `settings-migration-refused`, `settings-override-conflict`, `settings-infeasible`, `seed-queued`,
   `boost-unavailable`, `plan-detail`) and the fixture-freshness test (`buildSettingsView(DEFAULT_DOC)` at a fixed clock
   deep-equals the fixture). They render the owner-approved direction boards of TK step 0.
2. `change-queue.ts` (framework-free, spec §6.8) with tests: sequential sends, coalescing, revert on `not-saved`,
   older-rev pushes ignored, pending overlays re-applied.
3. Stage shell: `SettingsStage`, `SettingsHeader` (mode switch, search, save status), `SectionRail` (scroll-spy,
   status dots), `ExpectPanel` (today from `status.plan`, typical/week from the view; hover deltas without IPC),
   `Notices` (incl. the migration-refused recovery sheet: Retry / Start from recommended).
4. The seven Easy sections and their rich fields (`SeedField`, `QuietHoursField`, `PeopleList`, `WordChips`,
   `CleanupConfirm`, `ResetConfirm`, `AtLimitConfirm`) with the one-word-per-concept labels (spec §6.4: Gentle ·
   Balanced · Faster without a per-hour figure; Even · Typical · Varied; a few a day · more each day; "Accept follow
   requests automatically" under Who to follow; day-off chips ≤ 6); copy tables (`copy/*.ts` with `satisfies`).
5. Advanced: `FineTune`, generic `ParamRow`/`ParamControl`/`CurveEditor`/`Provenance` (gap rows show today's effective
   value beside the override), `KeptTable`, `BasisTable` (the generated Under the hood catalog), **`PlanDetail`** ("Today's
   plan in detail" from `status.plan.detail`: per session start/end, kind budgets, pace, gap target/median/floor/cap,
   dwell and motion factors, read buckets; per day window, quiet minute, caps, accepts per pass); the five Advanced-only
   sections (Timing hidden until `capabilities.tempo`; Diagnostics hosts SB's panel and PH's compatibility panel via
   their exported components); "Start over from the older version's settings" (the `migration` op, with a confirm).
6. Search (`search.ts`, pure; every v1 key maps to a synonym or a documented deletion — test).
7. Clean up page (spec §7.8): read-only protection tile with a deep link; schedule card, daily-limit and scan-pacing
   steppers removed; "Today's cleanup allowance" read-only; annotated candidates ("Show protected (N)", shield badge);
   the "too large to check in full" state; "Unfollow these gradually" / "Run now"; the silent catch in
   `PruneView.tsx:98-108` removed.
8. Accessibility (radiogroups with roving tabindex, `role="switch"`, labelled `combobox`, live regions, 2 px focus
   ring, 200 % text zoom, no `--faint` text) and motion (card settle, number tickers, save-status crossfade, first-open
   stagger) per spec §6 and Appendix B.
9. Last commit: delete the old settings UI, the hooks, the dead libs and orphaned UI atoms, `settings.css` (and its
   `@import`), the transitional adapter and its channels; re-type `checkSeed`; ADR 1011.

**Acceptance.** `settings-stage.test.tsx` (one apply per card click; revert + inline error on `not-saved`; Undo sends
`inverse`; mode switch sends only a `ui` op; capability hiding; custom pace state; conflict buttons; at-limit
acknowledgement; cleanup confirm; reset diff with loosening lines highlighted; the refused-migration sheet sends only
`migration` ops); `seed-field.test.tsx` (**zero `checkSeed` on mount**; every status maps to its copy; queued/unreadable
never invalid); `protection-section.test.tsx` (typeahead add, paste, remove → Undo, **no remove-all control**, facts
null → "—"); `plan-detail.test.tsx` (every detail field renders; no digit from a not-built projection);
`view-liveness` extended (a `settings` push and a `settingsFacts` push each move a rendered value with no pull); gallery
covers every scenario; boundaries: deletions remove warnings, new files add none, no orphan left behind.

**Gates.** `npm run check`; `node scripts/background-probe.mjs --soak-ms 10000` (stage-hidden scenario); visual checks in
the isolated profile.

### UD — UNFOLLOW-DECISIONS: (a) protection on every path, (b) journal + verify-at-act

**Goal.** Spec §7 (engine side), §9.7–9.9 (verify-at-act, the per-account journal, parks, requesters) and U06 F6. One
stream because every piece edits the churn scheduler and the click review; it runs as two phases with a merge
checkpoint between them. **UD-b (F6) is a live precondition.** UD **wires** the protection predicate F2b created; it
does not create it.

**Owns.** `src/shared/unfollow-protection.ts` (from F2b), `src/shared/click-verdict.ts` (from F2a),
`src/engine/{protection-port,protection-gate,protection-reconciler,click-verdict,journal,churn-scheduler,churn-pick,
churn-types,prune-candidate,prune-feed,prune-engine,rules,lifecycle-rules,rules-prune,engine-journal-effects,
facts-journal,recovery-healer}.ts`, `src/kernel/derive-parks.ts`, `src/rim/{journal-settlement(new),churn-actions}.ts`,
`src/main/services/{click-review,unfollow-wiring,prepare-mutation}.ts`, `src/store/repos/{follow-records,
effect-intents}.ts` (new methods), `tests/kit/harness-journal.ts`, `tests/engine/prune-engine.test.ts` (named owner;
others append under the union rule), `tests/integration/lifecycle-reachable.test.ts` (creates it; PR keeps it green),
the tests for these files, `docs/adr/0214-protection-covers-every-unfollow.md`; deletions: `src/engine/{
reconciliation-runner,prune-whitelist,prune-bio-filter}.ts`, `src/shared/prune-whitelist.ts`, and their tests.
**Not UD's deletions** (they have consumers in RO's watcher and wiring until RO-b): `src/engine/
reconcile-followback-cohort.ts`, `src/rim/managed-relationships.ts`, `src/rim/effect-reconciliation.ts` — UD-b stops
importing them from every UD-owned file; RO-b deletes them in its watcher-rewrite commit, when nothing imports them.

**Touch minimally.** `src/engine/engine-waits.ts` + `tests/timing/noise-registry.test.ts` (remove the
`engine:reconcile-backoff` key, class and park reason; PR owns); `src/main/modules/prune-control.ts` (the
`pruneCandidates` read F1a moved there: annotate rows with `protectedBy`/`bioUnread` from `protectionVerdict`; PR owns);
`src/engine/facts.ts` (`CadenceFacts.reconcile` → `journalDue`; **`PruneFacts.whitelist` → `PruneFacts.protection`**, a
verdict over stored facts for the prune-run mode rule P10; PR owns); `src/engine/engine.ts` (remove the
`ReconciliationRunner` field/construction; PR owns); `src/engine/ports.ts` (`reconcileEffects?` → `settleJournal?`; RO
owns); `src/main/services/graph-builder.ts` (only if an import of a module UD stops using remains after F1a's split; BL
owns); `src/settings/effective.ts` (last commit: delete `pruneWhitelist`/`pruneBioFilterWords` — the old renderer reads
the v1 `Settings`, not this type; SC owns); `src/main/foundation-wiring.ts` (`unfollowOne` typed `protected` refusal
through `click-review`; BL owns); `src/settings/mappers.ts` (`toChurnConfig` passes `rotateMutuals`, drops
`bioKeepWords`; SC owns).

**Depends on.** F, G0. Reads the plan through the F2a `PlanView` interface (fakes in tests) and the `PlanDayClock` port
(the local-midnight default until PR S1 swaps the plan-backed clock in — no stream-local daily job); the real
`planDayStartAfter`/`nextSessionAt` arrive with PR. The requester predicate comes through F1a's churn dep
(`hasActiveRequest`, default `false`) that RO implements; the surface gate and the preflight port through F2a's
click-review seams.

**Steps — UD-a (protection):**

1. Wire F2b's `unfollow-protection.ts` (its truth-table and L-PROT tests already exist; extend them only for new
   cases found while wiring).
2. `protection-port.ts` (`index()` live from `SettingsService.protection()`, `recheckDelayMs(n)` = the plan-day length
   from `PlanDayClock` × 2^min(n−1, `KEEP_RECHECK_DOUBLINGS`)); `protection-gate.ts` (`storedSubject`, `freshSubject`
   from `obs.fields` only, `keptStampFor`, `keepRecord`, `releaseRecord`); `follow-records.ts` repo methods (`toKept`,
   `release`, `kept(page)`, counts, `recheckDue(now)`); `protection-reconciler.ts` (`reapply('rules' | 'day-roll')` in
   one transaction, no IG traffic; graph-open run; day-roll from `PlanDayClock.onRoll`).
3. Churn: `advanceTimers` loops 1–3 (selection gate before any evidence logic; loop 3 moves protected
   `unfollow_queued` records, healer requeues included, to `kept`); `mutuals:'keep'` disables loop 2; `nextDue` only
   filters (paused → no unfollow); `executeUnfollow` re-checks; delete `bioKeepsFollower`.
4. Cleanup: `prune-candidate.ts` takes `protection: ProtectionVerdict` (skip `'protected'`, consumed without spending a
   slot); `rules-prune.ts` (P10) passes `PruneFacts.protection`; `prune-feed.ts` consumes protected rows, `paused` →
   null; `prune-engine.ts` actionable counts through the gate, `protection-paused` stops a run, a click-time
   `protected`/`unknown` skips + marks visited (never `PRUNE_PARK`); `pruneCandidates` annotations (`protectedBy`,
   `bioUnread`) in `prune-control.ts`.
5. `click-review.ts` step 5–6 (spec §9.7 order): protection on fresh fields after the edge write and before
   `followsUs`, as `ActionReviewedError({kind:'protected' | 'protection-unknown' | 'protection-paused'})`; `unfollowOne`
   refuses `protected`.
6. `unfollow-wiring.ts`: wire the port, the reconciler (day-roll through `PlanDayClock.onRoll`), and **return** the
   `unfollowsPaused` status contributor in `BuiltGraph.statusContributors`; `settings.setCapabilities
   ({protectionEverywhere: true})`.
7. Properties P-PROT-1…5 (spec §20.1 / Appendix B): no non-clear verdict ever yields an unfollow on P1–P7, P9, P10; a
   protected/unknown head never blocks a queued follow; ≤ 1 visit per unknown record per window; `paused` emits no
   unfollow while follows continue; `rotateMutuals = false` never queues P2. Reverse the old-semantics tests
   (`churn-scheduler.test.ts:577-640`, `prune-engine.test.ts:841-874`, `mutation-policy.test.ts:103-111`,
   `settings.test.ts:182-189`). Merge checkpoint **UD-a**.

**Steps — UD-b (journal + verify-at-act):**

8. `derive-parks.ts` (`parkUntil`, `parkTerminal`, `goneConfirmations`) with law L13; `journal.ts` (`journalBlocks`,
   `journalDue`, `settlementFor`) with the settlement table row by row (spec §9.8, including **F6** and the follow
   mirror) and laws L5/L6; `effect-intents.ts` repo (`due(now)`, `park`, `unsettledFor(pk)`,
   `nonDispatchReviewsSince(t)`, `cancelInterruptedPrepared(before)`, `'expired'` counted).
9. `journal-settlement.ts` (`settleNextIntent`, `settleFromChannels`), the replacement for `effect-reconciliation.ts`
   in every UD-owned caller (`prepare-mutation.ts`, `unfollow-wiring.ts`); the journal gate implementation swapped into
   `mutation-admission`'s `JournalGate` port at `unfollow-wiring.ts` (per-account; the global block is gone, so the old
   reentry `reconcile` phase no longer gates admission).
10. `click-verdict.ts` (`applyClickVerdict`) and the full click order in `click-review.ts` (steps 0a–13; step 0a calls
    F2a's `preflight` port, step 0b F2a's `SurfaceGate` dep; step 7 = the fresh `viewer.incomingRequest === true` or
    the requester port, writing the `requests` edge from a fresh `true`; on `proceed`: the dwell, then the dispatch
    closure, then the presses — a refusal at the closure produces zero presses (test)); churn
    `applyOutcome('reviewed')`; `nextDue` filters `recheck_at > now`, `journalBlocks`, requesters, protection paused,
    and the per-session non-dispatch review bound. **Cleanup consumption**: only post-visit verdicts mark a candidate
    visited; pre-visit deferrals serve `until` (deadline, hourly-cap), pass over a journal-blocked candidate, or end the
    run with a typed reason (spec §9.7) — `tests/engine/prune-run-deferrals.test.ts` (a deadline and an hourly-cap
    refusal mid-run leave every unvisited candidate unvisited). In a cleanup run, an `unverified` outcome counts toward
    `blockedStreakThreshold()` once the breaker threshold is reached (spec §11.1 F7).
11. Rules: `rules.ts` `RuleId 'reconcile' → 'journal'`, the journal rule placed after `pacing` (pinned order test
    updated, with the precedence property "journal never preempts the safety prefix or pacing");
    `engine-journal-effects.ts` runs `settle-journal`; `facts-journal.ts` `journalDue`; delete
    `reconciliation-runner.ts`; the `reconciliation-failed` halt and `engine:reconcile-backoff` key go (noise-registry
    lists updated).
12. Standalone writes: `prepare-mutation.ts` = due journal intents only; a write to an account with an unsettled
    intent → typed `journal` refusal (update `runtime-lifecycle.test.ts`, `manual-journal.test.ts`).
13. **Checkpoint test** `tests/integration/lifecycle-reachable.test.ts`: a due lifecycle unfollow is executed end to end
    and no reconcile phase wedges admission; it must stay green at every merge from UD-b through RO-b (PR keeps it).
14. Delete `CHURN_DEFAULTS` and the other `*_DEFAULTS` used only by tests in owned files (tests use
    `tests/kit/configs.ts`); last commit removes the transitional `EffectiveSettings` list fields. ADR 0214; the ADR
    0212 amendment (per-account gate; F6 row) is co-authored with RO's ADR 0213.

**Acceptance.** UD-a: properties P-PROT-1…5 (incl. P10); click-time freshness tests (stored bio matches but the fresh
body lacks `biography` → kept unreadable, never unfollowed; stored old bio does not match but the fresh one does →
protected); kept transitions and the 1/2/4/8 plan-day back-off; prune consumption tests; `FOLLOW_STATES` funnels include
`kept`. UD-b: the settlement table tests (including F6: uncertain unfollow + visit showing following/requested → record
`unfollow_queued`, intent `cancelled`); laws L5, L6, L13; I5 of spec §20.3's reopen list (a deleted account at the
queue head parks and the next record proceeds); I7 (a manual unfollow after a week away is admitted; the stuck account
gets `journal`); the rules order test; the run-deferral test; the incoming-request test (fresh `incoming_request:true`
without a stored edge → `request-pending`); the lifecycle-reachable checkpoint test.

**Gates.** `npm run check`.

### RO — REOPEN: (a) the growth log and frontiers' store, (b) the sweep and the following check

**Goal.** Spec §9 (except §9.7–9.9 which UD owns): frontiers, the drawer watermark, the followers head, the
session-mode following check, the launch catch-up, exact dated counts and the upward-only outside charge, probation and
staleness from the plan, the deletion of the reconcile phase and of the modules only the old watcher used.

**Owns.** `src/kernel/{derive-reentry,reentry-policy}.ts` (`reentry-policy.ts` from F2a's skeleton),
`src/store/repos/{growth,reopen-state,relationships,analytics,census}.ts`, `src/store/folds/growth.ts`,
`src/store/{knowledge-store,knowledge-store-base}.ts` (hooks and delegations after F), `src/shared/{followback-outcome,
reopen-view}.ts`, `src/engine/{source-quality,sweep-plan(new),frontier-sweep(new),followback-watcher,followback-types,
facts-cadence,engine-sweep-effects,ports,reentry}.ts`, `src/rim/{feed-watermark(new),followers-head(new),
following-check(new),feed-capture,follow-notifications,request-acceptance,walk-own-list}.ts`,
`src/main/services/reopen-wiring.ts`, `src/main/modules/catch-up.ts` (new), `tests/kit/{reopen,harness-reopen}.ts`,
`docs/adr/{0213-frontiers-verify-at-act-journal,0704-follower-change-log}.md`, `docs/PRINCIPLES.md` (draft edits for
Phase I), and the tests for these files; **deletions in the watcher-rewrite commit**: `src/engine/
reconcile-followback-cohort.ts`, `src/rim/{managed-relationships,effect-reconciliation}.ts` (UD-b already stopped
importing them; RO-b removes the last importers — the watcher, `reopen-wiring.ts`, `ports.ts` — and deletes them in the
same commit), then `src/engine/reentry.ts`.

**Touch minimally.** `src/engine/engine.ts` (remove presence-hold bracketing `:222,236` and `reentry.prepare` in
`start()`; PR owns); `src/main/services/graph-builder.ts` (`reentry.prepare` → `churn.advanceTimers(now)` +
`store.cancelInterruptedIntents(launchAt)` + `reopen.seedFromLegacy`; BL owns); `src/rim/list-page-walker.ts` (none
expected — F added `stopAfterPage`/`readUse`; PP owns); `src/timing/schedule-manager.ts` (the follow-back sweep cadence
`:121` goes with the watcher rewrite; PR owns); `src/settings/mappers.ts` (`toFollowbackConfig` loses the fields the
appliers no longer read; SC owns); RO calls SC's `takeBookkeeping()` for the v1 sweep stamp. (`mutation-admission.ts`,
`status.ts` and `status-projection.ts` lost every `reentry` use in PR S2, so deleting `reentry.ts` touches none of them.)

**Depends on.** F, G0. RO-b additionally needs PC (`PlanView`: `checkDue`, `checkLight`, `censusDue`, the catch-up and
frontier budgets, `planDayStartAfter`), PR S1 (the plan-backed `PlanDayClock`) and S2 (`reentry` out of PR's files), BL
(the `BuiltGraph.startupSteps` slot is consumed by the boot sequencer), UD-b (journal settlement for accept intents via
`settleFromChannels`). PP-a upgrades `readDrawerBody` (strict requests, `pendingComplete`, the sibling preview) but RO-b
runs on the F identity seam until then.

**Steps — RO-a (store and kernel):**

1. `growth.ts` repo + `folds/growth.ts` (pure): `noteOwnHeader` (every own-header observation, from the store's
   `observe` path), `onTransition` (transition-only change rows in the edge's own transaction; never-active edges
   write nothing), `narrow` (only tightens), `ensureBackfilled` (set-once; law L8: every growth read equals the old edge
   queries on every window), `accounting` (components, residuals, placement; law L3 conservation), `today(window)`
   (the window is a method argument from `PlanDayClock`), `series(days)`, `outsideSince` (**increases only**:
   `ΔG − epoNet − resolvedEpoRequests`, Epo's outstanding requests tracked until they resolve, decreases never charged,
   multi-day windows unplaced — spec §9.10).
2. `relationships.ts`: own-edge transition hook; `requests` edges (close an active `requests` edge when `follows`
   activates); `hasActiveRequest(pk)`, `activeRequestPks()` — implement F1a's churn requester dep.
3. `reopen-state.ts` repo (validated parse; corrupt → `logger.error` + absent; `seedFromLegacy(lifecycle_state v1,
   bookkeeping carry)` then clear `lifecycle_state`; the `following` frontier).
4. `followback-outcome.ts` (the one classifier) folded in `analytics.ts` (`targetYield`, leaves the allow-list) and
   `source-quality.ts`; law L7 (UI and engine classify identically).
5. `census.ts`: `FIRST_CENSUS_STOCK_WINDOW_MS` → one plan-day (window passed in from `PlanDayClock`);
   `lastCompleteAt` exposed for the durable `censusDue` predicate; the `unenrichedUsernames` windows take
   `planDayStartAfter(WEEKLY_CYCLE)` as an argument.
6. `derive-reentry.ts` (`headWalkPages` bounded by `FRONTIER_PAGES_MAX`, `headPageAllowance`, `measuredRowsPerPage`,
   `frontierRun`, `orderVerdict`, `minOrderPairs`, `WEEKLY_CYCLE`). Merge checkpoint **RO-a**.

**Steps — RO-b (the sweep):**

7. `feed-watermark.ts` (pure; law L9) and the drawer in `follow-notifications.ts`/`feed-capture.ts` (spec §9.4):
   `fetchSince(w, {use, panel, onEvent, onUndated, onRequester})`; chip-when-ready with `ui.step-pause`; the post-chip
   body wait; **per-body streaming** (an event is in the store before the pass resolves — test); no scroll when
   reached; ≤ rounds otherwise; gap recorded; the panel never at launch; the verification read at most once per
   plan-day; a failure ends N only. `request-acceptance.ts`: an accept closes the `requests` edge.
8. `followback-watcher.ts` → per-fact appliers (`applyEvent`, `applyUndated`, `applyRequester`, `applyAccepted`,
   `consistencyPass`); delete `check()`, the cohort/census paths, the evidence demand and the pending-requests
   deferral; `followback-types.ts` loses `RELATIONSHIP_FRESH_MS`, `FOLLOWBACK_DEFAULTS`, `FollowbackCensus`,
   `FollowbackRelationships`; the sweep cadence in `schedule-manager.ts` goes; **in the same commit** delete
   `reconcile-followback-cohort.ts`, `managed-relationships.ts`, `effect-reconciliation.ts` and their imports in
   `reopen-wiring.ts` and `ports.ts`. The lifecycle-reachable checkpoint test stays green.
9. `followers-head.ts` (`walkFollowersHead`: pre-frontier `isKnown`, `stopAfterPage` run detection, conservative
   rows, at most `FRONTIER_PAGES_MAX` pages, `initialized` with one page when `reopen_state` is absent (the upgrade
   launch), narrowing after the frontier with the order self-check; never removes an edge; law L10);
   `walk-own-list.ts`: followers census `maxPages = min(censusFollowerPages(header, rpp), censusWalkMax)`, "too large"
   refusal; reports rows/pages for `rpp`.
10. `following-check.ts` (step G, spec §9.2–9.3): the ordered whole-list response + the plain end probe through the
    walker's whole-list rule; verified-complete or a typed failure; per-row writes; removed `own → pk` edges on managed
    records → `external` (outside unfollow), new edges → outside follows; the exact count replaces the estimate;
    session mode only, at most once per plan-day, from the census term's following share; tests (outside follow and
    unfollow identified; never at launch; never under Boost).
11. `sweep-plan.ts` (pure `stale`, `decideStep` incl. G) and `frontier-sweep.ts` (per-step persistence after facts
    commit; `AwaySummary`; light mode keeps H at session start; `lastSweepEndedAt`); `facts-cadence.ts`: `sweepDue =
    plan.checkDue(lastSweepEndedAt)`; `engine-sweep-effects.ts`: `sweep-followback` runs `FrontierSweep.run('session'
    | 'check')`.
12. `catch-up.ts` (`blockKind`, `catchUpAdmission`, `catchUpStep`), **returned** in `BuiltGraph.startupSteps` by
    `reopen-wiring.ts`, which also returns the status contributors `catchUp`, `own`, `today`, `journal`, `requests`;
    `advanceTimers` at graph build; delete `reentry.ts` (probation now from PC's `probationOwed` via the plan view) and
    the presence holds; the People-lane "not yet verified" marker for outside changes until G ran (a projection field
    SH renders).
13. Integration I1–I12 (spec §20.3 reopen list, incl. the upgrade launch reading exactly one head page) + the
    following-check integration test; `docs/PRINCIPLES.md` edits drafted; ADRs 0213 and 0704; amendments 0211, 0212
    (with UD), 0210 (passive catch-up under operational blocks), 0307.

**Acceptance.** Laws L1–L13 of the reopen list (only the delta; never fabricate; conservation; clock independence;
launch passivity; park schedule; watermark; frontier safety; probation; backfill identity) + L15 (census) data side;
I1–I12; the following check; LC1 info logs per drawer pass / head walk / catch-up (zero extra requests);
`rules.test.ts` unchanged by RO (UD owns the order change); `analytics.ts` and `follow-notifications.ts` leave the
allow-list; nothing imports the three deleted modules.

**Gates.** `npm run check`.

### PP — PARSE-PIPELINE: (a) hazards + transport, (b) one parser + recovery

**Goal.** Spec §10.1–10.6 and §10.9 (the read pipeline). Two phases with a merge checkpoint; PP-b also needs PH's corpus.

**Owns.** `src/surface/read/**`, `src/surface/transport/**`, `src/surface/recovery/**`, `src/surface/schema/{surface,
projection,endpoints}.ts`, `src/surface/{index,parse,health,shadow}.ts`, `src/surface/versions/2026-08-12/{surface,
projectors,schemas,literals,literals-json,literals-signals,continuation-decl,transport-decl,containers,expected,
recovery-decl}.ts`, `src/adapter/{reader,reader-shadow,reader-relationships,observed-reads,fetch-json,envelope,
mutation-classify,surface-types,ig-surface,mutation-watch,drawer-read}.ts`,
`src/adapter/versions/{2026-08-12,2026-08-12.extractors,2026-08-12.mutations,2026-08-12.notifications}.ts`,
`src/rim/{list-page-walker,list-walk-end,list-walk-types,followers-page-reader,profile-observer,profile-visit,
profile-visit-port,relationship-reconciler}.ts`, `src/engine/{census-authority,prune-scan-guards}.ts`,
`src/main/services/own-stats.ts`, `src/shared/observed-relation.ts`, `src/kernel/{census-policy,surface-policy}.ts`
(`census-policy.ts` from F2a's skeleton), `src/probe/{verify,recorder,traffic,probe-main}.ts` (their sleeps draw from the
probe's reference `TempoSource`; allow-listed as harness), `src/capture/classify.ts`, `tests/kit/surface.ts`,
`tests/surface/**` (except the corpus/ingest/leak/replay files PH owns), `tests/rim/list-walk-*.test.ts`,
`docs/adr/0806-one-parser-tiers.md` (with PH).

**Touch minimally.** `src/rim/profile-enricher.ts` (a visit `ok` without a valid count pair counts in the existing
failure streak; PR owns); `src/engine/prune-engine.ts` (keep the header returned by `refreshOwnStats` for the scan; UD
owns); `src/rim/follower-acquisition.ts` (accept C2 `source-rows` pages for the candidate pool only and stop the walk
after them; PR owns); `src/main/services/surface-wiring.ts` (construct `Reader(env)`, `ObservedReads`; PH owns).

**Depends on.** F, G0. PP-b also needs PH's corpus commits (S3) merged.

**Steps — PP-a (hazards S1 + transport S2):**

1. `read/relationship.ts` + `observed-relation.ts` (the only mint; grep test) and presence semantics in
   `reader-relationships.ts`; `ProfileViewer.incomingRequest`. U07 rows S1/S2/F1/P1 as tests.
2. `read/continuation.ts` + `continuation-decl.ts` (with `big_list` as a declared more-flag) + `vetoKey`; every real
   end page → `end{flags-false}` with no veto (test); `list-walk-end.ts` table per spec §10.4 (sticky opaque, the
   whole-list probe, never a second synthesized offset) with L-WALK; quarantine counts through `WalkResult`.
3. `read/fields.ts` (I1, I2, I5 pair + retype, I9, I10, bio presence); count-pair post-process in `parseProfileInfo`;
   own counts only from C0/C1 non-partial reads in `profile-observer.ts`.
4. Strict requests in `drawer-read.ts` (`pendingComplete`, `requests-walled`, `requests-unreadable`, the C0 sibling
   preview rows); delete the lenient `parsePendingRequests`.
5. `own-stats.ts` returns the header; `census-authority.ts` `coverageVerdict` (fail closed on `null`; `CENSUS_POLICY`);
   `prune-scan-guards.ts` refuses `quarantined > 0`. Merge sub-checkpoint **S1**.
6. `transport/decode.ts`, `transport/graphql.ts`, `read/gate.ts`, `read/route.ts` (the profile route on any GraphQL
   path; root-field route) with the transport/gate/route/graphql test suites; the in-page envelope script returns
   `text` for any parseable 2xx and takes `abortMs` (rebuild nothing in `src/adapter/page/*`: the script lives in
   `versions/*`); `fetch-json.ts` decodes once.
7. Mutations: `decodeBody` in `mutation-watch.ts`; all error texts; the `'error'` verdict in `mutation-classify.ts`
   (an observed `errors[]` response is Instagram evidence: never `unverified`; the DOM and block probe pick the class;
   it always counts as a refusal toward the ladder — spec §10.5; test); the `not-following` presence rule; candidate
   walls (never a success).
8. Evidence-backed `gone` and visit outcome precedence in `profile-visit.ts`; the recorder records `format`. Merge
   checkpoint **PP-a**.

**Steps — PP-b (one parser S4 + recovery S5):**

9. `read/types.ts`, `normalize.ts` (containers, connection presence, alias/retype/framing steps), `admission.ts`,
   `read.ts` (`readBody`, never throws), `containers.ts`, `expected.ts` (`EXPECTED_KEYS` — `profile-graphql` includes
   `biography` and `is_verified` —, `NOVELTY_BASELINE` pinned to PH's manifests), `observed-reads.ts` (memo + candidate
   buffers); the Reader API over `readBody`; projectors through `fields.ts` with tri-state relationships; stories parsed
   per row. **Offline, before L4**: resolve from the 2026-11-02 corpus how an empty bio arrives (`null` or `''`) and
   record it in `expected.ts` with the evidence string (spec §7.3).
10. Per-endpoint flips, **one commit each**, in spec §10.3 order, each gated by replay over both corpora, the
    differential test (`tests/surface/differential.test.ts`; intended differences only on synthetic drift) and the laws;
    the reverse shadow in `reader-shadow.ts` compares every field and records `shadow-disagreed` through the sink.
11. Recovery: `recovery/locate.ts` (R1–R7), `signatures.ts` (the roles of spec §10.6 + `usernameFieldOf`, incl. the
    acquisition-only `source-rows` role: I1–I3 rows, R2 decoys, R5 majority, continuation never recovered), `hints.ts`
    (`HintBook` port with `NO_HINTS`; PH persists), `recovery-decl.ts`; `visit(username, {pk})`; the deadline
    candidates; feed/requests recovery inside `drawer-read.ts`; the acquisition accepts a `source-rows` page for the
    candidate pool only and stops (declared touch); own-list walks (census, head, following) refuse C2 (test). The
    `SurfaceGate` decision logic lives in PH (PP emits the signals, incl. the list-drift signals that open
    `paused('exploration')`). The U07 regression table (`tests/surface/u07-scenarios.test.ts`) complete. Merge
    checkpoint **PP-b**.

**Acceptance.** Every U07 row; read laws ("correct parse or typed failure, never a wrong fact"; "small delivery changes
still parse"; L-RECOVER-C2 incl. "a `source-rows` read never reaches a census, head or following walk", L-ANCHOR,
L-DECOY, L-WALK); the differential test; the mutation-evidence test; `bundle-fresh` unaffected; the `ig-surface.test.ts`
retired-reads pin still green; `reader.ts`, `versions/2026-08-12.ts`, `literals.ts`, `surface.ts`, `ig-surface.ts` stay
under the budget.

**Gates.** `npm run check`.

### PH — PARSE-CORPUS-HEALTH: the corpus, the sink, drift tables, the report, the compatibility UI

**Goal.** Spec §10.7–10.8 and the persistence half of §10.6 (hints, the `SurfaceGate`).

**Owns.** `src/surface/lab/**`, `src/surface-lab/**` (incl. new `probe-ingest.ts`, `fingerprint.ts`),
`src/surface/versions/2026-08-12/scrub-shapes.ts`, `src/surface/{sink,health-view,meter}.ts`,
`src/store/repos/surface-drift.ts`, `src/main/services/{surface-wiring,surface-health-sink(new),surface-report(new)}.ts`,
`src/main/ipc-surface.ts` (replace the stub), `src/shared/surface-health.ts` (labels/helpers),
`src/renderer/settings/compatibility/{CompatibilityPanel,CompatibilityLine}.tsx`,
`src/renderer/live/CompatibilityNotice.tsx`, `src/renderer/hooks/useSurfaceReport.ts`,
`src/renderer/styles/compatibility.css`, `src/renderer/gallery/fixtures-surface.ts`, `tests/fixtures/surface/**`,
`tests/surface/{ingest-probe-runs,leak,replay,scrub-fixtures,health-view}.test.ts`,
`tests/store/surface-drift.test.ts`, `tests/main/{surface-report,surface-health.integration}.test.ts`.

**Touch minimally.** none expected (SU and SB mount PH's components; they own the mount points).

**Depends on.** F, G0. The corpus commits (S3) should merge early (PP-b needs them).

**Steps:**

1. **Corpus (one designated agent, zero requests).** Scrubber extensions (`count` and `time` PII classes; id aliases
   as pseudonyms); `structural-leak.ts` extracted from the leak test; GraphQL-aware routing in `surface-lab/select.ts`
   via `routeObserved` (if PP-a has not merged, route by operation name locally and switch later); `probe-ingest.ts`
   (reads the raw 2026-11-02 bodies **in place** from the path the lead gives, `EPO_SCRUB_SOURCE`; refuses any output
   directory other than `tests/fixtures/surface/2026-11-02/`); re-scrub the 2026-08-12 **bodies only** (DOM untouched);
   `npx jest tests/surface/leak` green **before** committing any scrubbed file; multi-corpus replay; manifests with
   `novelKeys` (the source of `NOVELTY_BASELINE`).
2. **Sink and persistence.** `sink.ts` signals and `MemorySink` (supersedes the in-memory `SURFACE_HEALTH`);
   `surface-drift.ts` repo (first-sighting upsert, witnesses/contradictions/state machine, health counters per
   plan-day — the day key comes from the `PlanDayClock` port as a method argument, and retention, caps and
   `driftConfirmThreshold()` from the store's `StorePolicy` options, never a kernel import —, retention, signature cap,
   report rows); `surface-health-sink.ts` (buffered counters flushed on the push-throttle trailing edge,
   `PlanDayClock.onRoll` and teardown; immediate first-sighting signatures with a scrubbed, leak-checked sample, ≤ 12
   per plan-day); `meter.ts` `dump()`/`restore()` through `meta.surface_meter`; remove `src/surface/sink.ts` from
   `pending-wiring.json`.
3. **Health view and gate.** `health-view.ts` (pure area states; persisted-derived `unreadable`; auto-resolve after
   `driftConfirmThreshold()` clean reads); `createSurfaceGate(view)` implementing F2a's `SurfaceGate` port for every
   `PausedActivity` incl. **`exploration`** (paused once the `lists` area has seen `driftConfirmThreshold()` drifted
   source pages; a drifted list never feeds the recovery ladder — spec §10.6), swapped in at `surface-wiring.ts` for
   both consumers (click review's step 0b and the plan mix); `biography`/`is_verified` `expected-absent` → profiles
   `paused` with a reason; the `HintBook`/`IdentityOracle` implementations over the store; the `surface` status
   contributor returned by `surface-wiring.ts`.
4. **Report and IPC.** `surface-report.ts` (`summary()` for the `surface` status contributor; `report()` with
   `copyText` containing no pk, username or digit run ≥ 6 — test); `ipc-surface.ts` handler; the not-built fallback.
5. **UI.** `CompatibilityPanel` (Advanced; state pills, explanations, recent changes, "Show technical details", **Copy
   report**), `CompatibilityLine` (Easy one-liner), `CompatibilityNotice` (sidebar line), `useSurfaceReport` (pull on
   mount and on `status.surface.revision` change); copy per spec §10.7 and Appendix D; gallery scenarios "Adapted to a
   change", "Unfollows paused" and "Finding new people paused" (the list-format line, owner Q39).
6. ADR 0806 (with PP); amendments 0802 (persisted health, novelty baseline, samples).

**Acceptance.** Leak test green on both corpora; replay green; `surface-drift.test.ts` (frozen DDL from F,
`withLegacyDb(13)`); `health-view.test.ts` (state machine, paused activities incl. `exploration` after two drifted
source pages and never the ladder, revision bumps);
`surface-health.integration.test.ts` (facts land, no record goes `held → external`, `status.surface` moves —
view-liveness, samples scrubbed, meter round-trips); `compatibility-panel.test.tsx`.

**Gates.** `npm run check`; the scrub commands only in the designated checkout.

### CF — CONFIRM: confirm layers, one admission per action

**Goal.** Spec §11 F1–F5, F7 (the `unverified` classification; PR builds the breaker on it) and the passive capture
hook (F6 is UD-b). **Live precondition**; merge early (it needs no owner answer and may start right after Phase F).

**Owns.** `src/adapter/{action-admission,unfollow-flow(new),actor,actor-scroll,response-watch,confirm-capture(new)}.ts`,
`src/adapter/page/**` and the regenerated `src/adapter/page/bundle.generated.ts`,
`src/surface/versions/2026-08-12/{controls,literals-dom}.ts` (the `unfollow-dialog-cancel` control, `companionRx`
config, `maxConfirmLayers` surface fact), `src/engine/mutation-outcome.ts`, the tests
`tests/adapter/{action-admission,unfollow-flow,actor-settled-press,health}.test.ts`, `tests/page/confirm.test.ts`,
`tests/surface/controls/confirm.contract.test.ts`, `docs/adr/0308-unfollow-confirm-layers.md`.

**Touch minimally.** `src/adapter/mutation-watch.ts` (count `MUTATION_BLINDNESS` only when no confirm layer is on
screen; PP owns); `src/engine/engine-actions.ts` (the `unverified` cause parks with `park.blocked` and skips
`recovery.noteOutcome('rate-limited')`; PR owns — PR S2 adds the streak breaker on top).

**Depends on.** F.

**Steps:**

1. Tests first (spec §11.2 items 1–11): the page test mounting the real `dialog-02.html` then `dialog-01.html`; actor
   Variant P; Variant R with a `beforeMutation` that rejects on its second call (the incident regression); public;
   stall; a refusing `beforeMutation` → **zero presses**; an unexpected two-button dialog on a later layer → **no
   press**, Cancel/Close, a `confirm-unrecognized` signature and a capture request; the wait sequence with a recording
   tempo (`enabled` true) contains one `ui.step-pause` per located layer; existing single-confirm tests with fakes
   answering `peek()` and `sig`.
2. F1 `action-admission.ts`: admit and journal at most once per action, before the header press; later calls `check()`
   only.
3. F3 `page/confirm.ts`: reverse-document-order scopes, `document` last (cfg flag to drop it for later layers),
   on-top check, `layer` and `sig`; **no press fallback** — a structural two-button match is reported for the capture
   only, never pressed; descriptor fields in `controls.ts`; `npm run build:page`.
4. F4 `response-watch.ts`: non-blocking `peek()`, `markPress()`; F2 `unfollow-flow.ts` layer loop (spec §11.1, incl.
   the `ui.step-pause` reading pause after each located layer, disabled under the reference tempo until PR S2) called
   from `actor.ts` (actor stays under its ceiling); the follow path runs the same loop expecting zero layers (logs an
   unexpected dialog, never presses it).
5. F5 Cancel/Close on any exit that did not land, including a later-layer text miss (`settleAndPress`; failure to
   close is a warn).
6. F7 `mutation-outcome.ts`: the `unverified` cause (dispatched, no Instagram evidence); an observed `errors[]`
   response is never `unverified` (it is a refusal; PP classifies it).
7. Capture hook `confirm-capture.ts` (layer ≥ 1, a layer left visible, or an unrecognized later layer → scrubbed
   `outerHTML` + `unmatchedPosts` to the local diagnostics folder; never committed; off in tests).
8. ADR 0308.

**Acceptance.** The spec §11.2 tests (P, R, public, stall, dispatch order, unexpected dialog, in-action pacing);
`bundle-fresh` green; `actor.ts` not over its recorded length; `clicks == [HEADER, MENU_ROW_SETTLED, DIALOG_SETTLED]`
for Variant P; one admission in Variant R; blindness unchanged on a stall; nothing in page code presses an unrecognized
control.

**Gates.** `npm run check` (includes `build:page:check`).

### BL — BOOT: hidden window, store-first identity, startup sequence, stage controller, menu

**Goal.** Spec §12.4 (main plumbing: `StageController`, curtain, application menu, title/badge from F2b's
`posture.ts`, stage traps), §12.8 (launch timeline, readiness R1–R3 and **R5 incl. the landing and identity
confirmation behind the splash**, the startup sequence and lease, store-first identity, the `shell.ts` options), and
the main-process half of §13 (sign-in flash, `'retired'`), plus the spec §17 runtime-bound rows marked BL.

**Owns.** `src/main/window/shell.ts` (additive options only), `src/main/launch.ts`, `src/main/main.ts`,
`src/main/modules/{boot-sequencer(new),startup-steps,session}.ts`, `src/main/window/{stage-controller(new),
app-menu(new)}.ts`, `src/main/overlay/{veil-view.ts,veil.html}`, `src/main/services/{tab-lease,runtime-coordinator,
dashboard-recovery,runtime-log,startup-failure,graph-builder}.ts`, `src/main/foundation-wiring.ts`,
`src/main/modules/status-compose.ts` (the `boot`, `account`, `basis` contributors), `src/main/modules/not-built.ts`,
`src/main/ipc-boot.ts`, `src/main/ipc.ts`, `src/main/app-identity.ts` (the isolated profile from F1a),
`src/main/services/graph-types.ts`, `src/kernel/{boot-policy,runtime-bounds}.ts`, `src/store/open-error.ts` (new),
`src/shared/{boot,stage-mode,status-fields,live-op}.ts` (types; SB owns the wording of `liveOpText`),
`scripts/background-probe-main.ts` (the `never-shown-boot` scenario),
the tests `tests/main/{boot-sequencer,startup-steps,session-store-first,stage-controller,app-menu,not-built}.test.ts`,
`docs/adr/1010-live-console-stage-space-store-first-boot.md` (with SH).

**Touch minimally.** `src/main/bootstrap.ts` (one import line for `RUNTIME_BOUNDS.ORIGIN_SETTLE_MS`; argued in the ADR
1007 amendment); `src/engine/source-frontier.ts` (`'retired'` treated like evidence-less exhausted, one condition; SC
owns); `src/kernel/shell-geometry.ts` (import only; TK creates it); `src/ipc/contract.ts` (none expected).

**Depends on.** F, G0. RO-b returns the `catch-up` step in `BuiltGraph.startupSteps`; BL's sequence runs without it.

**Steps:**

1. `kernel/boot-policy.ts` (`BOOT` incl. the derived `IG_READY_DEADLINE_MS = LATENCY.hydration.p95 + 2 ×
   LATENCY.nav.p50`; laws: `SHOW_FALLBACK < DATA_DEADLINE < IG_READY_DEADLINE < SETTLE_DEADLINE`; derived values equal
   their formulas) and `kernel/runtime-bounds.ts` (dashboard recovery, runtime log, startup failure, repair budget, runtime
   health, `ORIGIN_SETTLE_MS`, guard lines); move the literals out of the four services.
2. `shell.ts` additive options (spec §12.8): `startHidden`, `deferDashboardLoad`, `reveal()`, `loadDashboard()`,
   `igFirstLoad`; background `#0d0d0f`; `dash.setBackgroundColor`; zoom limits 1–1; maximize deferred to `reveal()`
   when hidden; geometry from `SHELL_GEOMETRY`; fix the wrong-file comment.
3. `launch.ts`: hidden construction → Foundation → `composeApp` → `registerEpoIpc` → `loadDashboard()` →
   `boot.start()`; `did-finish-load` → `reveal()` (fallback timer); delete the `updateStatus` replay.
4. `session.ts`: `openFromStore()` (no tab work; memoized), `rebuildWith(username)` (engine running/paused → defer and
   log), `ensureBuilt()` store-first; the degraded retry and the tour-hold block on the store open removed; deps lose
   `resolveUsername` and `withBuildHold`. `graph-builder.ts`: `ownUsername = given ?? store.getAccount(ownPk)?.username`.
   Test: **no read path calls the tab** (`FakeTab` records zero `goto`s across `chainList`, `growthSeries`, `queueList`,
   `status`).
5. `store/open-error.ts` (`classifyOpenError` → `future-version` | `locked` | `unreadable`) and `boot-sequencer.ts`
   (`start`, `view`, `revealed`, `whenStartupDone`, `noteStartQueued`, `runIdentitySteps`, `cancelStartup`,
   `onOnline` retry of a failed first load once per online transition); `tab-lease.ts` owner `'startup'`;
   `startup-steps.ts` gains `confirmAccountStep` (passive strategies 1–2 only) and composes
   `[openOwnProfile, confirmAccount, (reveal), ...graph.startupSteps, resumeRun]`: **the lease is claimed at R3 and
   steps 1–2 run behind the splash** as soon as `igFirstLoad` settles (when signed in, runtime ready, tour not held);
   `BootView.ig` becomes `ready` when they finish, or `placeholder` at `BOOT.IG_READY_DEADLINE_MS` / offline / signed
   out; the reveal waits for R4 ∧ R5 (spec §12.8); catch-up and resume run after `revealed()`; release calls
   `seedCheck.onTabFree()`.
   Foundation: `startEngine` awaits the startup gate (queued, never `manual-running`); `busyDriverReason()` returns
   `'starting'`; manual one-offs and prune scan/run get `'starting'`; `login()` stops showing the tab and runs the
   identity steps; `blockRuntime` pushes the real status (fixes the sign-in flash); `restartFromSeed` writes
   `'retired'`. Status contributors `boot`, `account`, `basis`. `reconcileWake` keeps F2a's `pause.wake-settle` draw.
6. `stage-controller.ts` (validate, serialize latest-wins, curtain into Live with plain-cut fallback, title per
   posture via F2b's `postureHeadline` in `src/shared/posture.ts` — available from Phase F, so BL never waits for SB —,
   Dock badge for alert kinds) and the veil curtain (`curtainOn` visibility
   rule; `window.__curtain(state, ms)` in `veil.html`, two-rAF paint promise bounded by `CURTAIN_PAINT_MAX_MS`); the
   `setStage` handler routes to the controller. Test: never `setVisible(false)` on the tab (`TabPlacement` spy).
7. `app-menu.ts` (template: accelerators ⌘1–⌘5 and ⌘, sending `PUSH.stageRequest`; no zoom roles; DevTools only
   unpackaged); Windows/Linux auto-hide menu bar.
8. `background-probe-main.ts`: the `never-shown-boot` scenario (construct hidden, navigate the local fixture, reveal
   after 1 s, measure input ACKs) — zero Instagram traffic.
9. ADR 1010 (with SH); amendments 1007 (scope: additive `shell.ts` options, the `tab.ts`/`bootstrap.ts` constant
   imports), 0210 (crash resume after the reveal; the startup lease), 0306 (note: the curtain preserves re-stack
   concealment).

**Acceptance.** `boot-sequencer.test.ts` (R2 → R3 → the landing and `confirm-account` behind the splash → ready; the
IG deadline falls back to the placeholder; `revealBy`; signed out (no landing, no wait); offline (placeholder); data
unavailable via a future-version DB; steps in order and never overlapping; a Start during the steps is queued and
resolves after release, never `manual-running`; Stop cancels; the settle-deadline fallback; the tour hold skips the
landing); law L-BOOT (phases only advance; before `revealed()` the only tab work is the home load, the landing press,
its URL wait and `confirm-account`'s passive reads — no drawer, no list read, no third-party visit);
`stage-controller.test.ts`;
`session-store-first.test.ts`; `app-menu.test.ts`; `not-built.test.ts` (`basis`; `blockRuntime` before the build pushes
`loggedIn` from the cookie); the background probe passes every scenario including `never-shown-boot`.

**Gates.** `npm run check`; `node scripts/background-probe.mjs --soak-ms 10000`; visual checks in the isolated
profile (`EPO_USER_DATA_DIR`, `EPO_BLOCK_NETWORK=1`).

### LD — LIVE-DATA: activity relay, feed, projections, log ring, updater truth

**Goal.** Spec §12.9 (the typed activity push with the null-hold, the derived feed with dedupe, the expiry timer, the
log ring) and the §13 rows on `lastActionAt`, the resume target and the updater.

**Owns.** `src/main/modules/{activity-relay,feed-projection,log-ring}.ts` (new), `src/main/modules/projections.ts`
(dedupe and the expiry timer), `src/main/ipc-live.ts` (replace the stubs), `src/store/repos/feed-reads.ts`
(the F skeleton), `src/main/{update-core,updater}.ts` and `src/main/modules/updater.ts` (the updater lives there, not
under `services/`), `src/main/services/live-wiring.ts` (F2b's empty wiring module: LD returns the `resumeTarget` status
contributor from it), `src/shared/{feed,update-status}.ts` (helpers: `formatAgo`), `src/kernel/live-policy.ts`,
`src/engine/resume-target.ts` (consumer switch; F1a extracted it), the tests
`tests/main/{activity-relay,feed-projection,log-ring,update-status,projections-registry}.test.ts`,
`tests/store/feed-reads.test.ts`, `tests/engine/resume-target.test.ts`.

**Touch minimally.** `src/engine/status-projection.ts` (`lastActionAt: engine.lastActionAt ??
store.feed.lastSettledMutationAt()`; PR owns); `src/main/foundation-wiring.ts` (the `TabActivity` callback feeds
`activityRelay.onHolds`; the log sink feeds `LogRing`; BL owns); `src/main/launch.ts` (construct the relay and ring;
BL owns).

**Depends on.** F, G0.

**Steps:**

1. `kernel/live-policy.ts` (`LIVE`, `DIAGNOSTICS`) with derived-value tests; the feed windows reach the store through
   `StorePolicy` (F2b), never by import; the feed's day groups use the `PlanDayClock` port.
2. `feed-reads.ts` (`settledEffects`, `followBacks`, `newFollowers` (after the baseline; excluding managed follow-back
   records and accept intents), `lostFollowerCount`, `lastSettledMutationAt`) with `EXPLAIN QUERY PLAN` assertions on
   the migration-17 indexes and a perf smoke (100k edges, 20k records, 10k intents shape in ≤ 15 ms on CI).
3. `feed-projection.ts` (`shapeFeed`, `notBuiltFeed`; pure over its ports; law L-FEED: unique ids, newest first,
   window, limit, no pk both `followed-back` and `new-followers`, group ids stable, groups ≤ `GROUP_WINDOW_MS`; **no
   session rows**; `boost` rows from the plan's window, `caught-up` from RO's summary, `kept` from UD's rows — each via
   optional ports, absent until those streams land).
4. `projections.ts`: per-row last-JSON cache for `dedupe`; one timer re-armed at the earliest `expiresAt()` (clamped ≥
   now + throttle); the prune source declares the census freshness end.
5. `activity-relay.ts` (op change → push now; count-only change → trailing throttle; `clear()` → push `null` only if
   no op arrives within `ACTIVITY_NULL_HOLD_MS`; holds change → push now; the veil always gets `toVeilInfo` at once);
   `log-ring.ts` (500; the `log` push only while `streaming()`); `ipc-live.ts` handlers.
6. Updater: `UpdateStatus.state` initial `'unchecked'`; benign no-feed/offline → `'unavailable'` (today `idle`);
   `checkedAt` stamped on every completed check; the `updateStatus` invoke.
7. `resume-target.ts` consumer: `status.resumeTarget` via a status contributor **returned by `live-wiring.ts`** (the
   registration site; `graph-builder.ts` aggregates it with the others); law L-RESUME (peek = adopt; the peek performs
   no write — store spy).

**Acceptance.** The tests above; `projections-registry.test.ts` (an unchanged `feed` does not push; the expiry timer
pushes with no mutation, fake timers); `update-status.test.ts` (never "up to date" without a check).

**Gates.** `npm run check`.

### TK — TOKENS: type ladder, palette, Inter, motion tokens, the restyle

**Goal.** First, the **direction boards** the owner signs off (spec §21 R15); then spec §12.6–12.7 (tokens, palette,
typeface, geometry home, motion tokens) applied to every existing CSS file, before the feature UIs land. Serializes the
tokens golden.

**Owns.** `src/renderer/design/{scale,motion-scale(new)}.ts`, `src/renderer/styles/{tokens.palette.css,
tokens.generated.css,fonts.css,base.css,controls.css,shell.css,graph.css,chain.css,queues.css,prune.css,overview.css,
tour.css,gallery.css}` (the restyle; feature sheets created in F belong to their streams),
`src/renderer/fonts/{InterVariable-latin.woff2,OFL.txt}` (new), `esbuild.config.mjs` (the `.woff2` loader),
`src/renderer/lib/{motion,stagger}.ts`, `src/kernel/shell-geometry.ts` (new), `src/shared/brand-mark.ts` (new),
`src/renderer/ui/EpoMark.tsx` (new; from `Header.tsx`), `src/renderer/gallery/direction/**` (new: the static
direction boards), `tests/renderer/{tokens,contrast,motion-scale,geometry,brand-mark,direction-boards}.test.ts`,
`docs/adr/0405-a-larger-calmer-console.md`.

**Touch minimally.** `src/renderer/views/PruneView.tsx` (class names `.prune-page/.prune-col` → `.stage-page/.stage-col`;
SU owns); `src/main/window/shell.ts` (import `SHELL_GEOMETRY` if BL has not; BL owns); `src/renderer/index.html`
(favicon data URI generated from `BRAND_MARK`; SB owns the splash part); `src/renderer/gallery/Gallery.tsx` (one
scenario-array import for the boards; SH owns).

**Depends on.** F, G0. **TK does not merge before the owner has signed off the boards** (step 0).

**Steps:**

0. **Direction boards, owner sign-off** (1.5 h; first commit). Static compositions in `src/renderer/gallery/direction/`
   rendered from fixtures and the proposed tokens (no wiring, no IPC): the sidebar in its main postures (Working,
   Resting, Catching up, Needs attention, Boost on/paused, Get started) at 640 / 800 / 920 px heights; Settings Easy
   and Advanced (one section each, incl. a Fine-tune block and "Today's plan in detail"); the People page; the splash
   and the intro storyboard (five frames). The lead shows them to the owner; **TK merges only after the owner approves
   the direction** (changes are folded into the boards first). SU, SH and SB then implement against the approved
   boards; SB's gallery step only confirms the wired version. A test renders every board without overlap at the three
   widths (1024/1440/1920).
1. Tests first: L-CONTRAST (parse `tokens.palette.css`; every text token ≥ 4.5:1 on every surface), L-TOKENS (every
   `var(--…)` used in `styles/*.css` is declared), L-MOTION (CSS durations = `DUR`; `PERCEPTION_MS ===
   EMPIRICAL.DISPLAY.perceptionMs` — the test may import both), L-GEOMETRY (`shell.css` widths/heights =
   `SHELL_GEOMETRY`), L-MARK (`index.html` splash SVG and decoded favicon = `BRAND_MARK`).
2. `scale.ts`: the semantic type ladder, spacing 32/40 rungs, controls `32 + 4n`; delete the fluid `cqi` roles (the
   file should drop under 300 lines and leave the allow-list); the container-ramp selector string becomes
   `'.console,\n.stage-page,\n.stage-col {'`; `npm run gen:tokens`; update the golden expectations deliberately
   (ADR 0405 cites the change).
3. Palette (`--faint #8e8e97`, `--muted #a8a8b0`, `--danger #d27878`, state aliases, tone glows), radii 8/10/14,
   motion tokens (`--dur-1…5`, `--breath`, `--ease-out`, `--ease-in-out`); `motion-scale.ts` (`PERCEPTION_MS`, `DUR`,
   `BREATH_MS`, `BOOT_UI`, `CHART_DEFAULT_DAYS`); `lib/motion.ts` re-exports; `lib/stagger.ts` adds `staggerSections`.
4. Inter Variable (Latin subset, OFL) + `fonts.css` (`font-display: block`); the esbuild loader; tabular numerals.
5. Restyle every existing sheet onto the new rungs (no uppercase tracking beyond ≤ 3-char badges; 15 px body; larger
   hit targets; hairline separation instead of boxes in the console); rename the prune size containers.
6. `brand-mark.ts` + `EpoMark.tsx`; the favicon data URI regenerated from it.
7. ADR 0405 (amends 1005 and 0402).

**Acceptance.** The five laws; `tokens.test.ts` golden updated in the same commit as `scale.ts`; `gen:tokens:check`
green; the gallery renders at three widths without overlap; boundaries unchanged (no kernel import from the renderer:
`motion-scale.ts` holds its own constant, pinned by the test).

**Gates.** `npm run check`; `node scripts/background-probe.mjs --soak-ms 10000` (the pacing guard holds with the new CSS).

### SH — SHELL: stage hosting, the People page, overlays, the tour

**Goal.** Spec §12.4 (renderer half: five stages incl. **Clean up**, eager Graph, data preloaded behind the splash,
lazy Settings), §12.5 (People), the renderer half of §13 (lazy Settings mount; no seed check at boot), the tour rewrite,
and the shared renderer test/gallery hotspots.

**Owns.** `src/renderer/app/{App,StageBar,StageHost(new),PopoverHost(new),TooltipHost,shell-context,live-signals(new),
clock(new),motion-signal(new),ConfirmHost}.tsx/.ts`, `src/renderer/hooks/{useLiveFeeds(new),useStageRequest(new),
useChainList,useTargetDetail,useGrowthSeries,useQueue,useKeepAlivePoll}.ts` (`onError` landed in F2b),
`src/renderer/pages/PeoplePage.tsx` (new), `src/renderer/cards/{chain,queues}/*`, `src/renderer/charts/*` (projection
band removed), `src/renderer/graph/palette.ts` (the `kept` node's shield glyph; the entry itself came from F2b),
`src/renderer/ui/{icons.ts,Skeleton.tsx(new)}`, `src/renderer/lib/{anchor,play(new),deadline-anim(new),flip(new)}.ts`,
`src/renderer/tour/{steps.ts,Tour.tsx}`, `src/renderer/styles/people.css`, **`src/renderer/gallery/{Gallery.tsx,
gallery-bridge.ts}`** (others append scenario rows under the union rule), **`tests/renderer/view-liveness.test.tsx`**
(others append cases), `tests/renderer/{app-shell,tour-anchors,icon-render,people-page,charts}.test.tsx`; deletions:
`src/renderer/app/{Nav,ViewStage,Ticker,Header,Transport}.tsx`, `src/renderer/hooks/{useView,useViewShortcuts,
useLogFeed,usePeekFit,useStartWatch}.ts`, `src/renderer/views/{ChainView,QueuesView}.tsx`,
`src/renderer/charts/{growth-model,growth-overlay}.ts`, `tests/renderer/{target-detail-pick,engine-view}.test.ts`,
`tests/renderer/transport-render.test.tsx` (imports `app/Transport`). `tests/renderer/charts.test.ts` is **trimmed** to
its catmull-rom cases (it imports `charts/growth-model`). **Not SH's**: `views/OverviewView.tsx` and
`cards/overview/*` — the interim console column keeps rendering `OverviewView` until SB swaps `<Sidebar/>` in, and SB
deletes the view and its cards together (no orphan window); `tests/renderer/ticker.test.ts` stays (SB owns it:
`lib/ticker.ts` lives on through `ui/NumberTicker.tsx`).

**Touch minimally.** `src/renderer/index.tsx` (mount order only; SB owns the splash removal); the SB-owned sidebar
mounts into the `App` composition through a single `<Sidebar/>` import that SB provides (until SB lands, `App` keeps
today's console column, i.e. `OverviewView`).

**Depends on.** F, G0. CSS after TK merges.

**Steps:**

1. **`tests/renderer/tour-anchors.test.tsx` first** (every `TOUR_STEPS` target resolves), before any card is deleted.
2. `StageBar` from `STAGE_MODES` (five tabs: Live · People · Graph · **Clean up** · Settings; equal-width clamp, Live
   dot, right-side context); `StageHost` (**Graph eager** — mounted behind the splash, as today; People and Clean up on
   first activation, rendering from shell-level data preloaded behind the splash; **Settings lazy**; opaque, scroll
   reset, `staggerSections`); `App` hosts Live placeholder slot, People, Graph, Clean up, Settings (`SettingsStage`
   from SU's file — the F placeholder until SU lands); `setStage(stage, modalOpen || !liveRevealed)`;
   `useStageRequest` (menu accelerators); ⌘, opens Settings; `openSettings(target)` joins `ShellServices`.
3. Overlays: `TooltipHost` and `PopoverHost` at shell level with the native-view clamp (`place(anchor, size,
   sidebarRect)` on Live; suppression when it cannot fit).
4. Signals: `live-signals.ts` (`feedSignal`, `activitySignal`, `chainListSignal` owned once, the growth series and
   queue lanes fetched at shell level behind the splash, `pendingControlSignal`; `postureSignal` is SB's), `clock.ts`
   (ref-counted second/minute), `motion-signal.ts`, `useLiveFeeds` (push-first + pull backstops); `play`/
   `deadline-anim`/`flip` helpers (resolve at once in jsdom / reduced motion).
5. People page: the measured growth chart (projection band deleted), "Where Epo finds people", "In progress" lanes
   incl. **Kept** (`keptList`) and the "Changed outside Epo · not yet verified" marker (RO's projection field);
   de-jargoned copy; active-gated fetching; `'retired'` copy.
6. Tour rewrite (steps keyed on stages; the settings step `stage:'settings'`, anchor `seed`; "Settings → Practice &
   app"). (`useTourGate` is SB's; SH does not touch it.)
7. Delete the old shell parts, hooks and views (not `OverviewView`); trim `charts.test.ts`; `app-shell.test.tsx`
   rewritten (five tabs; `stageRequest` switches; Start without a seed → `openSettings({section:'audience',
   focus:'seed'})`; Sign in sets `'tab'` before `login()`; each push subscribed once; **Settings mounts lazily and no
   `checkSeed` is invoked at boot**; Graph mounted at boot; tooltip host outside `.console`); `Gallery.tsx` and
   `gallery-bridge.ts` follow the new shell (no import of a deleted module).
8. ADR 1010 (with BL).

**Acceptance.** The tests above; `view-liveness` green; `icon-render` `REQUIRED` updated (add the FA Free paths that
are missing — copy them from Font Awesome Free 6 with the CC BY 4.0 attribution; never a webfont); boundaries:
deletions remove `@/types` warnings, new files add none, no orphan created (the overview cards keep their importer).

**Gates.** `npm run check`; `node scripts/background-probe.mjs --soak-ms 10000` (stage-hidden); visual checks in the
isolated profile.

### SB — SIDEBAR: posture, zones, Boost control, splash and intro, Diagnostics

**Goal.** Spec §12.1–12.3 (the live column and posture), §12.7 (motion choreography in the column), §12.8 (renderer
boot: splash, `BootGate`, intro, Live placeholder), §8.6 (the one-tap Boost control), the Diagnostics panel, and the
wording of every live-activity sentence (sidebar **and** veil, one `liveOpText`).

**Owns.** `src/shared/{posture,attention}.ts` (`posture.ts` from F2b), the **wording** of `liveOpText` in
`src/shared/live-op.ts` (BL keeps the types) and its tests, `src/renderer/sidebar/**` (new: `Sidebar`, `Masthead`,
`NowPanel`, `StatusRing`, `TransportRow`, `TodayPanel`, `PlanStrip`, `BoostControl`, `ResultsPanel`, `Spark7`,
`ActivityFeed`, `GetStarted`, `SidebarFooter`, `copy/{posture,attention,refusal,feed,explain}-copy.ts`),
`src/renderer/boot/{BootGate,intro,LivePlaceholder}.tsx/.ts` (new), `src/renderer/diagnostics/{DiagnosticsPanel,
useLogTail}.tsx/.ts` (new), `src/renderer/index.html` (splash), `src/renderer/index.tsx`,
`src/renderer/ui/NumberTicker.tsx`, `src/renderer/lib/ticker.ts` + `tests/renderer/ticker.test.ts`,
`src/renderer/hooks/{useTourGate,useControl,useCountdown,useTransportControls,useEngineStatus,useUpdateStatus,
useUpdateToasts}.ts` (`useTourGate` is SB's alone), `src/renderer/styles/{sidebar,boot,diagnostics}.css`,
`src/renderer/gallery/fixtures-live.ts`, the tests `tests/renderer/{sidebar-liveness,sidebar-zones,boot-gate,
feed-render}.test.tsx`, `tests/shared/{posture,attention,live-op,feed}.test.ts`; deletions:
`src/renderer/views/OverviewView.tsx` **together with** `src/renderer/cards/overview/*` (ActivityCard, GrowthCard,
LiveStatusCard, NowTargetingCard, RateSafetyCard, SignInCard) and each helper only they import
(`hooks/useNow.ts`, `ui/RadialRing.tsx`, and any of `ui/{Slider,DualRange,NumberInput,Chips,CollapsibleCard,
Segmented}.tsx` still left with no importer — grep, then delete), `src/renderer/lib/{engine-view,labels}.ts` where
superseded, `src/renderer/styles/overview.css`, `tests/renderer/{live-status-card,live-status-render,runtime-copy}.test.ts(x)`.

**Touch minimally.** `src/renderer/app/App.tsx` (swap the console column for `<Sidebar/>`; SH owns);
`src/renderer/styles/index.css` (remove the `overview.css` `@import` line only); `src/renderer/settings/sections/*`
(mount `DiagnosticsPanel` in the Diagnostics section — SU provides the slot; SU has merged before SB);
`src/main/overlay/veil-view.ts` (render `liveOpText` — one line; BL owns).

**Depends on.** SH, TK, LD, BL, **SU** merged (the Boost copy deck from F2b is SU-owned; the Diagnostics slot). Renders
honest unavailable states until PC (`plan`, `boost`), RO (`own`, `today`, `catchUp`), PH (`surface`) land.

**Steps:**

1. **Gallery scenarios** (`fixtures-live.ts`), built on the owner-approved direction boards of TK step 0 (the owner
   sign-off already happened; this step confirms the wired version): the 20 postures incl. `day-off` (user days off
   only) and `done-for-today` with its late-start and zero-volume light-day next lines; boot (splash, the landing behind
   the splash, slow IG → placeholder, slow data deadline, signed out, data unavailable); first-run checklist; Boost
   (ready, ready-but-nothing-to-shift disabled, on, waiting, **paused**, backlog, unavailable); catch-up running; away
   feed; practice mode; actions unconfirmed; heights 640/800/920/1200 and widths 1024/1440/1920.
2. `posture.ts` refinements on F2b's table (copy, edge cases) with L-POSTURE (`day-off` only from `plan.day.dayOff`),
   L-PRIMARY, L-COUNTDOWN; `attention.ts` (`KNOWN_BLOCK_KEYS`, `classifyBlock`, incl. `actions-unconfirmed`) with
   L-ATTENTION (grep every `blockRuntime('…')`, `stopForIncident('…')`, `.block('…')` literal under `src/main/**`;
   parity with `haltReasonKey(ALL_HALT_REASONS)`).
3. The zones (spec §12.2) with fixed heights and reserved slots; `NumberTicker.armed` (no roll on the first value;
   `onIncrease` for the "+N" chip); the ring modes via `armDeadline`; the plan strip (one WAAPI now-marker animation;
   the Boost band); `BoostControl` (**one tap with `prefs.boost.hours`**, the preview line, "Change length in
   Settings", one-tap End, the disabled `nothing-to-shift`/`backlog` states, `paused`; copy from `copy/boost.ts`;
   `previewBoost`/`startBoost`/`endBoost`) — the Now-zone `⚡ Boost` pill is an indicator only; Results (hero, spark
   hidden until plan-day buckets, followers line with age, L-FRESH); the feed (groups, divider, FLIP inserts, "↑ N
   new", expansion); Get started; footer; `CompatibilityNotice` placement (PH's component).
4. Copy tables (spec §12 and Appendix C) with L-COPY (no banned words, no raw keys, headline ≤ 15 chars, no literal
   durations or counts — numbers come from projections; one word per concept). `liveOpText` wording for every
   `LiveOp` incl. the visit purposes (check-back · verify · settle · seed); the veil renders the same sentence; the
   Phase F `toVeilInfo` identity test is rewritten to the new wording.
5. Boot UI: the inline splash in `index.html` (`#boot` sibling before `#app`, inline styles only); `BootGate`
   (readiness R4 ∧ R5 with `boot.ig`, captions on `BOOT_UI` delays, `bootRevealed()` exactly once); `intro.ts` (spec
   §12.8 choreography; numerals at their true values; reduced motion → cross-fade); `LivePlaceholder` (loading /
   offline + Try again); gallery mode removes `#boot` at once; `useTourGate` opens after the reveal.
6. `DiagnosticsPanel` (filter, search, pause, copy, open folder, incidents; `useLogTail` pulls `logTail` on mount and
   streams only while mounted).
7. Delete `OverviewView`, the overview cards, their copy modules and the helpers left without importers (one commit);
   `engine-view.ts` superseded by posture.

**Acceptance.** `sidebar-liveness` (a pushed `status`/`feed`/`activity` moves the rendered value with no pull);
`sidebar-zones` (every posture renders its headline and primary; skeletons for `not-built` — L-ZERO; Get-started rules;
Boost states incl. paused and disabled; reason line; the Why? popover clamped to the sidebar on Live; Stop shows an
Undo toast); `boot-gate.test.tsx` (the splash stays while `starting` and until R5 or its deadline; `covered = true`
until the reveal; `bootRevealed` exactly once; `setStage('tab', false)` only once the tab settled; `phase:'live'` at
mount → no intro; `revealBy` → skeletons or the placeholder); `feed-render.test.tsx`; every gallery scenario renders;
no orphan left behind.

**Gates.** `npm run check`; `node scripts/background-probe.mjs --soak-ms 10000`; the visual checks of spec §20.5 in the
isolated profile (`EPO_USER_DATA_DIR`, `EPO_BLOCK_NETWORK=1`), recorded in the commit body.

---

## Phase I — Integration (lead)

### I.1 Merge order

Streams finish at different times; the lead merges each branch into `overhaul/integration` in this order (a stream
that finishes early rebases and waits for its slot). After **every** merge: regenerate the generated files (I.2, with
`--against overhaul/integration`), run `npm run check`, record boundaries per rule, and push the integration branch so
the remaining worktrees rebase. **Every merge is green by construction**: the old renderer compiles against the frozen
v1 `Settings`, the old `checkSeed` shape and the deprecated-optional status fields until the UI streams delete their
readers, and every field removal the old UI reads waits for the removal sweep (#26).

| # | Merge | Why here |
|---|---|---|
| 1–5 | F1a → F1b → F2a → F2b → F2c | foundations (F2c seeds the static-timing allow-list on the merged F2b head) |
| G0 | the owner's answers recorded in spec §18.2 | no P stream but CF starts before it |
| 6 | CF | live precondition; independent of every owner answer |
| 7 | TK | after the owner signed off the direction boards (TK step 0); every renderer stream styles against the tokens |
| 8 | PC | unwired plan core (needed by PR, RO-b, SC previews) |
| 9 | SC | the app runs on the v2 document behind the transitional adapter; honest save failures |
| 10 | PP-a (S1, then S2) | destructive-hazard fixes early |
| 11 | PH (corpus commits first, then the rest) | PP-b needs the corpus |
| 12 | UD-a | protection on every path (`capabilities.protectionEverywhere`) |
| 13 | RO-a | growth log and frontiers store (backfill runs at next open) |
| 14 | BL | boot sequence (landing behind the splash), stage controller, store-first identity |
| 15 | LD | feed, activity relay, projections dedupe/expiry |
| 16 | SH | stage hosting, People, tour (the console column still renders `OverviewView`) |
| 17 | UD-b | journal + verify-at-act + **F6** (live precondition); creates the lifecycle-reachable checkpoint test |
| 18 | PR S1 | one writer (pace unchanged); the plan-backed `PlanDayClock` swapped in |
| 19 | PR S2 | the cadence switch (I1 red→green); legacy pacer and `legacyCarry` gone; `reentry` out of PR's files |
| 20 | RO-b | the sweep, the following check, the launch catch-up; deletes the watcher-only modules and `reentry.ts` |
| 21 | PR S2b | the activity clock (after PP-a's `profile-visit.ts` changes) |
| 22 | PR S2r | the retirements and the golden rewrite (after RO-b and S2b removed the last consumers) |
| 23 | PP-b | one parser + recovery (flips one commit each) |
| 24 | SU | the Settings stage; deletes the old settings UI and the transitional adapter; re-types `checkSeed` |
| 25 | SB | the live column, splash and intro, Diagnostics; deletes `OverviewView` and the overview cards |
| 26 | removal sweep (I.3b) | the deprecated fields the old UI read |
| 27 | closing tasks (I.4) | — |
| after Phase L | PP S8 (legacy extractor deletion) | gated by L1 + L4 evidence |

**Per-merge checks** (besides `npm run check`): from #17 to #22 the lifecycle-reachable checkpoint test (a due
lifecycle unfollow executes; no reconcile phase wedges admission); after #18 every `PlanDayClock` consumer is
plan-backed; boundaries ≤ 100 and never above the previous merge's count.

### I.2 Generated files and shared tables (never hand-merge)

| Artifact | On conflict |
|---|---|
| `tests/tooling/line-budget.allow.json` | `node scripts/gen-line-budget.mjs --against overhaul/integration`; it refuses any upward entry |
| `tests/tooling/static-timing.allow.json` | `node scripts/gen-static-timing-allow.mjs --against overhaul/integration` (prune-only; moved literals were re-keyed with `--move` in the stream) |
| `tests/tooling/pending-wiring.json` | union of additions, minus the entries each merge wires; empty at I.4 |
| `src/adapter/page/bundle.generated.ts` | `npm run build:page` (only CF edits page sources) |
| `src/renderer/styles/tokens.generated.css` | `npm run gen:tokens` (only TK edits `scale.ts`) |
| `src/renderer/styles/index.css` | order fixed in F2b; streams never reorder; SU and SB each remove one `@import` line (declared touches) |
| `src/renderer/ui/icons.ts` + the `REQUIRED` list | union of additions (SH owns; others append) |
| `tests/kit/render-bridge.ts`, `src/renderer/gallery/*` scenario modules, `Gallery.tsx`, `gallery-bridge.ts` | union; F2b added every method and channel; SH owns `Gallery.tsx`/`gallery-bridge.ts` |
| `tests/renderer/view-liveness.test.tsx` | union of appended cases; SH owns |
| `tests/kit/engine-harness.ts` + `harness-{plan,journal,reopen}.ts` | split in F1a; each part has one owner (PR, UD, RO); the core changes only through the lead |
| `tests/engine/engine.test.ts`, `tests/main/mutation-policy.test.ts` | PR owns; other streams append their own `describe` blocks (union) |
| `tests/engine/prune-engine.test.ts` | UD owns; other streams append their own `describe` blocks (union) |
| status contributors, startup steps | **returned** by each stream's wiring module and aggregated in `graph-builder.ts` (no shared list) |
| IPC tables, `GUARDS`, `PROJECTIONS`, `META_KEYS`, migrations | Phase F only; a stream needing a change asks the lead |
| `ENGINE_WAIT_CLASS` + noise-registry key lists | PR owns; UD's single key removal is a minimal touch |
| `PROGRAM` + the rules order test | UD only |
| ADR numbers | pre-allocated (spec §19) |
| `docs/HANDOFF.md`, `docs/PRINCIPLES.md` | Phase I only (RO drafts the PRINCIPLES text) |
| spec §18.2 answers | the lead, at G0 |

### I.3 Hotspots with minimal touches (resolve by applying the owner's version, then the minimal hunk)

`src/main/foundation-wiring.ts` (BL; SC, UD, LD touch) · `src/engine/engine.ts` (PR; UD, RO delete lines) ·
`src/engine/prune-engine.ts` (UD; PR, PP touch) · `src/engine/engine-actions.ts` (PR; CF's F7 branch) ·
`src/engine/engine-waits.ts` (PR; UD) · `src/engine/status-projection.ts` (PR; LD) · `src/engine/facts.ts` (PR; UD) ·
`src/engine/ports.ts` (RO; UD) · `src/adapter/mutation-watch.ts` (PP; CF) · `src/rim/profile-visit.ts` (PP; PR S2b) ·
`src/rim/list-page-walker.ts` (PP; PR S2b) · `src/rim/feed-capture.ts` (RO; PR S2b) · `src/rim/profile-enricher.ts` (PR;
PP) · `src/rim/follower-acquisition.ts` (PR; PP) · `src/settings/{doc,effective,mappers}.ts` (SC; PR S2, UD, RO) ·
`src/main/services/graph-builder.ts` (BL; PR, RO, UD) · `src/main/services/unfollow-wiring.ts` (UD; PR) ·
`src/main/modules/prune-control.ts` (PR; PC, UD) · `src/timing/schedule-manager.ts` (PR; RO) ·
`src/engine/source-frontier.ts` (SC; BL) · `src/renderer/app/App.tsx` (SH; SB) · `src/renderer/views/PruneView.tsx`
(SU; TK) · `src/main/window/shell.ts` (BL; TK) · `src/main/overlay/veil-view.ts` (BL; SB) · `src/kernel/tempo/**`
(frozen after F; PR's S2/S2b touches). Every at-ceiling file must stay line-neutral or shrink; re-seed downward.

### I.3b The removal sweep (merge #26, after SU and SB)

One commit, lead or a short agent: delete `EngineStatus.pacing` and `EngineStatus.reentry` (and `netToday` if the
sidebar no longer reads it), the frozen v1 `Settings` export from `src/types.ts` once nothing in `src/renderer` reads it
(SU's last commit may already have done so), and any remaining `@deprecated-renderer` marker; `npm run check` green;
boundaries recorded.

### I.4 Closing tasks (before Phase L)

1. **Composition checks** (new tests in `tests/main/composition.test.ts`): every `SettingsCapabilities` flag is true in
   the fully composed graph; the five `PROJECTIONS` rows push; every `StatusFields` member is populated by some
   contributor when built; `BuiltGraph.startupSteps` includes `catch-up`; **every `PlanDayClock` consumer is the
   plan-backed clock**; the `SurfaceGate` and `preflight` seams are the real implementations; `pending-wiring.json` and
   `PENDING_CONSUMERS` are empty.
2. **Nothing hardcoded**: `static-timing.allow.json` holds only `GEOM` and `HARNESS` entries with reasons (spec §17
   legend); `grep -R "@transitional" src` is empty; no `Math.random` outside the renderer except the entropy root; every
   spec §17 row marked DEL is gone (`grep` per name; rows reading "one declaration" are checked for exactly one).
3. **Docs**: finalize every ADR in spec §19 and append the amendments; `docs/PRINCIPLES.md` §1/§3 edits; one
   `docs/HANDOFF.md` entry (newest first, house format: owner's words, symptoms, root causes numbered, `FIXES (ADR …)`
   bullets, what was verified, test and boundaries counts); a validation record `docs/qa/plan-derived-overhaul-2026-11.md`
   linked from it (incl. how to use the isolated profile); the release card notes (new `epo-settings-v2.json`; v1
   untouched; downgrade restores the 3–7 min floor; protection now covers every path; Steady intervals retired; the
   "Prune" tab is now "Clean up").
4. **Full gates**: `npm run check` green; `npm run knip` (advisory) reviewed; `node scripts/plan-qc.mjs`;
   `node scripts/background-probe.mjs --soak-ms 10000` (every scenario incl. `stage-hidden` and `never-shown-boot`;
   the dashboard pacing guard ≤ 150 callbacks/s); the visual checks (spec §20.5) **in the isolated profile**
   (`EPO_USER_DATA_DIR`, `EPO_BLOCK_NETWORK=1`) — never the real `userData`.
5. **Review**: run a high-effort code review over `git diff feat/plan-derived-overhaul...overhaul/integration`
   (correctness first: protection never bypassed, no destructive verdict from C2/partial, no read before preflight, no
   tab work before the reveal beyond the landing, no automatic day above `automaticDayMax`, no IG literal outside
   `versions/*`); fix findings in follow-up commits; re-run I.4.4.
6. **Owner confirmation** of the wired gallery against the approved direction boards and of the answers recorded at
   G0 (spec §18.2) — a confirmation only; every behaviour-changing question was answered before Phase P.
7. Checkpoint: `refs/backups/pre-live-plan-overhaul-2026-11` (temporary index → `write-tree` → `commit-tree` →
   `update-ref`), then fast-forward `feat/plan-derived-overhaul` to `overhaul/integration`.
8. Owner session (not an agent): update memories `unified-transport-and-bio-keep-list` (protection on every path) and
   `session-robustness` (superseded parts).

---

## Phase L — Live tests (lead only, strictly sequential, owner present)

Run exactly spec §22. Restated as the lead's checklist:

1. **Preconditions.** Phase I complete; CF and UD-b (F6) merged; the build under test is the integration head; Epo
   quit; no other worktree or tool running Electron; outputs to `"$SCRATCH/live/<step>"` (the session scratchpad,
   never a worktree); `epo-runtime.json` still `desired: stopped` until L4. **The integration build has never opened
   the real `userData` before this point** (every earlier launch used the isolated profile); back up
   `~/Library/Application Support/Epo/` (store + `epo-settings.json`) to the scratchpad first — the first real launch
   migrates the store past what the installed release can open and writes `epo-settings-v2.json`.
2. **L0** offline gate (all green or stop).
3. **L1** `EPO_PROBE=verify EPO_PROBE_TARGET=<public account the owner follows, mutual preferred; one with an empty
   bio if the owner can name one> EPO_PROBE_OUT="$OUT" npm run probe` — once. It verifies **parsing only** (the probe
   drives its own actor with its own settles, so the plan's timings are checked in L4/L5): `biography` and
   `is_verified` present on both bodies; review `verify.json`, `traffic.json`, the run log against the pass list. Stop
   on any stop criterion; root-cause offline; never re-run the same day.
4. Wait ≥ 1 night with Epo quit. **L4** supervised production relaunch: `npm run start` from a terminal; tail
   `~/Library/Application Support/Epo/logs/runtime.jsonl`; screen-record the launch; the owner presses Start after the
   catch-up completes. Check every L4 pass item (the landing behind the splash; exactly one head page on this first
   launch; the drawer's step pauses; a Boost left on shows `paused` while stopped); stop on any stop item.
5. **L5** (owner consent recorded): let the engine take its already-due unfollows (the stranded Requested record, the
   next public, the next private). Check the look-before-act dwell before each header press and a step pause before
   each confirm-layer press (the plan-backed tempo). Pause the engine at once on any stop item.
6. **L5b** (optional): a short Boost (one tap, the saved length), ended early.
7. After L1 + L4 show 0 `shadow-disagreed`: merge PP S8 (the legacy extractor deletion) through Phase I's gates.
8. Record everything in `docs/qa/plan-derived-overhaul-2026-11.md`; update the HANDOFF entry with what was verified
   live.

Do-not-run list: spec §22. A failed live step never triggers a retry loop: stop, collect evidence offline, fix the
root cause, and re-enter at L0.

---

## Appendix A — Phase F seams (ports with today's behaviour)

Every seam a stream consumes before another stream implements it is created in Phase F, so no stream invents its own
version.

| Port / seam | Defined in (F) | Default behaviour (= today) | Real implementation | Swapped at |
|---|---|---|---|---|
| `TempoSource` (incl. `enabled()`) | F2a `src/kernel/tempo/source.ts` | `referenceTempoSource()` (identity; added sites off) | PC `planTempoSource` | PR `plan-wiring.ts` (S2) |
| `MotionPolicy` per gesture | F2a `src/kernel/tempo/motion.ts` | `MOTION_REFERENCE` | PC via `TempoSource.gesture()` | PR (S2) |
| `PlanDayClock` | F2a `src/kernel/plan/types.ts` + `src/governors/plan-day-clock.ts` | local midnight (`calendarPlanDayClock()`) | PC `PlanService.planDayClock()` | PR `plan-wiring.ts` (S1) — the one swap site for UD, RO, PH, LD |
| `JournalGate` | F1a `mutation-admission.ts` | today's global reentry check | UD `journal.ts` (per account) | UD `unfollow-wiring.ts` |
| `SurfaceGate` + `PausedActivity` (incl. `exploration`) + `NEVER_PAUSED` | F2a `src/shared/surface-gate.ts` (re-exported by F2b's `surface-health.ts`) | never paused | PH `createSurfaceGate` | PH `surface-wiring.ts` (click review and plan mix) |
| click-review `preflight(kind, writer, now, subject)` port (before the visit) | F2a `click-review.ts` | admits (today's checks stay at `beforeMutation`) | PR `MutationCadence.preflight` | PR `unfollow-wiring.ts` (S2) |
| click-review `surfaceGate` dep | F2a `click-review.ts` | `NEVER_PAUSED` | PH | PH `surface-wiring.ts` |
| requester predicate `hasActiveRequest(pk)` | F1a churn deps (`churn-pick.ts`) | always false | RO `relationships.ts` | RO `reopen-wiring.ts` |
| `boostActive()` for prune-control | F1a `prune-control.ts` deps | false | PC | PC minimal touch (the guard) + PR `plan-wiring.ts` |
| protection predicate (`unfollow-protection.ts`) | F2b `src/shared/` (pure, with L-PROT) | — (used by the migration and `protection()`) | — (UD wires it) | UD `unfollow-wiring.ts` |
| `SettingsService.protection()` | F2b (re-typed `settings-service.ts`) | v1 lists compiled with the **new** predicate | SC (from the v2 document) | in place |
| `SettingsService` | F1a `settings-service.ts` (v1 types) → F2b (re-typed) | v1 semantics | SC (v2 internals) | in place |
| `posture.ts` (`derivePosture`, `postureHeadline`) | F2b `src/shared/` (pure, with L-POSTURE) | — | SB (refinements) | BL title/badge, SB renderer |
| `readDrawerBody` | F2a `src/adapter/drawer-read.ts` | today's extractors (lenient) | PP (strict; tiers; sibling) | in place (PP owns the file) |
| `SurfaceSink` | F2a `src/surface/sink.ts` | `NO_SINK` | PH production sink | PH `surface-wiring.ts` |
| `PlanPreviewPort` | F2a `plan-types.ts` | none (capability `plan` false) | PC `PlanService.previewDays` | PR `plan-wiring.ts` |
| `EnginePlan` / `PlanFacts` | F2a `plan-port.ts` | unconsumed | PC + PR | PR `facts-plan.ts` (S1) |
| status contributors | F2b `BuiltGraph.statusContributors` (aggregated in `graph-builder.ts`) + `status-compose.ts` | only `basis` | each stream | **returned** by each stream's wiring module (`plan-`, `reopen-`, `unfollow-`, `surface-`, `live-wiring.ts`) |
| startup steps | F1a `startup-steps.ts` + F2b `BuiltGraph.startupSteps` | landing + resume (today's) | BL (sequencer, confirm), RO (catch-up) | BL `launch.ts`; RO `reopen-wiring.ts` (returned) |
| `ActionReviewedError` → `reviewed` outcome | F2a | never thrown | UD `click-review.ts` | in place |
| walker hooks `stopAfterPage`, `readUse` | F2a | unused | RO (head walk), PR (`use` tags) | callers |
| kernel skeletons `rng.ts`, `settings-policy.ts`, `reentry-policy.ts`, `census-policy.ts`, `input-probe.ts` | F2a | today's values | SC / RO / PP complete them | in place |
| `useKeepAlivePoll` `onError`, `copy/boost.ts` | F2b renderer kit | — | SU (copy), SH (hook) | in place |
| isolated-profile launch mode | F1a `app-identity.ts`, `ig-session.ts` | off unless `EPO_USER_DATA_DIR` / `EPO_BLOCK_NETWORK` set | — | every pre-Phase-L launch |
| `pending-wiring.json` + the `no-orphans` hook | F2b | F's own unwired modules | each stream adds/removes its entries | empty at I.4 |
| IPC handlers (all new channels) | F2b `ipc-*.ts` stubs | typed fallbacks (`checkSeed`: today's shape) | SC, PC, BL, LD, PH | their `ipc-*.ts` |

## Appendix B — File ownership index (after Phase F)

A file appears under exactly one owner. Phase F files not listed again are handed to the stream named. "(new)" files
are created by their owner. Shared test files with a named owner accept appended `describe` blocks from other streams
(the union rule of I.2).

| Owner | Files |
|---|---|
| **PC** | `src/kernel/plan/*` (except `types.ts` content changes: ask), `src/kernel/derive-lifecycle.ts`, `src/kernel/derive-reads.ts`, `src/governors/plan-{state,view,service,projection,preview,boost,day-clock}.ts`, `src/timing/{tempo-source,circadian,distributions}.ts`, `src/settings/plan-intent.ts`, `src/main/modules/boost-control.ts`, `src/main/ipc-plan.ts`, `src/shared/{plan-projection,boost}.ts`, `scripts/plan-qc.mjs`, `tests/kit/plan.ts` |
| **PR** | `src/main/services/{plan-wiring,mutation-cadence,mutation-admission,mutation-policy}.ts`, `src/main/modules/{plan-control,prune-control}.ts`, `src/main/foundation-reads.ts`, `src/governors/{rate-governor,read-budget}.ts`, `src/settings/{read-allowance,legacy-pacing-migration}.ts`, `src/engine/{pacers,decisions,engine-waits,facts-plan,plan-mix,plan-port,engine-actions,engine,status-projection,status,facts,prune-pacing,target-pipeline,target-recovery,exploration-policy}.ts`, `src/rim/{ig-activity-clock,profile-enricher,follower-acquisition,own-followers-target-source}.ts`, `src/timing/{session-planner,cycle-plan,action-gap,primitives,noise,page-pacing,delay-manager,schedule-manager,wait-runner}.ts`, `src/kernel/{derive,policy,overrides,derive-provenance,registry-changes,exploration-policy}.ts`, `tests/kernel/derive-golden.test.ts`, `tests/integration/plan-*.test.ts`, `tests/kit/harness-plan.ts`, `tests/engine/engine.test.ts`, `tests/main/mutation-policy.test.ts`, `scripts/{timing-qc,motion-qc}.mjs`, `src/tools/readme/live-charts.ts` |
| **SC** | `src/kernel/{settings-policy,derive-envelope,derive-schedule,derive-audience,catalog}.ts`, `src/settings/{resolve,params*,view,view-options,basis,ops,ops-protection,persist,v1-adapter,doc,doc-rules,migrate-v1,migrate-v1-lists,effective,mappers}.ts`, `src/settings/v1/*` (frozen), `src/settings/settings.ts` (shim), `src/main/modules/{settings-service,settings-reload,settings-facts,seed-check,protection-linker}.ts`, `src/main/ipc-settings.ts`, `src/store/repos/protection-facts.ts`, `src/engine/{scorer,chain-controller,source-frontier,scanner}.ts`, `src/rim/target-discovery.ts`, `src/shared/{settings-intent,settings-model,settings-params,settings-params-tempo,settings-view,settings-ops,settings-facts,seed-check}.ts` |
| **SU** | `src/renderer/settings/**` (except `compatibility/*`), `src/renderer/hooks/{useSettingsView,useSettingsFacts,useSettingsCommit,useSuggest}.ts`, `src/renderer/ui/{RadioCards,TimeSelect,DayChips,TokenList,SaveStatus}.tsx`, `src/renderer/copy/boost.ts`, `src/renderer/styles/settings-stage.css`, `src/renderer/gallery/settings-fixture.ts`, `src/renderer/views/PruneView.tsx`, `src/renderer/cards/prune/*`, the old settings UI and its orphaned atoms (to delete) |
| **UD** | `src/shared/{unfollow-protection,click-verdict}.ts`, `src/engine/{protection-port,protection-gate,protection-reconciler,click-verdict,journal,churn-scheduler,churn-pick,churn-types,prune-candidate,prune-feed,prune-engine,rules,lifecycle-rules,rules-prune,engine-journal-effects,facts-journal,recovery-healer}.ts`, `src/kernel/derive-parks.ts`, `src/rim/{journal-settlement,churn-actions}.ts`, `src/main/services/{click-review,unfollow-wiring,prepare-mutation}.ts`, `src/store/repos/{follow-records,effect-intents}.ts`, `tests/kit/harness-journal.ts`, `tests/engine/prune-engine.test.ts`, `tests/integration/lifecycle-reachable.test.ts` (PR keeps it green after UD-b), the files UD deletes (`reconciliation-runner`, `prune-whitelist` ×2, `prune-bio-filter`) |
| **RO** | `src/kernel/{derive-reentry,reentry-policy}.ts`, `src/store/repos/{growth,reopen-state,relationships,analytics,census}.ts`, `src/store/folds/growth.ts`, `src/store/{knowledge-store,knowledge-store-base}.ts`, `src/shared/{followback-outcome,reopen-view}.ts`, `src/engine/{source-quality,sweep-plan,frontier-sweep,followback-watcher,followback-types,facts-cadence,engine-sweep-effects,ports,reentry}.ts`, `src/rim/{feed-watermark,followers-head,following-check,feed-capture,follow-notifications,request-acceptance,walk-own-list}.ts`, `src/main/services/reopen-wiring.ts`, `src/main/modules/catch-up.ts`, `tests/kit/{reopen,harness-reopen}.ts`, `docs/PRINCIPLES.md` (draft), the modules RO deletes (`reconcile-followback-cohort`, `managed-relationships`, `effect-reconciliation`, `reentry`) |
| **PP** | `src/surface/{read,transport,recovery}/**`, `src/surface/schema/*`, `src/surface/{index,parse,health,shadow}.ts`, `src/surface/versions/2026-08-12/{surface,projectors,schemas,literals,literals-json,literals-signals,continuation-decl,transport-decl,containers,expected,recovery-decl}.ts`, `src/adapter/{reader,reader-shadow,reader-relationships,observed-reads,fetch-json,envelope,mutation-classify,surface-types,ig-surface,mutation-watch,drawer-read}.ts`, `src/adapter/versions/*`, `src/rim/{list-page-walker,list-walk-end,list-walk-types,followers-page-reader,profile-observer,profile-visit,profile-visit-port,relationship-reconciler}.ts`, `src/engine/{census-authority,prune-scan-guards}.ts`, `src/main/services/own-stats.ts`, `src/shared/observed-relation.ts`, `src/kernel/{census-policy,surface-policy}.ts`, `src/probe/{verify,recorder,traffic,probe-main}.ts`, `src/capture/classify.ts`, `tests/kit/surface.ts` |
| **PH** | `src/surface/lab/**`, `src/surface-lab/**`, `src/surface/versions/2026-08-12/scrub-shapes.ts`, `src/surface/{sink,health-view,meter}.ts`, `src/store/repos/surface-drift.ts`, `src/main/services/{surface-wiring,surface-health-sink,surface-report}.ts`, `src/main/ipc-surface.ts`, `src/shared/{surface-health,surface-gate}.ts`, `src/renderer/settings/compatibility/*`, `src/renderer/live/CompatibilityNotice.tsx`, `src/renderer/hooks/useSurfaceReport.ts`, `src/renderer/styles/compatibility.css`, `src/renderer/gallery/fixtures-surface.ts`, `tests/fixtures/surface/**` |
| **CF** | `src/adapter/{action-admission,unfollow-flow,actor,actor-scroll,response-watch,confirm-capture}.ts`, `src/adapter/page/**` + `bundle.generated.ts`, `src/surface/versions/2026-08-12/{controls,literals-dom}.ts`, `src/engine/mutation-outcome.ts` |
| **BL** | `src/main/window/{shell,stage-controller,app-menu}.ts`, `src/main/{launch,main,app-identity}.ts`, `src/main/bootstrap.ts` (one import), `src/main/modules/{boot-sequencer,startup-steps,session,status-compose,not-built}.ts`, `src/main/overlay/*`, `src/main/services/{tab-lease,runtime-coordinator,dashboard-recovery,runtime-log,startup-failure,graph-builder,graph-types,ig-session}.ts`, `src/main/foundation-wiring.ts`, `src/main/ipc-boot.ts`, `src/main/ipc.ts`, `src/kernel/{boot-policy,runtime-bounds}.ts`, `src/store/open-error.ts`, `src/shared/{boot,stage-mode,status-fields,live-op}.ts` (`live-op.ts`: types; SB owns the `liveOpText` wording), `scripts/background-probe-main.ts` |
| **LD** | `src/main/modules/{activity-relay,feed-projection,log-ring,projections,updater}.ts`, `src/main/{update-core,updater}.ts`, `src/main/services/live-wiring.ts`, `src/main/ipc-live.ts`, `src/store/repos/feed-reads.ts`, `src/shared/{feed,update-status}.ts`, `src/kernel/live-policy.ts`, `src/engine/resume-target.ts` |
| **TK** | `src/renderer/design/*`, `src/renderer/styles/{tokens.palette,tokens.generated,fonts,base,controls,shell,graph,chain,queues,prune,overview,tour,gallery}.css`, `src/renderer/fonts/*`, `esbuild.config.mjs`, `src/renderer/lib/{motion,stagger}.ts`, `src/renderer/gallery/direction/**`, `src/kernel/shell-geometry.ts`, `src/shared/brand-mark.ts`, `src/renderer/ui/EpoMark.tsx` (`overview.css` is restyled by TK and later deleted by SB) |
| **SH** | `src/renderer/app/**`, `src/renderer/pages/**`, `src/renderer/cards/{chain,queues}/*`, `src/renderer/charts/*`, `src/renderer/graph/palette.ts`, `src/renderer/ui/{icons,Skeleton}.ts(x)`, `src/renderer/lib/{anchor,play,deadline-anim,flip}.ts`, `src/renderer/tour/*`, `src/renderer/hooks/{useLiveFeeds,useStageRequest,useChainList,useTargetDetail,useGrowthSeries,useQueue,useKeepAlivePoll}.ts`, `src/renderer/styles/people.css`, `src/renderer/gallery/{Gallery.tsx,gallery-bridge.ts}`, `tests/renderer/view-liveness.test.tsx`, the old shell parts and views (to delete; not `OverviewView`) |
| **SB** | `src/shared/{posture,attention}.ts`, the `liveOpText` wording in `src/shared/live-op.ts`, `src/renderer/sidebar/**`, `src/renderer/boot/**`, `src/renderer/diagnostics/**`, `src/renderer/{index.html,index.tsx}`, `src/renderer/ui/NumberTicker.tsx`, `src/renderer/lib/ticker.ts` + `tests/renderer/ticker.test.ts`, `src/renderer/hooks/{useTourGate,useControl,useCountdown,useTransportControls,useEngineStatus,useUpdateStatus,useUpdateToasts}.ts`, `src/renderer/styles/{sidebar,boot,diagnostics}.css`, `src/renderer/gallery/fixtures-live.ts`, `src/renderer/views/OverviewView.tsx` + `src/renderer/cards/overview/*` + their only-importer helpers (to delete) |
| **Phase F only** | `src/ipc/**`, `src/store/schema/**`, `src/store/{types,rows,spans}.ts`, `src/store/repos/{meta,accounts}.ts`, `src/kernel/{store-policy,tempo-policy,motion-roles,motion-policy,rng,input-probe}.ts`, `src/kernel/tempo/**`, `src/interaction/**`, `src/adapter/{tab-interactor,instagram-adapter,actor-types,activity-reporter,errors,tab,tab-ports}.ts`, `src/governors/plan-types.ts`, `src/timing/config.ts`, `src/utils/entropy.ts`, `src/renderer/styles/index.css`, `tests/kit/{engine-harness,render-bridge,store,configs,main-harness,tempo}.ts`, `tests/tooling/**`, `scripts/{gen-static-timing-allow,gen-line-budget}.mjs`, `.dependency-cruiser.mjs` — after Phase F these are frozen except the minimal touches named in the stream specs (and the union artifacts of I.2); any other change goes through the lead as a small integration commit |

Notes: `src/engine/{target-pipeline,target-recovery}.ts` wait-base edits were F2a's; afterwards PR owns them.
`src/rim/{profile-visit,followers-page-reader,list-page-walker,feed-capture,follow-notifications,request-acceptance}.ts`
tempo edits were F2a's; afterwards PP or RO own them as listed. `src/adapter/actor.ts` LiveOp edits were F2a's;
afterwards CF owns it. `src/timing/noise.ts` has one owner (PR); `mulberry32`/`fnv1a` live in `src/kernel/rng.ts` and
`noise.ts` only re-exports them. `src/engine/scanner.ts` and `src/rim/target-discovery.ts` are SC's. The updater lives
in `src/main/{update-core,updater}.ts` and `src/main/modules/updater.ts` (LD).

## Appendix C — Stream PR description template

```
## <code> — <stream name>
Spec: §… · ADR(s): … · Depends on: … (merged at <sha>)
### What changed
- …
### Tests and laws added
- …
### Minimal touches
- <file> — <why>
### Gates
npm run check green: <N> tests · boundaries 0 error, <M> warn (renderer-allow-list a, no-circular b, orphans c, …) ·
line-budget: <entries> (↓) · static-timing allow-list: <entries> (↓) · <stream-specific gate results>
### Not done / follow-ups
- …
```
