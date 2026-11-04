# Plan-derived overhaul — validation record

## Scope and state

This record accompanies the continuation from
[the November 3 handoff](../superpowers/plans/2026-11-03-plan-derived-overhaul-handoff.md). Implementation and closing
cleanup passed full gates at `42ee233` and `86a716d`. Native QA then found a branded-runtime version error and two UI
defects. The runtime fix is merged at `aa31274`; tour scrolling and search stacking repairs are ready at `bd41d98`,
awaiting integration and native verification.
Final post-fix verification remains pending, so offline completion is not claimed. No live-account validation has
been performed by this continuation.

The live-account gate is separate from offline completion. Follow/unfollow tests require the owner's explicit
approval for the targets; tests run one at a time. The parser's reverse-shadow comparators remain until L1 and L4
both show zero disagreements. L4 also requires at least one night away with Epo quit.

## Recorded checks

| Checkout / change | Evidence | Result |
| --- | --- | --- |
| PR-S2r merged, `abb90a5` | Full gate | 400 suites passed, 1 skipped; 4,204 tests passed, 5 skipped, 5 todo |
| PR-S2r merged, `abb90a5` | Boundaries | 0 errors, 59 warnings |
| PR-S2r merged, `abb90a5` | Lifecycle reachability | 3 tests passed |
| PR-S2r merged, `abb90a5` | Plan QC | 1,260 simulated days, no breaches |
| PR-S2r merged, `abb90a5` | Generated kernel catalog | Current |
| Cautious floor merged, `2fe4c4d` | Full gate | 4,205 tests passed; boundaries 0 errors / 59 warnings |
| Static timing closure, `6db9222` | Full gate | 4,215 tests passed; boundaries 0 errors / 58 warnings |
| Read-accounting merge, `8203259` | Full gate | 406 suites / 4,233 tests passed; boundaries 0 errors / 58 warnings |
| UI follow-ups, `7c39893` | Full gate | 410 suites / 4,253 tests passed; boundaries 0 errors / 58 warnings |
| Plan fixes, `1415cc1` | Full gate | 413 suites / 4,286 tests passed, 5 skipped, zero TODO; boundaries 0 errors / 58 warnings |
| Composition, `882c42c` | Full gate | 414 suites / 4,295 tests passed, 5 skipped, zero TODO; boundaries 0 errors / 58 warnings |
| Follow proof and dispatch guards, `dbd9193` | Full gate | 414 suites / 4,311 tests passed, 5 skipped, zero TODO; boundaries 0 errors / 58 warnings |
| Parser safety review, `0ee2605` | Full gate | 420 suites / 4,352 tests passed, 5 skipped, zero TODO; boundaries 0 errors / 58 warnings |
| Closing cleanup, `e1a744e` | Full gate | 420 suites / 4,360 tests passed, 5 skipped, zero TODO; boundaries 0 errors / 56 warnings |
| Renderer state review, `54a3771` | Full gate | 421 suites / 4,380 tests passed, 5 skipped, zero TODO; boundaries 0 errors / 56 warnings |
| Numeric cleanup share, `f7d0f53` | Full gate | 422 suites / 4,382 tests passed, 5 skipped, zero TODO; boundaries 0 errors / 56 warnings |
| Durable bookkeeping ownership, `9d62156` | Full gate | 424 suites / 4,387 tests passed, 5 skipped, zero TODO; boundaries 0 errors / 56 warnings |
| Chart and card style restoration, `44ea8d4` | Full gate | 424 suites / 4,387 tests passed, 5 skipped, zero TODO; boundaries 0 errors / 56 warnings |
| Refused-v1 constraints and quiet-aware probation, `42ee233` | Full gate | 425 suites / 4,402 tests passed, 5 skipped, zero TODO; boundaries 0 errors / 56 warnings |
| Integrated baseline, `86a716d` | Full gate | 425 suites / 4,402 tests passed, 5 skipped, zero TODO; boundaries 0 errors / 56 warnings |
| Integrated baseline, `86a716d` | Plan QC, lifecycle reachability and generated catalog | 1,260 plan-days / zero breaches; 3 lifecycle tests passed; catalog current |
| Cleanup audit, `42ee233` (audited sources unchanged at `86a716d`) | Zero-PENDING, static timing, DEL/default declarations and saved Knip comparison | No new blocker; 332 GEOM/HARNESS entries; zero added Knip findings |
| Runtime classification, `aa31274` | Focused regressions, typecheck and lint | 4 suites / 22 tests passed; typecheck and lint passed; native recheck pending |
| Tour/search repair branch, `bd41d98` (based on `86a716d`) | Focused renderer regressions and static/build checks | 7 suites / 52 tests passed; open-handle rerun clean; 4 line-budget tests, typecheck, lint and build passed; boundaries 0 errors / 56 warnings; integration/native recheck pending |
| Final integrated checkout (revision pending) | Full gate after final fixes | Pending: revision, suite/test counts, skips/TODO and boundaries |
| Final integrated checkout (revision pending) | Plan QC, lifecycle reachability and generated catalog | Pending final-head results; earlier recorded results do not establish this checkout |
| Final integrated checkout (revision pending) | Composition and cleanup-audit reconciliation | Pending confirmation after the final fixes; audit evidence below names its checkout |
| Background bundle `3c96dcc6…3be2` | Isolated background probe | 10/10 scenarios passed; dashboard 120.45 callbacks/s, within measured 150.00 ceiling |
| Normal-motion gallery, `44ea8d4` | 63 scenarios × 12 sizes | 756 checks passed; no failures, errors or blocked requests; 120.21 callbacks/s |
| Reduced-motion gallery, `04f5688` | 63 scenarios × 12 sizes | 756 checks passed; no failures, errors or blocked requests; 119.98 callbacks/s |
| Populated normal-motion gallery, `04f5688` | 3 scenarios × 12 sizes, after settling | 36 checks passed; no failures, errors or blocked requests; 120.34 callbacks/s |
| Native baseline, `86a716d` | Fresh disposable profile, blocked network | Observations recorded below; three defects reproduced, so not a final native pass |
| Final native shell (revision pending) | Splash/intro, offline deadline, restoration, stages, shortcuts and popovers | Pending final observations and artifacts |
| Pre-live checkpoint | `refs/backups/pre-live-plan-overhaul-2026-11`, then feature-branch fast-forward | Pending ref SHA and final branch state |

The post-merge gate logs are stored outside the repository under the durable handoff folder's
`results/codex-pr-s2r-merge-gates/`, `codex-cautious-floor-gates/`, `codex-cl-dials-gates/`,
`codex-reads-merge-gates/`, `codex-ui-merge-gates/`, `codex-plan-merge-gates/`, `codex-composition-gates/` and
`codex-click-review-gates/`, `codex-read-review-gates/`, `codex-cl-merge-gates/`,
`codex-ui-review-merge-gates/`, `codex-cleanup-share-merge-gates/`, `codex-bookkeeping-merge-gates/`,
`codex-migration-merge-gates/` and `codex-final-integrated-gates/` (the `86a716d` baseline).
Final visual, background and advisory artifacts are under `results/codex-final-qa/`; the full durable folder is
`/Users/owengregson/.claude/projects/-Users-owengregson-Documents-Peanut/overhaul-handoff-2026-11-03/`.
The plan/read/UI merges also passed the three lifecycle reachability tests, the 1,260-day plan QC with zero breaches,
and the generated catalog check. Counts above describe the named
checkouts only, not later unmerged work.

Isolated worktrees skip the one differential leak test that needs git-ignored original captures; the shared checkout
runs it. This accounts for their one-test difference. Structural leak checks over every committed corpus always run.

The read-only cleanup report is `results/codex-final-qa/cleanup-audit-final.md`, anchored to `42ee233`; the audited
sources are unchanged at `86a716d`. Both pending registries are empty. The static allow-list has 332 reasoned entries
(226 GEOM + 106 HARNESS), with no PENDING/other class or duplicate key. The selected retired symbols occur only in the
retirement ledger; frozen v1 migration/refusal inputs, account-owned bookkeeping and old-name search aliases are
intentional survivors. `SCORER_DEFAULTS` and `CHAIN_DEFAULTS` each have exactly one declaration from `SETTINGS_POLICY`.

The saved `knip-final.json` advisory has **146 files carrying issues, 148 unused exports and 136 unused exported types**,
plus four unused files and one unused development dependency. Comparison with `knip-after-cl.json` found **zero added
findings** and one removed export finding. The four files are intentional static-scanner inputs, read by tests; the
dependency is the inherited `@testing-library/jest-dom`. Knip is not zero, and this comparison does not certify every
retained exported API as necessary. Both JSON reports are under `results/codex-final-qa/`.

## Review and regression work

Review is running over the overhaul against its feature-branch base. Findings are reproduced with synthetic
responses, fake clocks and disposable stores; no live response is requested to investigate them.

- The first full following list is stock, not today's outside follows; successful Epo/manual follows must not be
  charged a second time when they later appear in that list. Regression coverage landed with the read-accounting
  merge, including delayed acceptance and interrupted checks.
- Session realization, repeated Boost re-plans, lowered targets, and Prune's unfollow share need ledger-backed
  budgets. A late Boost must also fit the quiet-hours wall. These fixes passed their integrated full gate.
- Numeric cleanup-share settings now reach the plan intent, digest and allocation. Regressions exercise both a live
  Advanced override and a migrated custom v1 fraction; clearing the override restores the normal pattern. The fix
  passed the integrated gate at `f7d0f53`.
- Unrouted recovery candidates and observed mutation responses must pass the same HTTP/MIME gate as normal reads.
  An exchange with GraphQL errors must not become a successful mutation through an optimistic DOM flip.
- Partial or drifted dialog lists must not authorize a completeness/absence verdict. Recovered or partial profile
  facts must not authorize a follow using stale stored eligibility. Focused regression failures reproduce these
  parser and click-review seams. Both repairs are merged and passed their integrated full gates.
- An already-open request-acceptance pass must recheck current caps and session identity. Its own pacing deadline
  is the only deadline it may exempt. The lowered-target bypass is repaired and passed the integrated cleanup gate.
- Protection edits and Practice toggles after a profile visit must still prevent the impending press, including
  subsequent confirm layers. Red tests reproduce both races; the local per-action guard uses the existing visit's
  evidence without another read or admission. The fix is merged and passed the integrated full gate.
- Renderer review reproduced delayed bootstrap responses overwriting newer pushes, same-revision derived Settings
  views being ignored, and initial queued/parked postures showing the wrong state. These fixes are merged and passed
  their integrated full gate at `54a3771`. Surviving chart/card styles were restored and gated at `44ea8d4`.
- A failed settings-bookkeeping consumption could seed a second account with the same unowned freshness stamp.
  Backup restoration could resurrect the unowned stamp even after a successful consume. Both paths are reproduced;
  ownership now persists before consumption, and consumption must succeed before store seeding. The integrated gate
  at `9d62156` passes, including a failure of the second write, restart, and corrupt-primary backup restoration.
- Refused-v1 settings now retain custom quiet hours, slower check/census cadence, lower caps, slower walk tempo and
  the completed tour. The refusal panel reports dropped non-string protection entries and handles non-object legacy
  JSON safely. Normal persona migration still creates zero default-only overrides. These changes are merged at
  `42ee233`; its integrated full gate passed.
- Correct refused-v1 schedule mapping exposed probation fitting past quiet hours. The repair uses the same quiet-aware
  close and reserved tail as normal sessions, shrinks kind allocations, and leaves probation for the next viable slot
  when no slower action fits. Focused all-persona realization and zero-room regressions pass; the repair is merged at
  `42ee233`, with its integrated full gate passed.
- Native QA showed that the branded development executable can report `app.isPackaged = true`, so the earlier
  version helper still displayed Electron's `44.1.1` and chose an update mode for a script launch. `aa31274` uses
  `process.defaultApp` as well for updater version/mode, the development menu and the Dock icon. Three new regressions
  failed before the repair and passed afterward; all 22 focused tests passed. Native re-verification is pending.
- Native QA also reproduced the tour's Settings step leaving its seed field outside the viewport and Settings search
  results painting underneath the plan summary. `bd41d98` scrolls the first measurable tour target into view once,
  remeasures it and keeps Next/Finish focused; the seed anchor is the actual field. The Settings header now stacks
  above sibling entrance-animation contexts. Two Pruning gallery candidate totals were also corrected to match their
  rows. Seven focused renderer suites / 52 tests passed, with a clean open-handle rerun; integration and native results
  remain pending.

## Upgrade behavior

- Settings are written to `epo-settings-v2.json`; the original `epo-settings.json` is left untouched for downgrade.
- An older release restores its legacy 3–7 minute floor. The new engine draws its gaps and interaction tempos from
  the day plan. Steady interval settings are retired.
- Protection applies to every unfollow path, including lifecycle work, Prune and a manual unfollow.
- The user-facing tab stays **Prune**. Settings have their own stage with Easy and Advanced modes.
- Store migrations are not backward compatible. Back up the account profile again immediately before the first
  live launch; reverting code alone does not undo a database migration.

## Isolation and visual checks

Use [the isolated-profile instructions](README.md). The required matrix is widths 1024/1440/1920 by heights
640/800/920/1200, normal and reduced motion. Native checks cover the splash and intro, offline deadline,
maximized restoration, stage changes, focus shortcuts and popovers above the embedded view.

`results/codex-final-qa/gallery-final-normal/result.json` identifies revision
`44ea8d439d54cdb44d01972cfca2d61841230573`: 63 scenarios across all 12 sizes, 756 checks, zero failures, errors or
blocked requests. Its dashboard pacing sample was 120.21 callbacks/s. This result covers that revision only.

`results/codex-final-qa/gallery-final-reduced/result.json` identifies revision
`04f5688027c6c8c6e7b325cf1f34ec954a2a01e5`: all 63 scenarios across the 12 sizes, 756 checks, zero failures, errors or
blocked requests, and 119.98 callbacks/s. The same revision's
`results/codex-final-qa/gallery-populated-normal-settled/result.json` records three populated scenarios across the 12
sizes after animations settled: 36 checks, zero failures, errors or blocked requests, and 120.34 callbacks/s. This
supplements the earlier full normal-motion matrix; it is not a second 756-check normal-motion run.

`results/codex-final-qa/background.json`, measured at `2026-11-04T04:59:43.652Z`, identifies bundle SHA-256
`3c96dcc6f8a48de12fb30ef6e7057a5c7cfb338db846f419852858e47ffd3be2` rather than a git revision. All ten scenarios passed:
never-shown boot, foreground, occluded/unfocused, minimized, window-hidden, app-hidden, stage-hidden, hidden after
navigation, hidden after recovery and the hidden long soak. Dashboard pacing was 120.45 callbacks/s against a
150.00 ceiling. It used the production tab/driver with a temporary profile and loopback-only network; no unhealthy
sample was recorded. This local fixture establishes page progress and input transport, not Instagram behavior.
It did not exercise OS sleep, lid close, display-off, network outage, Windows or Linux.

Preliminary native check at `1415cc1`: a fresh isolated profile logged the profile override and network block before
the first tab existed, reached the signed-out shell, displayed the offline placeholder after the blocked load, and
opened Settings with the native Command-comma shortcut. The tour dismissed normally and the process quit cleanly.
This is not the final visual matrix or live-account evidence.

`results/codex-final-qa/native-baseline-observations.json` records the native baseline at
`86a716d2a10d4cc2b4a6fb46a50cc7cc7f53c143`, using a fresh disposable profile with network blocking and no copied
account data. Observed: the signed-out shell and eight-step first-run tour; offline Live placeholder; native
Command-comma and Command-1 through Command-4 stage shortcuts; Gentle save then Undo back to Balanced; Practice
persistence in that disposable profile; Prune's Edit in Settings scrolling to Protection; the Pages tour overlay
remaining above the Live placeholder; and native zoom persisting `maximized: true` followed by a clean Command-Q exit.

That baseline reproduced the version, seed-scroll and search-stacking defects described above. Initial launch
animation frames were not captured; automated boot tests cover ordering and frame-specific invariants. Focus on a
successfully loaded Instagram page remains live-only evidence. The maximized flag was observed persisted, not yet
verified by a second launch. **Final post-fix native revision, restoration and observations: pending.**

## Live checks remaining

The exact request budgets, stop conditions and do-not-run list are in
[spec section 22](../superpowers/specs/2026-11-02-plan-derived-overhaul-design.md#22-the-minimal-live-test-plan-phase-l-strictly-sequential-run-by-the-lead-only-owner-present).
L1 is a single parsing verification; L4 is the supervised reopen after a night away; L5 observes only approved
planned unfollows. Optional Boost follows also require approval. No live success is inferred from offline tests.

Before L1, finish the offline rows above, create the pre-live checkpoint, and back up the entire real Epo profile,
including the store and both settings files. The integration build has not opened that profile. Use one designated
runner with Epo quit before a probe, keep run intent stopped until the supervised Start, and follow section 22's
spacing and first-wall stop rules. L4 requires Epo to remain quit for at least one night; its first upgraded launch
must read exactly one head page and no census, following list or third-party profile before Start.

`EMPTY_BIO` remains unresolved: the scrubbed corpus contains no empty/null biography example
([ADR 0806](../adr/0806-one-parser-tiers.md)). A followed public target with an empty bio, if available for L1, can
supply that evidence. Until then a null biography stays absent and fail safe; no offline resolution is claimed.
S8 deletion of the legacy extractors and reverse-shadow comparators
requires zero `shadow-disagreed` results from both L1 and L4, then a separate gated deletion commit.
