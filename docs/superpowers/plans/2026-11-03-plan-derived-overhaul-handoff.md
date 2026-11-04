# Plan-derived overhaul — full handoff to the next agent swarm

> **Current continuation, 2026-11-04:** the retirement merge, fix wave, UI cleanup and owner preview
> review are complete. L1 qualifies on retained evidence; production catch-up and S8 comparator
> retirement are recorded. Current source `ad6726b` also fixes main-document startup readiness and
> truthful load-failure copy, and adds action timing diagnostics. Its full gate passes **443 suites /
> 4,558 tests**, boundaries **0 errors / 55 warnings**. One normal planned public follow is verified;
> broader cadence and unfollow coverage remain limited. The matching arm64 Epo 3.1.1 package is
> installed at `/Applications/Epo.app`, with the previous app preserved. Exact hashes, restored owner
> settings and delivery/live limits belong to the
> [current QA record](../../qa/plan-derived-overhaul-2026-11.md#startup-readiness-repair-and-local-package-2026-11-04)
> and newest [HANDOFF](../../HANDOFF.md) entry. The owner authorized cautious account actions;
> testing remains lead-only and sequential. Read those updates before using the historical sequence
> below. Do not repeat completed merges or manufacture work by changing protections, holds or the clock.

Written 2026-11-03 by the lead of the first swarm, at the point the owner asked the work to be handed over (after
stream agent #10 of wave 2, PR-S2r, finished). This document is self-contained: a new lead with no memory of the
earlier sessions can resume from it and run the overhaul to completion. Read it whole before acting.

- Repo: `/Users/owengregson/Documents/Peanut` (Epo, formerly Peanut — an Electron Instagram growth engine).
- Working branch: `overhaul/integration`. Base of the overhaul: `feat/plan-derived-overhaul`. Release branch: `main`.
- Durable handoff folder (outside the repo, private to this machine):
  `/Users/owengregson/.claude/projects/-Users-owengregson-Documents-Peanut/overhaul-handoff-2026-11-03/`
  — written `<handoff>` below — (`HANDOFF-plan-derived-overhaul.md` = this file; `tools/gate.sh`; `results/` = every stream's full report;
  `design/` = background design notes; `backup-userdata-2026-11-02/` = the owner's pre-overhaul app data backup;
  `workflows/` = the orchestration scripts used so far; `patches/` = prepared patches, e.g. step 19).
- A copy of this file is committed at `docs/superpowers/plans/2026-11-03-plan-derived-overhaul-handoff.md`.

---

## 0. TL;DR — where we are and what to do next

**Done (merged into `overhaul/integration`, every merge gated green):** Phase F (foundations), G0 (owner answers),
Phase P wave 1 (CF, TK, PC, SC, PP-a, PH, UD-a, RO-a, BL, LD, SH, UD-b) and wave 2 up to #21 (PR-S1, PP-b, SU, SB,
PR-S2, RO-b, PR-S2b). Integration head before the handoff: **`205e8e3`** — 4188 tests green, boundaries **0 errors /
59 warnings**, static-timing allow-list 369 entries (PENDING left: PR 11, SH 1, lead 4), line-budget list 21 entries,
`pending-wiring.json` empty.

**Finished but not merged at handoff:** PR-S2r (#22, the retirements) — branch `overhaul/PR-S2r`, tip `6fc56e7`,
gate green (4203 tests, 0 / 59), all PR PENDING static-timing entries retired; step 19 (Cautious floor 60 → 70 s) is
blocked on a fix in a frozen v1 file, with a prepared patch (§3.3). The swarm was stopped on purpose right after it
finished, before its merge.

**Next, in order** (details in §4):
1. Merge PR-S2r into integration (standard merge protocol §5.4); then land step 19 as a small follow-up (§3.3).
2. Wave 3 — fix streams for the open items (§4.2: P = plan accuracy — the session close/proration rule and Boost
   re-plan budgets first; R = reads/wiring; U = UI follow-ups; F = PR-S2r's follow-ups), then the closing stream CL
   (removal sweep + composition checks + "nothing hardcoded").
3. Phase I — docs/ADRs, full gates, background probe, visual checks in the isolated profile, a deep code review with a
   fix loop, checkpoint ref, fast-forward `feat/plan-derived-overhaul`.
4. Phase L — live tests on the owner's real account, lead only, strictly one at a time, owner consent for any
   follow/unfollow (§6).

---

## 1. What the owner asked for (keep this intent in front of every agent)

The owner (Epo's sole user and developer) asked on 2026-11-02, in one large request (effort max, "Ultracode" on):

1. **No static values — everything derives from the day plan.** Verbatim: *"Remember the most important thing is
   that everything needs to be derived from plans instead of having any hard-coded timings. This applies to
   everything like mouse movements, delays, pauses, waits between actions, waits between individual mouse movements
   of actions, etc."* And earlier, on limits: *"it shouldnt be hardcoded everything should be via our dynamic limit
   system."* Enforced by `tests/tooling/no-static-timing.test.ts` + the prune-only allow-list.
2. **Sidebar = live view only; settings move to a Settings screen in the top tab bar.** Verbatim: *"Also improve the
   organization of the left-hand sidebar. It's too generic and difficult to use, with not enough types of options, but
   with options that are structured in a way that's actually easy to understand instead of many different sliders and
   buttons. [...] I also want to rework the sidebar such that it's no longer a management section. The sidebar is just
   the live view/statistics/current actions and all of the settings are moved into a separate settings screen in the
   main tab at the top, where Graph, Prune, and Live are. [...] There should be an advanced mode and an easy mode for
   the settings such that you can configure every single thing individually or use the easy mode. In the easy mode
   there's still a decent amount of configuration but you don't get to the nitty-gritty of all the different
   timings."*
3. **UI refresh + launch animation.** Verbatim: *"The app could use a general refresh as far as the UI goes. Right now
   it's a bit too compact and techy. Make it easier for the average person to understand by increasing spacing,
   sizing of elements, etc. Also add more animations to the main page so that it's more clear what things are going
   on. Add a launch animation to the app when it's launched so that everything loads in the background and a loading
   animation plays during that. Then the intro animation plays, which goes into the app where everything should
   already be preloaded so it's as seamless as possible."*
4. **Parse resilience** to small changes in Instagram's API responses (a correct parse or a typed failure, never a
   wrong fact).
5. **The unfollow confirm pop-up** must be handled (it used to hang).
6. **Protection list on every unfollow path** (owner reversed the old prune-only rule): *"the prune blacklist words in
   bio, etc.: all of those settings are not just a blacklist for prune. They're actually a blacklist for the unfollow
   action in general... they should apply when [Epo] would normally be unfollowing someone from standard exploration
   and cycles."*
7. **Explore Boost**: a button that boosts for 12 h by default (configurable), focused on exploration and new follows;
   can be ended any time; survives network issues and an app close.
8. **Reopen reconciliation**: on reopen, proper scrolling and API reads; adjust only what changed.
9. **Nothing stale on reopen** (e.g. a false "target not available").
10. **Process**: parallel agents in git worktrees, commit as you go, never step on each other, great attention to
    detail. Afterwards the owner said: *"No need. scrap this. just let it all work i dont need to look now."* — build
    autonomously; the owner delegated every G0 question and the UI direction-board sign-off to the lead.
11. **Live account**: verbatim *"remember the account that we're doing is a live account and it's valuable. That means
    you can only have strictly one test running at a time and it must be a small number of [requests]… [endpoints
    that have] been verified very recently (for example, yesterday) do not need to be retested."*

**Owner decisions recorded (spec §18.3 — they win over any other sentence):** Q5 — Boost may lift a plan-day's
automatic volume up to `automaticDayMax(P0)`, never above. Q28 — the user-facing word stays **Prune** (internal ids
keep `cleanup`); the workplan's "Clean up" page/tab names are overridden. Everything else at G0 was decided by the
lead under the owner's delegation (recorded in spec §18.2/§18.3).

The owner also asked mid-way for a mockup (cancelled), then to see the boards (shown locally from the built gallery,
`index.html?gallery=1`, "Board · …" chips), then for this handoff.

---

## 2. Documents, branches and tooling

### 2.1 Normative documents (in the repo)
- **Spec** `docs/superpowers/specs/2026-11-02-plan-derived-overhaul-design.md` (~6,300 lines; never read whole — use
  `grep -n '^#'`). §18.3 = recorded answers (win over everything). §19 = ADR list. §20 = laws and tests. §22 = live
  test plan and the do-not-run list.
- **Workplan** `docs/superpowers/plans/2026-11-02-plan-derived-overhaul-workplan.md` (phases F → G0 → P → I → L; §0
  ground rules; stream sections; §I.1 merge order; §I.2 generated files; §I.3 hotspots; §I.3b removal sweep; §I.4
  closing tasks; Phase L checklist; Appendix A seams; Appendix B file ownership).
- `CLAUDE.md` (architecture, verification gates), `docs/PRINCIPLES.md` (facts stream, live UI, durable schedules),
  `docs/adr/*` (ADR series), `docs/HANDOFF.md` (house-format log; only Phase I writes the overhaul's entry).

### 2.2 Branches and refs
- `overhaul/integration` — the only branch merges land on. Head before handoff `205e8e3` (see §3 for the merge log).
- `feat/plan-derived-overhaul` — the overhaul's base; the Phase I review diffs `feat/plan-derived-overhaul...overhaul/integration`;
  I.4.7 fast-forwards it to integration at the end.
- Stream branches `overhaul/<code>` (all merged ones can be deleted after Phase I; keep until then). At handoff every
  stream branch is fully merged **except `overhaul/PR-S2r`** (6 commits ahead). No worktrees are left: the lead removed
  every clean, detached worktree after the stop (`git worktree list` shows only the main checkout).
- Side branches **not for merge**: `overhaul/PP-b-wip` (`8222e08`) and `overhaul/SB-wip` (`bafc5c7`) — ungated work
  saved from agents killed by a network outage; their streams later merged; delete them in Phase I.
- Backup refs (`git for-each-ref refs/backups`): `refs/backups/pre-plan-overhaul-2026-11-02` (`56422a6`) is the
  pre-overhaul checkpoint. I.4.7 adds `refs/backups/pre-live-plan-overhaul-2026-11`.

### 2.3 The gate
`npm run check` = gen:targets:check, gen:tokens:check, typecheck (src + tests), biome ci, boundaries
(dependency-cruiser; 0 errors, warnings never grow — ceiling now **59**), build:page:check, jest, build:dev.
The throttled wrapper used by every agent: `bash <handoff>/tools/gate.sh [--workers N]` (prints one line per step and
a summary; full log in `${EPO_GATE_LOGS:-$TMPDIR/epo-gates}/<checkout-name>.log`). Takes ~1–3 min (more under load).
Extra gates: `node scripts/plan-qc.mjs` (1260 plan-days, 0 breaches), `npx jest tests/integration/lifecycle-reachable`,
`node scripts/gen-kernel-catalog.mjs --check`, `npm run knip` (advisory).

Ratchets and generated files (never hand-merge; regenerate):
- `tests/tooling/line-budget.allow.json` — 300 lines per `.ts/.tsx`; `node scripts/gen-line-budget.mjs --against overhaul/integration` (refuses upward entries).
- `tests/tooling/static-timing.allow.json` — prune-only; `node scripts/gen-static-timing-allow.mjs --against overhaul/integration`; `--move <old> <new>` when a literal moves. Classes GEOM / HARNESS / PENDING; I.4.2 requires zero PENDING.
- `tests/tooling/pending-wiring.json` — every new `src` module needs a `src` importer or an entry `{module, stream, reason}`; empty now and must stay empty.
- `src/kernel/catalog.generated.ts` — `node scripts/gen-kernel-catalog.mjs` after changing any catalogued kernel table or guard comment.
- `src/adapter/page/bundle.generated.ts` (`npm run build:page`), `src/renderer/styles/tokens.generated.css` (`npm run gen:tokens`).

### 2.4 Orchestration used so far (reusable)
- Workflow scripts (copies in `<handoff>/workflows/`): `epo-overhaul-phase-p-wave1-*.js` and
  `epo-overhaul-phase-p-wave2-*.js`. The wave-2 script is the one to adapt: schemas (stream/merge), the stream prompt
  (lead decisions + hard rules), `setupFresh`/`setupContinue`, `priorSession`, `retryNote` (recovery after a dead
  agent), `prioritySlots(6)`, a serialized merge lock, `mergeWithRepair` (merge → on failure one repair agent in a
  worktree → retry merge), retries with 3/10-minute waits for network outages.
- Run journals (full per-agent results, durable): `~/.claude/projects/-Users-owengregson-Documents-Peanut/226625ae-1b84-462d-ada4-a75d72f62f4d/subagents/workflows/<run>/journal.jsonl`
  for runs `wf_2718d3fc-70d` (wave 1), `wf_7503d29c-0f3` (wave 2, killed by a DNS outage — no results),
  `wf_2458671c-9d3` (wave 2 restart). Digests: `<handoff>/results/wave1-result.json`, `wave1-blockers.md`,
  `wave2-journal-results.json`, `wave2-open-items.md`, `phase-f-notes.txt`.
- Process rules that worked: one stream per worktree under `.claude/worktrees/` (`git checkout -B overhaul/<code>
  overhaul/integration`, symlink `node_modules` to the main checkout's, finish with `git checkout --detach`); merges
  only by a merger agent in the MAIN checkout, one at a time, `--no-ff`, full gate after each; nobody else touches the
  main checkout while a swarm runs; never `git stash` (shared across worktrees); stage explicit paths; commit trailer
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; every commit gated green; test first.

---

## 3. Where we are

### 3.1 Merge log on `overhaul/integration` (first-parent, newest first)
| SHA | Merge | Tests / warn |
|---|---|---|
| `205e8e3` | #21 PR-S2b — the activity clock | 4188 / 59 |
| `749b440` | #20 RO-b — the sweep, the following check, the launch catch-up | 4178 / 59 |
| `10f331e` | #19 PR-S2 — the cadence switch (plan drives every timing; Boost wired; tempo on) | 4117 / 60 |
| `c5ef8b5` | #25 SB — sidebar: posture, zones, Boost control, splash and intro, Diagnostics | 4092 / 60 |
| `edd29e2` | #24 SU — Settings stage (Easy + Advanced) and the Prune page | 3989 / 70 |
| `3ab28de` | #23 PP-b — one parser and recovery | 3910 / 84 |
| `3aa0e8e` | #18 PR-S1 — one writer (plan service), plan-backed day clock everywhere | 3731 / 85 |
| `312cffb` | #17 UD-b — journal, verify-at-act, F6 | 3721 / 85 |
| `e433c5c` | #13 RO-a — growth log and frontiers store | |
| `25df583` | #16 SH — stage hosting, People page, overlays, tour | |
| `e37ecb9` | fix — PH's click-review rig and UD-a's protection index | |
| `a3ae373` | #12 UD-a — protection on every unfollow path | |
| `d58db8e` | #9 SC — settings core: v2 model, service, migration, seed check, facts | |
| `3532bd2` | #11 PH — parse corpus and health | |
| `3300bb5` | #7 TK — tokens: type ladder, palette, Inter, motion, the restyle | |
| `5af9356` | fix — the L-BOOT Foundation test waits out the landing settle | |
| `df70e3d` | #10 PP-a — parse hazards and transport | |
| `d017e74` | #15 LD — live data: activity relay, feed, projections, log ring, updater truth | |
| `a275355` | #8 PC — plan core (kernel plan, PlanService, Boost backend) | |
| `e23b921` | #6 CF — confirm layers, one admission per action | |
| `6142f7b` | #14 BL — boot: hidden window, store-first identity, startup sequence, stage controller, menu | |
| `a920b17` | fix — the electron boundary exception holds in linked worktrees | |
| `4deb1e3` | Phase F complete (F1a → F1b → F2a → F2b → F2c) | 2585 / 97 |

Merges ran in dependency order, not strictly the §I.1 numbering (SU/SB/PP-b had no blocking dependency and merged as
soon as they were ready); every merge was gated green on the merged tree.

### 3.2 State of the integration head (`205e8e3`) in numbers
- Tests 4188 passed (+ a few skipped and `test.todo`s, see §4.2 item P1). Boundaries 0 errors / 59 warnings.
- Static timing: 369 entries = GEOM 227, HARNESS 126, PENDING 16 (PR 11 → PR-S2r's scope; SH 1; lead 4).
- `@transitional` markers left in `src`: 6. `pending-wiring.json`: empty. Line-budget list: 21 files.
- Capabilities: `plan`, `tempo`, `boost` are set true by `plan-wiring.ts`; protection-everywhere by `wireChurn`.
- ADR drafts present: 0105, 0213, 0214, 0308, 0405, 0607, 0608, 0704, 0806, 0904, 1010, 1011 (all "proposed"/draft;
  Phase I finalizes numbers, cross-links and the amendments).
- Lead verifications so far: at `312cffb` the background probe passed all 10 scenarios (incl. `never-shown-boot`,
  `stage-hidden`; dashboard pacing 121 fps ≤ 150) and the lead reviewed the folded direction boards in a browser
  (approved; one fix requested — the Graph tab glyph looked like a send arrow; SB was asked to replace it). **Not yet
  run on the wave-2 UI:** the background probe after S2b and every in-app visual check (§4.4).

### 3.3 PR-S2r (#22) at handoff — stream agent #10
Finished 2026-11-03 17:52; the swarm was stopped immediately after (the started merge agent was killed before it
touched anything — the main checkout was verified clean, no `MERGE_HEAD`, still at `205e8e3`).
- **Branch `overhaul/PR-S2r`, tip `6fc56e7`**, base `205e8e3`, 6 commits, each passing the full gate; tip: 4203 tests,
  boundaries 0 errors / 59 warnings (adapter-must-not-reach-store 2, engine-must-not-reach-adapter 8, no-circular 6,
  no-orphans 3, renderer-allow-list 32, store-allow-list 8), line budget 21, `plan-qc` 0 breaches,
  lifecycle-reachable 3/3. **Not merged yet** (§4.1).
- Commits: `a4af54e` the RETIRED and CHANGED ledgers, the 18 retired registry keys leave the code · `da89b54` the
  derivations' unnamed literals get names and guard lines · `0aba15b` the cold breaker applies its derivation
  (`coldFailingThreshold()` = 7, a behaviour change from 8; the advisory-override mechanism is deleted); a cleanup run's
  fail halt is the named override `PRUNE.CONSECUTIVE_FAIL_HALT` = 4 · `2527c59` the refill reads the plan (enrich slice =
  min(profilesPerSlice, the open session's explore reads); a session with no explore reads defers enrichment to the next
  session; skip-pool uses the plan's follows; read deferral to the plan-day's end; bootstrap waits are idle beats; engine
  freshness windows count plan-days via `EnginePlan.dayWindow`); `EXPLORATION_POLICY` moves into its consumers ·
  `b0facf1` carry-ins (one retry derivation `retryLimit()`, the `samplePhaseOffset` shim deleted, the README's simulated
  growth projection retired — owner Q30 — SessionPlanner comments reworded) · `6fc56e7` ADR 0607 accepted with its
  ledgers; amendments 0202, 0204, 0211, 0212, 0605, 0606, 0901 appended.
- **All 11 PR PENDING static-timing entries are retired.** After this merge only SH 1 and lead 4 PENDING remain (CL's).
- Deviations to know: the frozen v1 cadence bounds became kernel `BOUNDS.SETTINGS_V1.SWEEP_FACTOR_MIN/MAX` (0.5/2.0,
  guard lines) instead of literal copies, because literal copies would need new allow-list slots (the ratchet forbids
  adding) — the lead accepts this; the D4 poll bounds and four derivation factors are module-private named constants with
  guard lines in `derive.ts` (a new exported table would need a catalog row and `policy.ts` is at its ceiling);
  `src/kernel/registry-changes.ts` has only test importers by design (a ledger; `src/kernel` is exempt from no-orphans).
- **Blocked — step 19, the Cautious floor 60 → 70 s (owner Q11).** The frozen v1 pipeline re-derives a named
  persona's pacing knobs through the LIVE `resolvePattern` (`src/settings/v1/settings-v1.ts:74,79`), and the migration
  sanitizes every v1 file through it (`src/settings/migrate-v1.ts:99`) before comparing with the frozen `V1_DERIVED`
  (`:103`, `:129`). Removing the override would make every Cautious-persona v1 file migrate with a spurious
  `sessions.gapMinimum` override (`migrate-v1`, `migrate-effective`, `plan-math` tests fail). Fix order: (1) in SC's
  frozen `src/settings/v1/settings-v1.ts`, resolve personas through `v1Derived` (`src/settings/v1/derive-v1.ts:45`)
  instead of `resolvePattern` — behaviour-neutral today because `V1_DERIVED` is pinned to the snapshot; (2) apply the
  prepared patch `<handoff>/patches/step19-cautious-floor.patch` (removes `OVERRIDES['CAUTION.cautious.floorSeconds']`,
  adds the CHANGED rows `grid.caution=cautious.gapFloorSeconds` and `personas.casual.gapFloorSeconds` 60 → 70 with adr
  0606, updates comment counts); (3) `tests/kernel/catalog.test.ts:154` pins the cautious floor's tier as 'override'
  (point it at `CAUTION.bold.floorSeconds`); (4) regenerate `src/renderer/gallery/settings-fixture.json` with
  `EPO_WRITE_SETTINGS_FIXTURE=1 npx jest tests/renderer/settings-fixture`. ADR 0607 and the 0606 amendment already record
  the floor as decided and pending.
- Its follow-ups are folded into §4.2 (F-items).

### 3.4 Owner data and the live account (status)
- The owner's real app data lives in `~/Library/Application Support/Epo` (store `epo.db`, `epo-settings.json`,
  `epo-runtime.json`, logs). **No overhaul build has ever opened it.** A backup taken 2026-11-02 is in
  `<handoff>/backup-userdata-2026-11-02/` (epo.db + wal/shm, epo-settings.json, epo-runtime.json, window-state.json).
- The live store holds one uncertain unfollow from 2026-11-02 18:30; under UD-b's settlement table it settles on the
  journal step at the first real launch (still following → cancelled, record `unfollow_queued`; not following →
  external, record `unfollowed`). L5 covers the already-due unfollows (owner consent required).
- The first real launch migrates the store past what the installed release can open and writes `epo-settings-v2.json`
  (v1 file untouched): back up again right before L4 (Phase L step 1).

---

## 4. What remains — the plan to completion

### 4.1 Step A — merge PR-S2r (#22), then step 19
Use the merge protocol in §5.4 with the stream's report (§3.3; the full report is `<handoff>/results/pr-s2r-result.json`
and the wave-2 journal, label `PR-S2r`). The branch was cut from the current integration head, so the merge should be
clean. Per-merge checks: gate green; boundaries ≤ 59; `npx jest tests/integration/lifecycle-reachable` passes; the
static-timing diff only removes or re-keys entries; `node scripts/plan-qc.mjs` exits 0. After this merge the only
PENDING static-timing entries left are SH 1 and lead 4 (both CL's).
Then land **step 19** (the Cautious floor) as its own small stream or lead commit series, in the order given in §3.3,
gated, with the CHANGED ledger row and the ADR 0606 amendment already in place.

### 4.2 Step B — wave 3: open correctness items (fix streams), then CL
These came out of wave 2's reports. Group them into a few streams that can run in parallel (they touch different
files), each test-first, then CL last. Owners in brackets are the original stream owners (Appendix B); the next lead
authorizes the touches.

**P — plan accuracy (highest priority; kernel + plan service) [PC/PR]**
- **P1. Session close / proration rule** (`src/kernel/plan/status.ts`: `sessionStatus`, `fitFrom`, `closesAtOf`).
  A session joined at its own start is still cut to `floor((expectedEnd − now)/targetMean)`, and a joined session
  closes before its budget is spent at the drawn gaps, so some whole days realize less than planned (I1 drive: 4 of 21
  days short; I11 at the pinned seeds: balanced 43/47 and 43/45, grower 65/70 and 64/68, nineToFive 46/47 and 43/45).
  `tests/integration/plan-week.test.ts:84` holds the `test.todo` "every whole plan-day realizes exactly V.planned".
  Fix the rule (a session joined at its start keeps its whole budget; a joined session's close lets its budget be spent
  at the drawn gaps, bounded by the next session's start minus the boundary and by quiet hours/day end), keep laws
  L1–L5/L13 green, and turn the todo into a passing test for every persona.
- **P2. Boost re-plan budgets** (`src/kernel/plan/boost.ts` `applyBoost`/`insertNow`; `plan-view.ts` day-done reads
  `max(drawn, planned)`). A skipped act-now session keeps its budget and the lift is placed again on every re-plan:
  at the defaults a 12 h Boost read `volume.planned` 48 → 50 → 54 after two settings changes while `automaticDayMax`
  is 48 (what could actually run stayed ≤ 48). Violates the spirit of L1/L13b ("Σ budgets = V.planned ≤
  automaticDayMax"). Add a law over the sum of budgets across every `ReplanCause`, fix the re-placement, and decide what
  `planned` shows (never above `automaticDayMax(P0)`).
- **P3. Prune-now admission share** (`plan-view.ts` `admits`): a manual Prune run is admitted against the day's
  unfollow budget and the open session's *whole* budget, so it can consume a session's follow share (I3 spent all 10
  of a session's budget on unfollows within kinds.unfollow = 15). Decide against the spec (§5/§8/§9.7) — the lead's
  recommendation: admit against the session's unfollow share and the day's unfollow budget only — and pin it with a test.
- **P4. Exact outside count** (spec §9.10, step 10 of RO-b): the following check (step G) persists
  `reopen_state.following {checkedAt, count, complete}` and the AwaySummary's outside numbers, but `GrowthRepo.outsideSince`
  (the plan's outside charge) still uses the header estimate. Needs a rule for which plan-day undated outside follows
  are charged to; store the added count; then wire it (ADR 0704 records the gap).
- **P5. Head-page allowance** (spec §9.6): `catchUp.pages` and per-session `checkPages` (`src/kernel/plan/reads.ts`
  ~:131,139) still use `FRONTIER_PAGES_MAX`; `headPageAllowance` needs a gains hint in `PlanDemand`
  (`src/kernel/plan/types.ts`). Without a hint the allowance would be 2 pages, not 5 — decide the hint.
- **P6. Census rows-per-page fallback**: the demand reads `reopen_state.head.rowsPerPage`, which only RO-b's head
  walk writes; the spec's fallback ("the census measurement") has no recorder (`PruneCensusRecord` has no page size).

**R — reads and wiring [RO/PP/UD/PR]**
- R1. The prune scan and own-followers source pass `walkOwnList`'s census bound `{ pages: censusPagesMax(...),
  walkMax: censusWalkMax(...) }` so a census that cannot finish is refused as `too-large` (spec §5.8, §9.12).
- R2. `refreshOwnStats` takes a `ReadUse` so the sweep's header visit is debited as `catch-up`/`check`, not
  reconciliation (PP's `own-stats.ts`).
- R3. Drawer bodies read through `reader.observed.read(resp)` (shared memo) and `DrawerBody` carries status/mime
  (RO's feed source; PP's reader).
- R4. Call `profiles.visit(username, {pk})` wherever the pk is known (click-review, journal-settlement,
  profile-enricher) so a recovered (C2) profile is anchored by pk too.
- R5. Delete the vestigial `pacingSleep` (`EngineJournalContext.pacingSleep` + its awaits in
  `engine-journal-effects.ts`, `runFollowbackSweep` in `engine-sweep-effects.ts`, and the
  `pacingSleep: () => Promise.resolve()` line in `engine.ts` `effectContext()`).
- R6. `prune-control.ts pruneCandidates()` returns `[]` on a caught error: return a typed unavailable answer so the
  Prune page can tell a failed read from an empty list (no silent catch — CLAUDE.md).
- R7. Not on the activity clock yet (outside S2b's three entry points): the dialog-scroll fallback
  (`FollowersPageReader`) and the boot landing / confirm-account navigation (BL) — note their ends on the graph's
  clock so the launch catch-up's first read is spaced from the landing.
- R8. `src/livetest/steps.ts` harness config `enrichPaceMinMs/MaxMs` (`EPO_TEST_ENRICH_PACE_*`) reach nothing now:
  retire them with their HARNESS keys or point them at the harness visitor's dwell.

**U — UI follow-ups [SB/SH/SC/TK]**
- U1. New-look tour: `SettingsView.app` exposes only `tourCompletedAt`; expose `tourVersionSeen` (the
  `tour-version-seen` op exists) and wire SB's `<Tour steps={NEW_LOOK_STEPS}>` + the toast "Epo has a new look.
  [Take the tour]".
- U2. Feed `@handles` open the People page but cannot select the person: add a People-page selection API (SH) and use it.
- U3. Reduced motion: spec §12.8 asks for a cut instead of the curtain, but main's `StageController` always curtains
  and does not know the renderer's preference — pass it to main (one IPC field) and cut.
- U4. Motion law (≤ 2 infinite loops): `people.css` `skeletonFade … infinite` is another loop while skeletons show;
  the stage bar shows base.css's `?` tip badge on its `data-tip` (the column suppresses it with
  `.sidebar [data-tip]::after { content: none }`; the stage bar needs the same).
- U5. Dead styles/atoms: `prune.css` rules for the removed whitelist and schedule cards; `ui/Stepper`, `ui/Toggle`,
  `ui/Field` have no importer; `useChainList()` has no caller; `tests/renderer/tokens.test.ts` RESTYLED still lists the
  deleted `overview.css`; `CheckedUpdateStatus` now equals `UpdateStatus` (LD) — delete the duplicate.
- U6. Spec copy residue: spec §6.4's "one word per concept" paragraph and several B.10/E.2 strings still say "clean
  up"; the shipped decks say Prune (`tests/renderer/settings-copy.test.ts` enforces it). Amend the spec text.

**F — from PR-S2r's report [PR/SC/BL/RO/UD/lead]**
- F1. Plan-day freshness windows for the remaining consumers: `src/rim/follower-acquisition.ts:163` (profileFreshMs),
  `:176` (endedRevisitMs), `src/rim/own-followers-target-source.ts:79` (enrichmentRetryMs) need the plan-backed day clock
  at construction (`planDay: plan.dayClock` in `graph-builder.ts`, line-neutral), then read `weeklyCycleSince()` from
  `src/engine/exploration-policy.ts`; SC's `src/engine/scanner.ts:69`, `source-frontier.ts:64,172` and
  `chain-controller.ts:203` still read the ms windows too. Once all move, `EXPLORATION_POLICY.lowYieldRevisitMs/
  endedRevisitMs/profileFreshMs/enrichmentRetryMs` retire.
- F2. Stale comments describing retired mechanisms: `src/timing/config.ts` group comments for ENGINE ("refill pacing …
  velocity park"), PRUNE ("pace factor … scan freshness") and SCHEDULER ("Scheduled-prune watcher") (Phase-F frozen;
  comment-only edits are fine); `graph-builder.ts:232` and `src/engine/ports.ts:245` ("restart-stable daily-boundary
  jitter"); `src/engine/prune-types.ts:100` (`{@link PRUNE_SCAN_FRESH_MS}`).
- F3. `README.md:24-25` still embeds `charts/growth.svg` and `.github/workflows/readme-live.yml:4-7` still describes
  the growth panel and the SessionPlanner; the nightly render now writes only `pace.svg`/`pace-dark.svg`, so the
  README's growth image stops resolving after the next run — remove the README growth panel and reword the workflow
  comment. `src/renderer/charts/growth-model.ts` and `growth-overlay.ts` have no non-renderer importer any more: delete
  them with GrowthChart's overlay prop and `overlayHorizonDays` (and trim `tests/renderer/growth-window.test.ts`).
- F4. `SETTINGS_POLICY.TYPICAL_DAY_Z` (`src/kernel/settings-policy.ts:17`) can read `POLICY.DRAW_DECILE_Z` (a law in
  `tests/kernel/derive-golden.test.ts` pins them equal today).

**CL — the closing stream (after P/R/U/F merge)** — brief in §7.3: the removal sweep (I.3b; incl. the v1 settings path
chain SU listed — `getSettings/updateSettings`, the `SETTINGS_PATCH` guard and its pin, `hooks/useSettings.ts` + the
App.tsx call, `settingsSignal/adoptSettings/Shell.settings`, `useTourGate` → v2 `app.tourCompletedAt` + the
`tour-completed` op with an honest failure, `ProgressPanel` windows from `settingsViewSignal.value.effective`,
`shell-services` `hasSeed` → `settingsViewSignal.peek()?.seed`, `Gallery` `adoptSettings`, `posture-signal`'s seedChosen
fallback; then the v1 adapter carry and stamp window, `EffectiveSettings.pruneScheduleDays/pruneDailyLimit/pruneScan*/
followbackSweepHours`, the v1 `sweepLastRunAt/sweepIntervalFactor` fields, `SeedCheck` in `src/shared/invoke-results.ts`,
the frozen v1 `Settings` export in `src/types.ts`, `EngineStatus.pacing/.reentry`, `@deprecated-renderer` markers,
`PruneConfig.whitelist`, `prune-whitelist.ts` + `prune-bio-filter.ts` with inlined test oracles, the old growth overlay
chain once `live-charts.ts` no longer imports it), the composition checks (I.4.1, incl. "graph.profiles, the list
walker and the drawer share `graph.plan.activity`" and every `PlanDayClock` consumer plan-backed), "nothing hardcoded"
(I.4.2: zero PENDING, no `@transitional`, no `Math.random` outside the renderer except the entropy root, every §17 DEL
row gone), the lead items (`CONVERSION_VERDICT_MIN` 20 and `RUNWAY_CAP_DAYS` 90 → kernel display dials;
`Foundation.growthSeries`'s `d = 14` default → refusal; guard-lines MODULES; deterministic flaky tests).

### 4.3 Step C — Phase I (lead; workplan §I.4)
1. **Composition and nothing-hardcoded** (I.4.1–I.4.2) — done by CL; the lead re-checks.
2. **Docs** (I.4.3): finalize every ADR of spec §19 (12 drafts exist; numbers, status, cross-links) and append the
   amendments (0103, 0202, 0204, 0210, 0211, 0212, 0303, 0306 note, 0307, 0402, 0605, 0801, 0802, 0803, 0901 executed,
   1005, 1007, 1008); `docs/PRINCIPLES.md` §1 (the drawer streams per event; dating waits for the frontier) and §3
   (launch catch-up; planned checks; `advanceTimers` at build) — RO-b drafted them in place; one `docs/HANDOFF.md`
   entry (newest first, house format: owner's words, symptoms, root causes numbered, `FIXES (ADR …)` bullets, what was
   verified, test and boundaries counts); a validation record `docs/qa/plan-derived-overhaul-2026-11.md` linked from it
   (incl. how to use the isolated profile); release-card notes (new `epo-settings-v2.json`; v1 untouched; downgrade
   restores the old 3–7 min floor; protection covers every path; Steady intervals retired; the tab stays **Prune** —
   the workplan's "now Clean up" line is overridden by Q28).
3. **Full gates** (I.4.4): `npm run check`; `npm run knip` reviewed; `node scripts/plan-qc.mjs`;
   `node scripts/background-probe.mjs --soak-ms 10000` (local-only Electron with a temporary profile and a loopback
   page — it never loads the IG partition; every scenario incl. `stage-hidden` and `never-shown-boot`; the dashboard
   pacing guard ≤ 150 callbacks/s **against the new animations**); the visual checks of spec §20.5 in the isolated
   profile (§4.4).
4. **Review** (I.4.5): a high-effort code review over `git diff feat/plan-derived-overhaul...overhaul/integration`
   (hundreds of files: fan out by subsystem — kernel/plan, engine, rim/adapter/surface, main wiring, store, renderer —
   then adversarially verify each finding). Correctness first: protection never bypassed; no destructive verdict from a
   C2/partial read; no read before preflight; no tab work before the reveal beyond the landing; no automatic day above
   `automaticDayMax`; no IG literal outside `versions/*`; every timing from the plan/kernel; no silent catch; facts
   stream (per-item writes) and live UI (no gating on operation end). Fix findings in follow-up commits; re-run I.4.4.
5. **Owner confirmation** (I.4.6) of the wired gallery against the approved boards — a confirmation only.
6. **Checkpoint** (I.4.7): `refs/backups/pre-live-plan-overhaul-2026-11` (temporary index → `write-tree` →
   `commit-tree` → `update-ref`), then fast-forward `feat/plan-derived-overhaul` to `overhaul/integration`.
7. **Owner memory** (an owner session): update `unified-transport-and-bio-keep-list` (already reflects the reversal)
   and `session-robustness` (superseded parts).

### 4.4 Visual checks to run in the isolated profile (collected from every stream)
Launch only like this (never the real profile before Phase L): quit Epo first; then
`EPO_USER_DATA_DIR=$(mktemp -d) EPO_BLOCK_NETWORK=1 npm run dev` (the IG partition is taken offline before any tab
exists; store, settings and logs live in the temp dir). Check at window widths 1024/1440/1920 and heights
640/800/920/1200, with and without reduced motion:
- Launch (BL/SB): hidden window until ready; the splash while everything loads; captions (~1.2 s, slow caption
  ~2.5 s); the intro (mark flight lands exactly on the masthead mark; numerals at their true values); no white frame;
  the curtain into Live; `bootRevealed` once; the offline placeholder after `IG_READY_DEADLINE_MS` (network is
  blocked, so it should appear); reduced motion → cross-fades (and a cut instead of the curtain once U3 lands).
- Live column (SB): every posture's headline (≤ 15 chars: "Get set up", "Can't open data", …) and primary; fixed zone
  heights (a posture change never moves anything); the ring's deadline modes; number tickers; the plan strip's
  now-marker; FLIP feed inserts and "↑ N new"; the Boost control (one tap with the saved length; preview; End; the
  disabled/paused/unavailable states); Why? popovers clamped to the column; the Today summary adds up; Diagnostics
  panel (filter, search, pause, copy, open folder) and the log stream only while it is open.
- Stage bar and pages (SH/SU/TK): tabs Live · People · Graph · Prune · Settings (tab width clamp, context line, Live
  dot; the Graph glyph no longer reads as a send arrow); People in two columns from 1100 px; Settings Easy (seven
  sections, cards with live numbers, no sliders/timings) and Advanced (Fine-tune, Today's plan in detail incl. the
  sentence layout below ~700 px content width, Limits & reading, Under the hood, Timing visible since
  `capabilities.tempo`); search; save status; the Prune page (protection tile, annotated candidates, "Show protected
  (N)", too-large state); the compatibility panel/line/notice (PH); window title and Dock badge follow the posture;
  menu accelerators; no page zoom; DevTools only unpackaged.
Record findings in the QA doc; fix in follow-up commits.

### 4.5 Step D — Phase L (live; lead only; strictly sequential; owner present) — workplan "Phase L", spec §22
Preconditions: Phase I complete; CF and UD-b merged (done); the build under test is the integration head; Epo quit; no
other tool running Electron; outputs to a scratch folder (never a worktree); back up `~/Library/Application Support/Epo/`
first. Then:
- **L0** offline gate (all green or stop).
- **L1** one `EPO_PROBE=verify EPO_PROBE_TARGET=<a public account the owner follows, mutual preferred; one with an
  empty bio if the owner can name one> EPO_PROBE_OUT="$OUT" npm run probe` — once. Parsing only: `biography` and
  `is_verified` present on both bodies; review `verify.json`, `traffic.json`, the run log; resolve `EMPTY_BIO` from a
  live empty bio if available. Stop on any stop criterion; never re-run the same day.
- Wait ≥ 1 night with Epo quit. **L4** supervised production relaunch: `npm run start` from a terminal; tail
  `~/Library/Application Support/Epo/logs/runtime.jsonl`; screen-record the launch; the owner presses Start after the
  catch-up completes. Pass items: the landing behind the splash; exactly one head page on this first launch; the
  catch-up after the reveal under the startup lease with its veil hold; the drawer's step pauses; a Boost left on
  shows paused while stopped; 0 `shadow-disagreed`.
- **L5** (owner consent recorded, naming the targets): let the engine take its already-due unfollows (the stranded
  Requested record, the next public, the next private). Check one admission per unfollow before the header press,
  the look-before-act dwell and a step pause before each confirm-layer press, Cancel/Close leaving no dialog, an
  `actor: confirm layer captured` line for the first private unfollow's dialog, the mutation `friendship_status`
  carrying both `following` and `outgoing_request`. Pause the engine at once on any stop item.
- **L5b** (optional): a short Boost (one tap, the saved length), ended early.
- After L1 + L4 show 0 `shadow-disagreed`: PP **S8** — delete the legacy extractors, `reader-shadow.ts`,
  `surface/shadow.ts`, `EndpointDef.mode` — through Phase I's gates.
- Record everything in the QA doc; update the HANDOFF entry with what was verified live.
A failed live step never triggers a retry loop: stop, collect evidence offline, fix the root cause, re-enter at L0.

---

## 5. How to run the swarm (process that worked, and the traps)

### 5.1 Roles
- **Lead** (you): decides, briefs, merges only through merger agents, verifies (gates, probe, visual checks), keeps
  this document current, talks to the owner. The lead never edits the main checkout while a swarm runs.
- **Stream agents**: one per stream, each in its own worktree, test first, commit per step, every commit gated,
  finish detached, return a structured report (code, branch, base_sha, head_sha, commits, gate_passed, tests,
  boundaries, line_budget_entries, pending_retired, minimal_touches, deviations, blockers, remaining_steps,
  followups, summary).
- **Merger agent**: in the MAIN checkout only, one at a time (§5.4).
- **Repair agent**: on a failed merge, in a worktree: merge integration into the stream branch, resolve with full
  context (owner's version + the other stream's minimal hunk; regenerate generated files), gate, retry the merge once.

### 5.2 Stream brief essentials (copy from the wave-2 script's `streamPrompt`)
Read the workplan's §0, the stream's section, Gate G0, §I.1–§I.3, Appendices A/B; the spec by headings (§3, §4, §14,
§15, §16, the §17 rows for its files, §18.3, cited sections, matching appendix); CLAUDE.md, PRINCIPLES, cited ADRs.
Lead decisions: Prune wording; Boost Q5; everything timing/limit-shaped from the plan and kernel (no new numeric
literal in `src` outside `src/kernel` and `src/renderer`); retire the stream's PENDING entries (never add one, never
change a class); boundaries never above the base; line budget; pending-wiring; regenerate the kernel catalog.
Hard rules: edit only inside your worktree; minimal touches outside ownership only as authorized and recorded
(`minimal-touch: <file> — <why>`); never touch survival layers (CDP input chain, bootstrap switches,
`backgroundThrottling:false`, focus emulation, `powerSaveBlocker`, re-stack concealment); never edit
`tests/kernel/legacy-config.snapshot.ts` or `docs/HANDOFF.md` (Phase I only); no Electron/Instagram/app launches by
agents; never read or write `~/Library/Application Support/Epo`; private captures never copied or quoted; neutral
vocabulary; comments ≤ 3 lines, present tense, no dates; root causes, not guards; stop cleanly with
`remaining_steps` when context fills.
UI streams may self-check the built gallery in headless Chrome over loopback (`npm run build:dev`; `python3 -m
http.server <port> --bind 127.0.0.1 --directory dist/renderer`; chrome-devtools MCP; `index.html?gallery=1`).

### 5.3 Dependencies that matter now
- PR-S2r's merge and step 19 come first (step 19 touches the kernel overrides and the frozen v1 settings file).
- P1/P2 change the kernel plan: run them before the Phase I review and before Phase L (they change what the engine
  does each day). P3 is a decision + small fix. P4–P6 and R1–R8 are mostly independent of each other; U1–U6 are
  renderer-side; F1–F4 are small and can ride with R (F1, F2) and U (F3) or run alone. CL goes last (it deletes what
  the other streams might still read).
- A suggested wave-3 shape: three parallel streams — `PLAN` (P1–P3 + step 19 if not done), `READS` (P4–P6, R1–R8, F1,
  F2, F4), `UI` (U1–U6, F3) — each merged as it is ready, then `CL`; then Phase I as its own workflow (docs, gates,
  review fan-out with adversarial verification, fix loop).
- `src/main/foundation-wiring.ts` is at its line ceiling (BL-owned hotspot): new wiring goes into new modules.

### 5.4 Merge protocol (the merger agent, MAIN checkout)
1. Check: on `overhaul/integration`; if `MERGE_HEAD` exists → `git merge --abort` (a dead merger); tracked changes →
   save `git diff HEAD` to a scratch patch, then `git reset --hard HEAD`; if the branch tip is already an ancestor of
   HEAD, a previous merger finished — go straight to the gate (pre-merge SHA = the merge's first parent).
2. `git merge --no-ff <branch> -m "merge(overhaul): <code> — <title>" -m "<trailer>"`.
3. Conflicts: generated files regenerated (§2.3); union tables (pending-wiring, gallery scenario lists,
   `tests/kit/render-bridge.ts`, `view-liveness`, icons `REQUIRED`, shared test files with appended describes);
   hotspots (§I.3): the owner's version + the other stream's minimal hunk; anything non-mechanical → abort and report.
4. Gate; boundaries ≤ the previous merge's count; lifecycle-reachable for PR/RO/CL merges; the diff is the stream's
   work only; the static-timing diff only removes/re-keys.
5. Red: a small mechanical fix may be committed as `fix(overhaul): …`; a semantic failure → `git reset --hard
   <pre-merge>` and report precisely (failing tests, files, both intents, diagnosis of the root cause).

### 5.5 Traps we hit (avoid them)
- **Network outages kill agents.** Wave 2's first run lost every agent to a DNS outage (`ENOTFOUND`); the immediate
  retries died too. The restart script waits 3 then 10 minutes between retries and tells a retry agent how to recover
  a dead agent's committed work (continue on `overhaul/<code>-r<n>`) and read its uncommitted work from the dead
  worktree (`git worktree list`). Commits survive; uncommitted work survives only in the dead worktree — save it on a
  `-wip` side branch (`git -C <wt> checkout -b overhaul/<code>-wip && git -C <wt> add -A && git -C <wt> commit`)
  before removing the worktree.
- **A dead agent's worktree keeps its branch checked out** → `git checkout <branch>` is refused elsewhere. Remove dead
  worktrees (`git worktree remove --force`) after saving their work, or branch off with a suffix.
- **`git checkout -B <branch> <start>` on retry would reset a branch holding a dead agent's commits** — always branch
  off with a new name when retrying.
- **Merged tests that pass alone fail under machine load** (the machine is shared; load average 20–45 at times):
  `tests/adapter/unfollow-flow.test.ts` "a menu that lingers…", `tests/store/feed-reads.test.ts` (15 ms perf bound),
  `tests/main/startup-steps.test.ts` (L-BOOT). Re-run alone before diagnosing; CL makes them deterministic.
- **The background probe writes `background-probe.json` at the repo root** (a tracked file): restore it
  (`git checkout -- background-probe.json`) or commit it deliberately as a record; a dirty main checkout stops mergers.
- **Two streams on the same seam** (settings ↔ plan preview) produced an infinite recursion only on the merged tree:
  the fix was structural (split SettingsService's memo: core effective/protection vs the view), never a re-entrancy
  guard. The owner rejects keep-running patches — fix the design.
- **zsh**: `echo =====` triggers `=` filename expansion; quote it.

---

## 6. Safety rules (non-negotiable)
- The owner's Instagram account is **live and valuable**. Only the lead runs live tests, strictly one at a time, small
  request counts; skip endpoints verified the previous day. Passive `EPO_PROBE=traffic` first; one composed read per
  endpoint spaced 8–12 s; stop at the first wall (429 / 5xx / HTML). Mutations (follow/unfollow/accept) need explicit
  owner consent naming the target, one pair at most; only undo a follow the probe itself pressed. Probe outputs go to
  a scratch folder, never the real graph. Never compose requests Instagram's web client does not make. Never run
  `EPO_PROBE=followers` / `EPO_PROBE=window` or scripted press-through of private/requested confirm dialogs.
- No agent ever sends Instagram traffic or launches Electron against the real profile. Before Phase L every launch
  uses `EPO_USER_DATA_DIR=<tmp> EPO_BLOCK_NETWORK=1`. Quit Epo before running any tool against its data.
- Real captures (`docs/adapter/fixtures/raw|dom`, `manifest.json`, `probe-verify-2026-11-02`) are the owner's private
  data: git-ignored; never commit, publish, copy into the repo or quote them; only scrubbed fixtures under
  `tests/fixtures/surface/`. Never repeat third-party usernames seen in old `peanut-*.json` files.
- The owner's local files are read-only; never commit them. The backup is in `<handoff>/backup-userdata-2026-11-02/`.
- Background-run survival layers are load-bearing (`docs/HANDOFF.md` 2026-08-14 entries): never remove one.
- Neutral naming everywhere (no bot/human-emulation framing: no "human", "bot", "emulate", "stealth", "mimic",
  "spoof", "detect", "natural" framing in names, comments or copy).
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; PR descriptions end with
  `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Commit or push only when asked/planned; never
  push without the owner's go-ahead; never tag by hand (the auto-releaser does releases).

---

## 7. Decision log and briefs

### 7.1 Lead decisions already taken (keep them)
- PlanPreviewPort stays F2a's `previewDays(intent: PlanIntent, at, days)`; the settings side wraps it
  (`fingerprint(e) = intentDigest(toPlanIntent(e))`).
- StorePolicy: bounds pass as repo method arguments; at most one construction-time slot per need.
- SettingsService: core memo (resolved params, effective settings, protection index) separate from the view memo (which
  draws the plan's week through the preview port); `effective()` never draws the week (`settings-derived.ts`).
- Copy: posture headlines ≤ 15 characters — first run "Get set up", data unavailable "Can't open data"; the C.15.4
  "nothing-to-shift" refusal and the B.10 disabled-Boost line reworded per Q5; every user string says Prune; the Today
  summary must add up to the plan's line (approvals shown or explained); TK's paused-Boost split accepted.
- Direction boards (TK, folded after an independent review) approved by the lead; the Graph tab glyph replaced.
- The brand-mark geometry stays in `src/renderer/design/brand-mark.ts` (the renderer is exempt from the static gate).
- `CONVERSION_VERDICT_MIN` (20) and `RUNWAY_CAP_DAYS` (90) become kernel tier-1 display dials (guard lines, catalog
  rows) re-exported where the renderer reads them; `Foundation.growthSeries` loses its `d = 14` default (a missing span
  is a refusal: empty read + `logger.warn`).

### 7.2 PR-S2r brief (for reference — steps 18 and 20 are done on the branch; only step 19 is left, see §3.3)
Scope: workplan PR steps 18–20 — `src/kernel/registry-changes.ts` RETIRED (the 18 keys of spec §5.12) and CHANGED
ledgers; every golden test computes `snapshot − RETIRED ⊕ CHANGED`; delete retired rows from
`derive.ts`/`policy.ts`/`overrides.ts`/`derive-provenance.ts` (incl. `NOISE.CADENCE_SIGMA`,
`NOISE.DAILY_BOUNDARY_JITTER_MAX_MS`, `jitterBoundary`, `POLICY.BACKOFF_BAND`, `ENGINE.REFILL_PACING_MIN/MAX_MS` with
their overrides, `RIM.ENRICH_PACE_MIN/MAX_MS` — re-express tempo-identity's `dwell.before-press` TODAY prior —
`SCHEDULER.AUTO_PRUNE_CHECK_MS`, `SCHEDULER.USERNAME_REBUILD_BACKOFF_MS`); reviewed tally derived 40 / policy 34 /
override 16 / harness 11; frozen v1 rules get literal copies of the two cadence bounds with a reason; name the unnamed
`derive.ts` literals; `coldFailingThreshold()` = 7; `PRUNE.CONSECUTIVE_FAIL_HALT` override; `EXPLORATION_POLICY`
additions into consumers; target-pipeline exact parks and skip-pool factor; enrich batches `min(profilesPerSlice,
explore left)`; revisit/freshness windows (incl. `unenrichedUsernames`, `decisions.ts:33`) through
`planDayStartAfter(WEEKLY_CYCLE)`; WaitRunner's `'daily-boundary'` path removed; `facts-cadence.ts` legacy interval
branch; `samplePhaseOffset` shim; remaining `?? Math.random` defaults in `primitives.ts`/`page-pacing.ts` → entropy root;
`live-charts.ts` drops the growth-model import; SessionPlanner mentions in comments reworded; cautious floor 60 → 70 s
in its own commit (Q11; CHANGED ledger; ADR 0606 amendment line); finalize ADR 0607 (ledgers, tally) and the
amendments 0202, 0204, 0211, 0212, 0605, 0901. Every PR PENDING entry reaches zero. Gates: full gate,
lifecycle-reachable, plan-qc.

### 7.3 CL brief (closing stream)
1. **Removal sweep** (I.3b; one commit or a few clearly scoped ones): everything listed under CL in §4.2.
2. **Composition checks** (I.4.1) in `tests/main/composition.test.ts`: every `SettingsCapabilities` flag true in the
   fully composed graph; the five `PROJECTIONS` rows push; every `StatusFields` member populated by some contributor
   when built; `BuiltGraph.startupSteps` includes `catch-up`; every `PlanDayClock` consumer is the plan-backed clock;
   `graph.profiles`, the list walker and the drawer share `graph.plan.activity`; the `SurfaceGate` and `preflight`
   seams are the real implementations; `pending-wiring.json` and `PENDING_CONSUMERS` are empty. Close every hole a check
   exposes.
3. **Nothing hardcoded** (I.4.2): allow-list only GEOM + HARNESS with reasons; no `@transitional`; no `Math.random`
   outside the renderer except the entropy root; every spec §17 DEL row gone (grep per name; "one declaration" rows
   have exactly one).
4. **Lead items** (§7.1 last bullet) + `tests/kernel/guard-lines.test.ts` MODULES gains `plan/policy.ts`,
   `surface-policy.ts`, `shell-geometry.ts`, `adapter-bounds.ts` (and any other kernel module with guard lines) +
   deterministic waits for the three load-sensitive tests (§5.5) + a knip review (remove exports the overhaul
   orphaned; keep port types in use).
Gates: full gate twice, lifecycle-reachable, plan-qc.

---

## 8. Quick reference
- Owner memory (auto-loaded each session): `~/.claude/projects/-Users-owengregson-Documents-Peanut/memory/`
  (`plan-derived-overhaul.md`, `limits-derive-from-limit-system.md`, `unified-transport-and-bio-keep-list.md`,
  `account-safety-probing.md`, `root-cause-not-resilience.md`, `background-run-survival.md`, …).
- Gallery (no app launch): `npm run build:dev`, serve `dist/renderer` on 127.0.0.1, open `index.html?gallery=1`;
  the direction boards are the "Board · …" chips at the end of the scenario row.
- Plan QC: `node scripts/plan-qc.mjs`. Timing QC: `node scripts/timing-qc.mjs`. Background probe:
  `node scripts/background-probe.mjs --soak-ms 10000` (local only; quit Epo first; restore `background-probe.json`).
- Machine: 10 CPUs, 24 GB, shared with another project's heavy jobs — keep ≤ 6 concurrent stream agents and jest
  `--maxWorkers` 3–6.
