# Epo v4 — the framework (design, 2026-09-02)

**Owner's brief (verbatim):** "fundamentally look through the way EVERYTHING is constructed from the
ground up to create a totally new framework for Epo that makes everything correct, safe, and
maintainable by DESIGN. constants are basically produced by the fundamentals of the codebase.
everything is in the absolute latest versions of frameworks, dependencies, etc. with cutting edge
coding principles." Then: "Ideate in parallel with parallelized agents to create this."

**Method.** Five parallel ideation lenses (type-driven correctness · domain model and event log ·
runtime kernel and derived pacing · Instagram surface and automation · app shell, UI, toolchain),
each grounded in the repo, the 22 ADRs, and `npm view` for every version claim. This document is
the synthesis: the decisions, the kernel, and the build order. The five proposals live in the
session scratchpad; their load-bearing findings are reproduced here.

## 0. The thesis in five lines

1. Epo's design is already correct; it is enforced in prose (PRINCIPLES §1–§3, ADR 0205, 0206,
   0303). v4 moves each rule from a comment into a type, a table, or a gate that refuses to compile
   or pass when violated.
2. The stack is already current (`npm outdated` lists four rows, two of them patches). "Latest" on
   the wrong axis is the real defect: `@types/better-sqlite3@9` types a v13 runtime and
   `@types/node@26` types Electron's Node 24. v4 makes version truth a **test**, not a bump list.
3. Zero new runtime frameworks. Effect, xstate, kysely/drizzle, Vite/Vitest, pnpm workspaces,
   Storybook, electron-trpc and Playwright-at-runtime were each evaluated and rejected on measured
   grounds (§7). Two runtime additions: `zod@4` (boundary parsing) and `@preact/signals`.
4. **Constants are derived.** ~12 empirical quantities + 5 policy numbers reproduce today's
   hand-tuned tables exactly (caution caps 14/22/30, activity plans 15…100, `REENTRY_FAILS=2`,
   `BLOCKED_STREAK_ENTRY=3`, five adapter timeouts, `HOLD_SIGMA=0.25`) — and expose three defects
   the tables hid (§4).
5. `node:sqlite` works inside this repo's own Electron binary today (Node 24.18.1, SQLite 3.53.1,
   WAL, 20k `prepare()` in 24 ms vs 78 ms). It deletes the last native dependency and, with it,
   every rebuild script, `asarUnpack`, the ABI matrix and ADR 0503's open question.

## 1. Layering (what may import what)

```
kernel      imports NOTHING from src. brands/units · Outcome algebra · Res · Schedule-as-data ·
            Scope · parse (zod → Parsed<T> with drift evidence) · Module/Session composition ·
            fundamentals · policy · derive.
domain      pure vocabulary: ids · events · commands · folds · rules · projections registry.
store       node:sqlite driver · TableDef manifest · migrations (append-only, id-checked) ·
            events log + rebuild · Chronos (durable timers) · spans. SQL lives ONLY here.
surface     the versioned Instagram document: endpoint schemas (the schema IS the extractor),
            control descriptors, signals, mutations; page bundle (strategy interpreter);
            Verdict/Arbiter; SurfaceMeter. Every Instagram literal lives here and nowhere else.
adapter     tab (CDP, anti-throttling, input — UNCHANGED), actor, sentinel, response watch.
rim         ports over the adapter (walks, enrichment, actions).
runtime     one conductor: Facts → pure rules → Verdict → effect runner with policies;
            recovery as a Schedule; TabCap; modes (growth | prune-scan | prune-run).
main        bootstrap (survival switches — UNCHANGED), window/shell, Module graph, IPC.
ipc         CHANNELS + PUSH + GUARDS + PROJECTIONS — every channel name exactly once.
renderer    Preact 10 + signals; shell context; generated tokens; inline SVG icons.
shared      pure code the renderer and main both use.
```

Enforced by `dependency-cruiser` (a fifth gate, `npm run boundaries`): renderer → shared, ipc/contract,
renderer only; engine/runtime ↛ main/renderer/adapter; adapter ↛ engine/store/main; store → shared,
governors only; kernel → nothing; no cycles; no orphans. Line budget: no file over 300 lines without
an ADR reference; a monotone allow-list test seeded with today's violators.

## 2. The kernel (correct by design)

**Brands and units.** `Pk`, `OwnPk` (minted once at graph build), `TargetPk`, `Username`
(lowercase, never `@`-prefixed), `Ms`, `Fraction`, `PerDay`. `as Pk` is permitted only in
`src/store/**` row codecs (lint-enforced). Argument-order bugs in the reconciler become type errors.

**One outcome algebra.** Every layer's result is a projection of:
`Ok<A> | Refused{by, definitive} | Broken{by, clickMayHaveLanded} | Failed{by} | Interrupted`.
A `satisfies`-checked table maps each tag to a record effect (`transition | untouched | burn-retry`);
`applyOutcome` is the only writer of a follow record. `switch` + `absurd()` gives exhaustiveness
without `ts-pattern`. `Result<T>` with a string reason, `ChurnActionOutcome`'s optional causes,
`ActionRateLimitedError`/`ActionBlockedError` all delete.

**Lifecycle as a union.** `FollowRecord` becomes a discriminated union whose variants carry only the
timestamps that state can have; transitions are total functions between variants. (Phantom
generics rejected: the discriminant already is the phantom.)

**Parse, don't validate.** `zod@4` (`zod/mini` where the renderer reaches) at the four untrusted
boundaries: Instagram bodies, settings file, SQLite rows, IPC payloads. `parseWith(schema, label)`
returns `Parsed<T> = Ok | {drift: {at, expected, got}}` — `SHAPE_MISMATCH` keeps its meaning and
gains evidence; empty is a value, drift is not, and there is no third exit. Settings stay on the
`RULES` clamp table (ADR 0103): coercion is not validation.

**Capabilities as values.** `TabCap` (proof of tab ownership, minted only by the lease resource),
`BudgetToken` (one per authorised action, consumed by value), `Verdict` (proof the response — not
the optimistic DOM flip — arbitrated the click), `VerifiedWalk` (minted only by the walker at a
verified end of list; required for any retraction/absence verdict), `UnfollowPermit` (cannot be
constructed while the subject follows us). "One action per iteration", "record untouched on block",
"facts stream" and "verdicts wait" become signatures. Honest limit: single-use is runtime-checked
(TypeScript has no linear types) and property-tested.

**Effects without Effect.** `Res<A,E>` typed errors; `Schedule` as data
(`once | recurs | exponential | jittered | truncate`) — the recovery ladder is
`truncate(jittered(exponential(hold1, 1.5, cap), 'retry-backoff'), N)`; `Scope` (abort trees,
reverse-order finalizers) replaces generation tokens, `superseded()`, `owedResume`, `parkedNow`,
`awaitParked`. `EngineDeps` fields become required; tests get `testDeps()`.

**Composition without a container.** `Module<T, Deps> = { id, needs, build }` + `compose(roots)`
(topological start, reverse-order dispose, failed start disposes what started) + `Session<T>` (a
capability that appears on login and vanishes on logout; dependents are built around its
transitions). `Foundation`'s six lazy-build fields and ~40 `graph === null` guards collapse into it.

## 3. Data (the domain model)

**The event log becomes real, narrowly.** One `events` table (`seq, at, kind, source, v, payload`)
replaces `observations`, `username_history`, `action_ledger`, `prune_ledger` as the source of
truth; projection tables stay for reads; folds are named pure functions (the `COALESCE` defenses in
`follow_records`, `edges`, `accounts` were folds hand-inlined into SQL). `rebuildProjections()` from
a checkpoint; the fast-check property "incremental fold === batch rebuild" is a merge gate.
Confidence is `SOURCE_CONFIDENCE[source]`, never stored; `ratio` is a generated column; `role`
splits into ownPk / targets / an exclusions projection. Migration 13 lifts the real logs and mints
genesis events from current rows; the first open runs a shadow rebuild and diffs. No dual write.

**Per-field provenance.** `foldAccount` merges every field with one rule (strictly-better source
wins; newer-and-not-worse wins; older never rewinds) — fixing the acknowledged newest-wins hole
where a search read overwrites a profile username.

**Persistence.** `node:sqlite` behind a 30-line `SqliteDriver` port with a boot self-test (WAL on,
`user_version` readable, round-trip insert) that refuses to open rather than degrade. A `TableDef`
manifest generalises `ACCOUNT_COLUMNS` to every table: row types, codecs, upserts, and a boot-time
`PRAGMA table_info` assertion are derived. Migrations stay `{id, name, sql}`, append-only, future-
version refusal intact; DDL for new tables generated from the def, ALTERs hand-written.

**Read model.** One `PROJECTIONS` registry (each entry names the event kinds that invalidate it);
one push channel `{name, key?, payload}`; `useProjection('pruneStatus')` typed from the registry.
The throttle self-calibrates from measured fold cost (`clamp(8 × p95, 2 frames, 500 ms)`).

## 4. Constants produced by the fundamentals

Three tiers; nothing outside tier 1 may hold a magic number.

- **EMPIRICAL** (what we believe about the world; each entry carries `src` and `rev`):
  follow/unfollow wall per hour and per day (low/typical), soft-wall duration p50/p90, human
  session boundary, gap distribution (median, sigma), sessions per day, day-volume CV, rest-day
  rate, circadian shape; and quantities the app measures itself (hydration, mutation arrival, nav,
  control latency percentiles; ordinary fail/block rates) — seeded here, learned at runtime.
- **POLICY** (the five numbers the owner argues about): `SAFETY_MARGIN`, `DESYNC_WIDTH_MS`,
  `BURST_TOLERANCE`, `TIMEOUT_SLACK`, `CONFIDENCE`.
- **Derived**: caps (`round(W_h.typical × margin × k_caution)` → 14/22/30 exactly), daily plans
  (→ 15/30/50/75/100 exactly), gap floors and caps, the recovery ladder (`W_p50 × c × g^(n-1)` →
  1 h, 1.5 h, ≈2.25 h), every jitter sigma from one `DESYNC_WIDTH_MS` (`HOLD_SIGMA=0.25` and the
  daily-boundary jitter both), timeouts (`p99 × slack`) and poll intervals (`p50 / 4`) for five
  adapter constants, breaker thresholds as Bayesian posteriors (`REENTRY_FAILS=2`,
  `BLOCKED_STREAK_ENTRY=3`, drift-needs-two-windows, `ACTIONS_FAILING_HALT` derives to 7 vs 8),
  retention (`3 × (followbackWait + hold)`), batch sizes from `LIST_PAGE_ROWS`, scroll step from
  viewport height, `LIST_PAGE_COUNT` learned by AIMD (a server tolerance, not a latency).

**Defects the derivation exposes (fix, don't hide):** (a) `PRUNE_COOLDOWN_AFTER_RATE_HALT_MS = 2 h`
is shorter than the soft wall it sits out (p50 = 3 h); (b) `activityLevel: aggressive` operates at
100% of the low end of the observed daily wall — show the effective margin on the Rate & Safety
card; (c) `nightowl + aggressive + cautious` is infeasible (`hourlyCap × session-mass ≈ 85 < 100`) and
silently under-delivers — `deriveOperatingPlan()` returns `Coherent | Conflict{binding}` and the UI
says which fundamental binds.

**Laws (fast-check):** monotonic in every ordinal knob; envelope (`operatingRate ≤ hardCeiling ≤
wall`) under ±20% perturbation of every empirical input; every ordering pair holds without clamping;
safety floors (`gapFloor ≥ 20 s`, `hold(1) ≥ 30 min`, `timeout ≥ p99`); provenance freshness
(`rev` ≤ 12 months); a **golden table** pinning the full derived set for all personas and knob
extremes — the migration seam. Values that refuse to derive go into an explicit `OVERRIDES` map with
a reason; there is no tolerance, only exact equality or a named override.

**Adaptivity (v1 is downward-only).** Measured percentiles feed derivations once `n ≥ 64`; toward
safety is free, toward speed needs `n ≥ 256`, ≥25% difference, ≤1.35× per step; hard clamp
`[seed × 0.5, seed × 2]`; the profile freezes while the recovery ladder is engaged; a definitive
rate-limit refusal lowers the effective margin by 0.6× for a soft-wall p50 and decays back over 7
days. `hysteretic()` is idempotent, monotone, and converges — three properties.

## 5. Runtime (one conductor, modes, durable time)

- **Rules are pure decisions over a `Facts` snapshot** gathered once per tick from declared fact
  sources with staleness budgets. `decide(facts, run) → halt | park | run(effect) | yield | null`.
  Precedence is a property test over generated facts, not an ordering assertion.
  `PROGRAM = { safety, growth, scan, run }`; prune is `safety ++ scan` or `safety ++ run`, and
  ~600 lines of `prune-engine.ts` delete. The per-candidate correctness rules (live-graph guard,
  whitelist re-derivation, remainder stays runnable) move into `pruneCandidate.decide()` unchanged.
- **Chronos**: every deadline, hold and cadence is a persisted, jittered, resumable row
  (`timers`: id, owner scope, kind, reason, armed_at, due_at, base_ms, noise_class, seed,
  overdue_policy, generation). §3 becomes `chronos.due(now)` fed into the first tick as
  `facts.overdue`. Discipline: persist a timer iff losing it would let the app act sooner than it
  should (`hold | cadence | deadline` persist; beats and scroll rests do not).
- **Effect policies as data**: budget class, timeout source, retry `Schedule | 'never'`,
  `onRefusal`, `requires`, `perIteration`, `idempotent` (false ⇒ retry must be `'never'` at the
  type level), span name. The runner debits the budget before dispatch, applies `onRefusal`, and
  makes a burst unrepresentable (a `Verdict` carries at most one effect).
- **Spans**: a persisted `spans` table (ulid, parent, scope, name, mode, outcome, reason, attrs) —
  the halt/park/refusal union IS the span reason vocabulary; "why is it parked" is a `parent_id`
  walk; spans feed the derivations' measured quantities. Retention: a 50k ring + daily rollup.
- **Cut**: the legacy pacing model (organic subsumes it: `LegacyPacer`, `cycle-plan.ts`, five
  settings knobs, two wait keys, one noise class), `ScheduleManager.every()`, `RecoverySupervisor`
  as a class, the `HARNESS` group, `EngineStatus`'s derived fields.

## 6. Surface (Instagram as data)

- **Playwright: no at runtime, yes in the lab.** `page.mouse` is the same CDP call the app makes;
  auto-wait would ride out a block interstitial and destroy the blocked-vs-stale distinction;
  `connectOverCDP` needs an unauthenticated local CDP port on a browser holding the logged-in
  session — disqualifying in a shipped build. `playwright-core` becomes a dev dependency for
  `surface-lab smoke` (trace + HAR) only; a 60-minute two-client spike is written down.
- **The surface is a validated document**: endpoints (match + zod response schema + `project()`
  emitting one fact per row), mutations, controls (descriptors over six locate strategies the page
  bundle interprets: leading-text, smallest-text, aria-label, role-then-deep-text,
  largest-scrollable, row-with-profile-link), signals, page sizes. Eight hand-written `extract*`
  guards and their eight result interfaces delete; `IgSurface` (45 members) survives only as the
  migration seam and then deletes.
- **Drift is a metric.** Every response parses through its schema (shadow first, then enforce per
  endpoint); a novelty pass reports unknown keys; a `surface_health` projection ticks live; the
  first mismatch per shape per day auto-captures an allow-list-scrubbed fixture (`pii` metadata on
  the schema drives the scrubber; unknown keys are kept as type names).
- **Contract tests in CI**: a scrubbed committed corpus (bodies + the 25 real DOM snapshots that
  already exist locally) drives `replay` (every fact and cursor) and page-script tests against real
  markup, including the load-bearing negative (a suggestion carousel never wins the header anchor).
- **One action pipeline**: `intent → arm → locate → press → observe → Verdict`, with `Verdict`
  carrying `effect: commit | reconcile | fail | untouched | mark-unverified`; the ledger writer
  takes only the narrowed `CommitVerdict`. `MutationWatch` generalises to `ResponseWatch<K>` so
  the drawer and requests panel arm their expected response instead of clicking and hoping.
- **Cut**: the `sendInputEvent` fallback (measured not to work in the background; today it fires
  one health event and then drops every click) — hard stop instead; `src/inspect`'s ES5 injection
  strings (fold into `surface-lab inspect`); the dialog-scroll scrape as a general fallback.
- **Derived**: poll/timeouts/scroll step/fetch abort from measured percentiles and viewport
  geometry with four guard rails (successful samples only; ≤2× per recompute; freeze under
  recovery; today's constants are the priors).

## 7. Shell, IPC, UI, toolchain

- **Composition**: `Module` graph + `Session` replace `Foundation` (2,193 lines → nine modules
  ≤250 lines: session, engine-control, prune-control, manual-ops, projections, lifecycle, plus the
  existing tab-lease and graph-builder). `app.ts` ≤110 lines. `bootstrap.ts`, `window/shell.ts`,
  `tab.ts` are out of scope for every wave: the kernel wraps them, never rewrites them.
- **IPC**: `PUSH` + `PushContract` join `CHANNELS` (push channels are still declared in three
  hand-written places today); `GUARDS` (zod) validate scalar-arg invokes at the boundary with the
  channel's typed fallback on failure; `PROJECTIONS` collapses the three ad-hoc pushes; the
  `status`/`engineStatus` alias and `onPruneStatus`/`offPruneStatus` sugar delete.
- **UI**: Preact 10.29 + `@preact/signals` in the shell context (ADR 0403's stated revisit
  condition is met); automatic JSX runtime (deletes a pragma from ~60 files and a declaration from
  four configs); `design/scale.ts` (base unit + ratios) generates `tokens.generated.css` with a
  `--check` gate mirroring `build:page:check`; palette stays hand-authored; Biome's CSS formatter on;
  a dev-only `?gallery=1` route instead of Storybook; `GraphStage` split once signals remove the
  ref-hoarding. React 19 and Solid rejected (3–4× runtime that fights live ticking; a 112-file
  rewrite for ~20% more than signals give).
- **Toolchain truth**: Electron 44.1.1 (Chromium 152, Node 24), `@types/node` pinned to Electron's
  Node major, `@types/better-sqlite3` gone with the driver, `electron-builder` pinned off the
  `v26` tag (its `latest` tag is behind), `.node-version` derived from Electron and read by CI,
  esbuild targets generated from Electron's `process.versions`, a `deps:verify` test (type majors
  == runtime majors; targets == installed Electron), `knip` for dead exports (it already found a
  duplicated `SweepCadence` declaration and a dead constant), TS 7 strictness added one flag at a
  time with measurement (`noUncheckedIndexedAccess` first). Keep esbuild, Jest 30 + SWC, Biome,
  Dependabot, and the entire release pipeline in `docs/RELEASE.md`.

## 8. Rejected, with the reason (do not re-litigate without new evidence)

| Candidate | Reason |
|---|---|
| `effect@3` | Fibers don't survive `app.quit()`; Epo's hardest invariants are durable across restarts, so the scheduler is hand-rolled either way; total-program rewrite (8–14 weeks); pulls `fast-check` at runtime. Three ideas stolen (typed errors, Schedule-as-data, Layer-shaped composition). |
| `xstate@5` | `after()` delays don't persist remaining time on rehydration — a §3 violation; the complexity here is effects-with-policy and numbers-with-provenance, not topology. |
| `kysely`/`drizzle` | The painful statements land in `sql` escape hatches; types are hand-written either way; drizzle-kit fights append-only migrations; perf is not a motive (24 ms per 20k prepares). |
| Vite 8 / Vitest 4 / tsup | Cost the `default-src 'none'` CSP guarantee for HMR a main-process restart dominates; Jest+SWC runs 1,262 tests in ~2 s. |
| pnpm workspaces | Three runtime deps, one app; boundaries are enforced by dependency-cruiser at zero runtime cost. |
| Playwright at runtime | Same CDP mouse call; auto-wait harmful; `--remote-debugging-port` in a shipped build is a local privilege-escalation hole. Lab-only. |
| `ts-pattern` | Flat `_tag` algebra needs no deep matching; `switch` + `absurd` is exhaustive at zero cost. |
| arktype / valibot / @effect/schema | arktype's type-level DSL is the riskiest addition to `tsc` on 39k lines; valibot's ergonomics for nested IG bodies; effect/schema is moot. One library: zod 4. |
| React 19 / Solid / Storybook / electron-trpc / Renovate / oxlint | See §7. |

## 9. Build order (waves; every wave ends with all gates green)

**Wave 0 (coordinator):** deps installed/bumped; automatic JSX runtime switched (mechanical);
checkpoint ref.

**Wave A — leaves and truth (parallel, disjoint ownership):**
- K kernel core: brands/units, Outcome, Res, absurd, Schedule, Scope, parse — with fast-check
  suites. No consumers yet.
- F fundamentals: `fundamentals.ts`, `policy.ts`, `derive.ts`, `overrides.ts`; golden test against
  today's 119 keys and the pattern-map tables; `timing/config.ts` and `pattern-map.ts` become shims
  over derived values (zero behaviour change); `deriveOperatingPlan()` coherence; the three defects
  reported, the cool-down fixed via override with a reason.
- S store: `SqliteDriver` + `node:sqlite`; `TableDef` manifest for all tables; `timers` + `spans`
  tables (migration 13) with `Chronos` and `SpanSink`; boot self-test; the events log designed but
  landed in wave B.
- T toolchain truth: deps:verify, line-budget, boundaries (dependency-cruiser), `.node-version`,
  generated esbuild targets, knip, CI matrix derived, TS flags measured one at a time.
- U renderer: signals in the shell context; generated tokens; Biome CSS formatter; gallery route;
  `GraphStage` split.
- A surface: schemas in shadow-parse mode with disagreement logging; `SurfaceMeter`; scrubbed
  fixture pipeline + contract tests + real-DOM page tests; `Verdict`/`Arbiter` inside the adapter
  (external contract unchanged); `sendInputEvent` hard stop; surface health counters.
- I shell/IPC: `Module`/`Session` kernel; `PUSH`/`GUARDS`/`PROJECTIONS`; `UpdaterModule` +
  `SessionModule` onto the kernel; `Foundation` starts shrinking.
- G runtime: `Facts` + pure `decide()` rules + precedence property test; `pruneCandidate` rule
  extracted; legacy pacer deletion planned (touches settings + renderer — wave B).

**Wave B — consumers (sequenced):** Outcome algebra across adapter → rim → engine; Chronos +
Scope + TabCap in the conductor; prune as a mode; events log + folds + rebuild + migration;
`Foundation` dismantled onto modules; legacy pacer deleted; surface enforce mode per endpoint;
`surface-lab` consolidation.

**Wave C — polish:** spans in the UI (cause chains), adaptivity on, `IgSurface` deleted, Effect-
style `EngineDeps` required everywhere, line budget allow-list emptied.

Gates: `npx jest`, `npm run typecheck`, `npm run lint`, `npm run build:dev`, `npm run boundaries`,
`npm run build:page:check`, `npm run gen:tokens -- --check`. Every DOM-level surface change still
needs `npm run livetest`; wave B's conductor needs an overnight background run before merge.

## 10. Open questions for the owner (answers change wave B, not wave A)

1. Where do the empirical numbers come from — is there run data to fit `IG_FOLLOW_CEILING` and
   the soft-wall percentiles to, or do we ship best estimates with a `rev` date? (Wave A ships the
   latter with the golden test pinning today's behaviour.)
2. `MAX_HOLDS = 3` covers the p50 wall; the derivation says 7 rungs cover p90. Is silently waiting
   out a 24-hour wall better than halting and telling you?
3. Should the app learn its own wall (creep up until the first definitive refusal, then back off)?
   v1 is downward-only.
4. Is `pattern-map`'s eight-knob persona the intended user surface? If so the numeric settings
   knobs become derived and read-only, and most of `AT_LEAST`/`AT_MOST` deletes.
5. LICENSE: the file is AGPL text, `package.json` says MIT. The public-repo plan is blocked on it.
6. Delete the legacy pacing model (five settings knobs)? The organic model subsumes it.
