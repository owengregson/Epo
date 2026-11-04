# Plan-derived overhaul — validation record

## Scope and state

This record accompanies the continuation from
[the November 3 handoff](../superpowers/plans/2026-11-03-plan-derived-overhaul-handoff.md). Implementation and closing
cleanup, including the native-QA repairs, passed the final source gate at `4a2bbcc`. Runtime native verification at
`aa31274`, normal and reduced-motion native checks at `d80c5dd`, and the final keyboard-only reduced-motion run at
`4a2bbcc` passed with the limits recorded below. Gallery results remain tied to their measured revisions; all six
renderer artifacts at `4a2bbcc` are byte-identical to `d80c5dd`. **Implementation and technical offline verification
are complete.** No live-account validation has been performed by this continuation.

Owner visual confirmation under workplan I.4.6 is now recorded after the subsequent
[UI cleanup and interactive browser review](ui-cleanup-2026-11.md#interactive-browser-preview-and-owner-acceptance):
"looks good. continue." Owner-session memory updates were not requested and have not been performed.

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
| Runtime classification, `aa31274` | Full gate | 425 suites / 4,405 tests passed, 5 skipped, zero TODO; boundaries 0 errors / 56 warnings |
| Tour/search repair branch, `bd41d98` (based on `86a716d`) | Focused renderer regressions and static/build checks | 7 suites / 52 tests passed; open-handle rerun clean; 4 line-budget tests, typecheck, lint and build passed; boundaries 0 errors / 56 warnings; integrated at `d80c5dd` with `87c36ef` ordering fix |
| Tour/search repair checkout, `d80c5dd` | Full gate after native-QA fixes, including composition | 427 suites / 4,407 tests passed, 5 skipped, zero TODO; boundaries 0 errors / 56 warnings |
| Tour/search repair checkout, `d80c5dd` | Plan QC, lifecycle reachability and generated catalog | 1,260 plan-days / zero breaches; 3 lifecycle tests passed; catalog current |
| Tour/search repair checkout, `d80c5dd` | Cleanup-audit reconciliation | Wiring/static/default/retirement conclusions unchanged; verified-head Knip has zero added or removed findings against prior final report |
| Final source checkout, `4a2bbcc` | Full gate after native-focus repair | 427 suites passed, 1 skipped; 4,417 tests passed, 5 skipped, zero TODO; boundaries 0 errors / 56 warnings |
| Final source checkout, `4a2bbcc` | Plan QC, lifecycle reachability and generated catalog | 1,260 plan-days / zero breaches; 3 lifecycle tests passed; catalog current |
| Final source checkout, `4a2bbcc` | Cleanup-audit reconciliation | Registries/defaults/retirements unchanged; native-focus-head Knip has zero added or removed findings or metadata changes against verified-head |
| Background bundle `3c96dcc6…3be2` | Isolated background probe | 10/10 scenarios passed; dashboard 120.45 callbacks/s, within measured 150.00 ceiling |
| Background bundle `5bf55c79…fa4b` | Full isolated probe, including dashboard-focused hidden stage | 11/11 scenarios passed; configured soak 10 seconds; dashboard 120.72 callbacks/s |
| Background bundle `e5f481cd…6258` | Targeted dashboard-focused scenario after native-focus assertions added | Passed; dashboard focus true before/after, 8 trusted clicks and 8 acknowledgments; dashboard 120.70 callbacks/s |
| Normal-motion gallery, `44ea8d4` | 63 scenarios × 12 sizes | 756 checks passed; no failures, errors or blocked requests; 120.21 callbacks/s |
| Reduced-motion gallery, `04f5688` | 63 scenarios × 12 sizes | 756 checks passed; no failures, errors or blocked requests; 119.98 callbacks/s |
| Populated normal-motion gallery, `04f5688` | 3 scenarios × 12 sizes, after settling | 36 checks passed; no failures, errors or blocked requests; 120.34 callbacks/s |
| Native baseline, `86a716d` | Fresh disposable profile, blocked network | Observations recorded below; three defects reproduced, so not a final native pass |
| Native runtime verification, `aa31274` | Disposable profile relaunch | Epo 3.1.1, installed-only updates, developer menu, maximized restoration and saved preferences verified |
| Normal-motion native verification, `d80c5dd` | Search and cached-Settings tour replay | Search fully visible; actual seed field revealed and stable after more than seven seconds; Next focused; clean quit |
| Normal-motion changed scenarios, `d80c5dd` | 12 scenarios × 12 sizes | 144 checks passed; no failures, errors or blocked requests; no pacing sample (no Working cases in this selection) |
| Full reduced-motion gallery, `d80c5dd` | 63 scenarios × 12 sizes | 756 checks passed; no failures, errors or blocked requests; 120.21 callbacks/s |
| Reduced-motion native verification, `d80c5dd` | Fresh disposable profile, all eight tour steps | Seed field visible, Next/Finish focused, subsequent tour keyboard navigation, stage shortcuts, Epo 3.1.1 and clean quit observed; initial-focus defect led to final repair |
| Final reduced-motion native verification, `4a2bbcc` | Fresh disposable profile, zero mouse clicks | First Right and all eight tour steps, Return on Finish, stage shortcuts, immediate Settings search, Epo 3.1.1 and clean quit passed |
| Pre-live checkpoint | `refs/backups/pre-live-plan-overhaul-2026-11`, then feature-branch fast-forward | Exact checkpoint/tree/source and final branch state: `results/codex-final-qa/final-ref-state.json` (written after this documentation commit) |

The post-merge gate logs are stored outside the repository under the durable handoff folder's
`results/codex-pr-s2r-merge-gates/`, `codex-cautious-floor-gates/`, `codex-cl-dials-gates/`,
`codex-reads-merge-gates/`, `codex-ui-merge-gates/`, `codex-plan-merge-gates/`, `codex-composition-gates/` and
`codex-click-review-gates/`, `codex-read-review-gates/`, `codex-cl-merge-gates/`,
`codex-ui-review-merge-gates/`, `codex-cleanup-share-merge-gates/`, `codex-bookkeeping-merge-gates/`,
`codex-migration-merge-gates/`, `codex-final-integrated-gates/` (the `86a716d` baseline),
`codex-final-ui-gates/Peanut.log` (the `d80c5dd` tour/search gate), and
`codex-native-focus-merge-gates/Peanut.log` (the `4a2bbcc` final source gate). Plan QC for `d80c5dd` is in
`results/codex-final-qa/plan-qc-verified-head.log`; the final `4a2bbcc` result is in
`results/codex-final-qa/plan-qc-native-focus-head.log`.
Final visual, background and advisory artifacts are under `results/codex-final-qa/`; the full durable folder is
`/Users/owengregson/.claude/projects/-Users-owengregson-Documents-Peanut/overhaul-handoff-2026-11-03/`.
The plan/read/UI merges also passed the three lifecycle reachability tests, the 1,260-day plan QC with zero breaches,
and the generated catalog check. Counts above describe the named
checkouts only, not later unmerged work.

Isolated worktrees skip the one differential leak test that needs git-ignored original captures; the shared checkout
runs it. This accounts for their one-test difference. Structural leak checks over every committed corpus always run.

The read-only cleanup report is `results/codex-final-qa/cleanup-audit-final.md`, initially anchored to `42ee233` and
reconciled through `4a2bbcc`. The audited registries and retirement/default declarations are unchanged. Both pending
registries are empty. The static allow-list has 332 reasoned entries
(226 GEOM + 106 HARNESS), with no PENDING/other class or duplicate key. The selected retired symbols occur only in the
retirement ledger; frozen v1 migration/refusal inputs, account-owned bookkeeping and old-name search aliases are
intentional survivors. `SCORER_DEFAULTS` and `CHAIN_DEFAULTS` each have exactly one declaration from `SETTINGS_POLICY`.

The saved `knip-final.json` advisory has **146 files carrying issues, 148 unused exports and 136 unused exported types**,
plus four unused files and one unused development dependency. Comparison with `knip-after-cl.json` found **zero added
findings** and one removed export finding. The four files are intentional static-scanner inputs, read by tests; the
dependency is the inherited `@testing-library/jest-dom`. Knip is not zero, and this comparison does not certify every
retained exported API as necessary. The `d80c5dd` `knip-verified-head.json` reconciliation has the same counts and
**zero added or removed findings** versus `knip-final.json`; only report order and an existing `StageMount` position
changed. At `4a2bbcc`, `knip-native-focus-head.json` has zero added or removed findings and no per-finding metadata
changes against `knip-verified-head.json`; only report order differs. All four JSON reports are under
`results/codex-final-qa/`.

## Review and regression work

Review covered the overhaul against its feature-branch base. Findings were reproduced with synthetic responses,
fake clocks and disposable stores, plus isolated native UI checks; no live-account response was requested to
investigate them.

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
  failed before the repair and passed afterward; all 22 focused tests and the integrated full gate passed. Native
  re-verification confirmed Epo 3.1.1, no development update action, and the restored developer menu.
- Native QA also reproduced the tour's Settings step leaving its seed field outside the viewport and Settings search
  results painting underneath the plan summary. `bd41d98` scrolls the first measurable tour target into view once,
  remeasures it and keeps Next/Finish focused; the seed anchor is the actual field. The Settings header now stacks
  above sibling entrance-animation contexts. Two Pruning gallery candidate totals were also corrected to match their
  rows. A second review reproduced a cached-Settings race: StageHost's after-paint scroll reset could undo the tour's
  reveal. `87c36ef` moved that reset to `useLayoutEffect`, preserving the entrance stagger; an integrated StageHost/Tour
  regression failed before and passed afterward. Both fixes are integrated in `d80c5dd`, whose full gate and normal
  native recheck passed. The fresh reduced-motion native run also completed all eight steps and exposed the separate
  initial-focus defect below.
- A first Right key reached the embedded error page because restacking the dashboard and focusing its BaseWindow
  did not focus the dashboard's web content. The shell now hands native focus to the dashboard when it owns the
  revealed, visible and focused stage, on stage changes, activation, reveal and initial navigation settlement.
  It guards reentrancy and destroyed/hidden/background windows, preserves uncovered Live input, and does not add a
  focus handoff to later engine navigation. The integrated gate at `4a2bbcc` passes the regressions. A fresh reduced
  launch completed the tour and immediately searched Settings using only the keyboard; the separate local
  background probe also preserved trusted page input while native dashboard focus was sampled before and after.

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

At `d80c5dd`, `results/codex-final-qa/gallery-verified-normal-delta/result.json` records 12 changed scenarios across
all 12 sizes: **144 checks**, zero failures, errors or blocked requests. It has no Working scenario, so it records no
pacing sample. `results/codex-final-qa/gallery-verified-reduced/result.json` records the full 63-scenario reduced-motion
matrix: **756 checks**, zero failures, errors or blocked requests, and **120.21 callbacks/s**. The full normal matrix
and later populated/changed-scenario checks remain separate revision-bound evidence; the 144-check run is not
presented as a fresh full normal matrix.

`results/codex-final-qa/renderer-focus-equivalence.json` records byte-identical hashes for all six renderer build
artifacts between `d80c5dde15c87ab01f5f409396c4bd2edc1028d1` and final source
`4a2bbccbfbc3067d960f408de5e5110c74fd3b4a`. The final focus repair changes main-process behavior; the gallery evidence
above still applies to its renderer. This is artifact equivalence, not an additional gallery run.

The independent read-only image review is `results/codex-final-qa/final-visual-review-ui.md`. It inspected all 13
saved normal-delta PNGs and all 29 saved reduced-motion PNGs at `d80c5dd`, plus two settled populated normal captures
at `04f5688`, and found no actionable visual blocker. That is the manual visual sample; the full automated matrices
are counted above. The report records the sampled sizes and limits, including that the saved Today's plan in detail
image shows the top of Settings rather than the lower detail section. Static captures do not establish focus,
dropdown or tour interaction; those observations are recorded in the native artifacts below.

`results/codex-final-qa/background.json`, measured at `2026-11-04T04:59:43.652Z`, identifies bundle SHA-256
`3c96dcc6f8a48de12fb30ef6e7057a5c7cfb338db846f419852858e47ffd3be2` rather than a git revision. All ten scenarios passed:
never-shown boot, foreground, occluded/unfocused, minimized, window-hidden, app-hidden, stage-hidden, hidden after
navigation, hidden after recovery and the hidden long soak. Dashboard pacing was 120.45 callbacks/s against a
150.00 ceiling. It used the production tab/driver with a temporary profile and loopback-only network; no unhealthy
sample was recorded. This local fixture establishes page progress and input transport, not Instagram behavior.
It did not exercise OS sleep, lid close, display-off, network outage, Windows or Linux.

The final focus follow-up is split across two recorded bundles. `results/codex-final-qa/background-focused.json`
identifies SHA-256 `5bf55c796a545f9d2ca8045c63c73934a858f96ef0ca870deeaecc6d33e0fa4b` and passes all **11 scenarios**,
adding `stage-hidden-dashboard-focused` to the ten above. Dashboard pacing was 120.72 callbacks/s. Its configured
soak was ten seconds; this does not establish crossing the five-minute intensive-throttling threshold.
After adding explicit native-focus assertions, `results/codex-final-qa/background-focused-asserted.json` identifies
SHA-256 `e5f481cd44abb33627d56c1af729712bab5e0b33dfedd9cd5736ef8136fc6258` and reruns **only the new scenario**.
`dashboard.webContents.isFocused()` is true before and after: eight trusted clicks and eight asynchronous
acknowledgments arrive, five trusted wheel events produce scrolling, and health/timers/frames progress. Dashboard
pacing was 120.70 callbacks/s; neither run recorded an unhealthy sample. Focus is sampled at those endpoints,
not continuously. Both runs retain the temporary-profile, loopback-only isolation and platform/live limits above;
the eleven-scenario result is not attributed to the later asserted bundle.

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
successfully loaded Instagram page remains live-only evidence.

`results/codex-final-qa/native-runtime-fixed-observations.json` records `aa31274`: the footer and Updates show Epo
3.1.1; Updates explains that it applies to installed builds and offers no Check button; View includes Reload and
Toggle Developer Tools. The maximized window restored immediately while retaining normal bounds, Practice persisted,
and the completed intro did not repeat. Command-5 opened Settings while accessibility focus remained on the embedded
`chrome-error` web content. The blocked-network app quit cleanly; the real account was not opened.

`results/codex-final-qa/native-ui-fixed-observations.json` records `d80c5dd` in normal motion: Settings search results
are fully visible above the summary, and Return clears the query and scrolls to Practice. A replay from cached
Settings reveals the starting-account field, keeps Next focused and remains stable after more than seven seconds.
Advanced fields, recommendation explanations and Saved/Undo render; Epo 3.1.1, Practice and tour completion persist;
the app quits cleanly.

The same artifact records a fresh disposable profile with `--force-prefers-reduced-motion`: the signed-out shell and
all eight first-run tour steps completed; step 7's starting-account field was fully visible with Next focused, and
step 8 had Finish focused. After clicking Take the tour, subsequent Right navigation and Finish worked. Command-1
showed the offline Live placeholder and Command-5 opened Easy Settings; the footer and Updates showed Epo 3.1.1,
updates were limited to installed builds, and the app quit cleanly.

The initial Right key before clicking Take the tour reached the embedded `chrome-error` page. That defect led to
the final native focus repair, rather than being accepted as a first-launch limitation.

`results/codex-final-qa/native-focus-fixed-observations.json` records the final source `4a2bbcc` with a fresh disposable
profile, blocked network, `--force-prefers-reduced-motion` and **zero mouse clicks**. Take the tour initially held
focus; the first Right advanced to step 2 before any click. After the initial blocked Instagram load settled with
`ERR_TIMED_OUT`, subsequent Right keys still advanced through all eight steps. The seed field was fully visible
with Next focused, and Return on Finish closed the tour. Command-1 selected the offline Live placeholder;
Command-5, slash and `dry` immediately entered Settings search. Return selected Practice, cleared the query and
scrolled to that visible section. The footer and Updates displayed Epo 3.1.1, and Command-Q exited cleanly.

This establishes the recorded keyboard-only first-run flow in the blocked-network reduced-motion profile.
Initial splash animation frames were not captured, and no successfully loaded Instagram page was used for focus or
parsing validation. Automated boot tests establish ordering/frame invariants; live behavior remains separate.

## Live checks remaining

### Preflight repair after owner UI acceptance

The owner accepted the interactive UI preview. Before running L1, inspection found that the old
verify helper caught failures and continued to later steps, did not enforce transport/sentinel/shadow
stop conditions, started recording after the initial load, and could lose a response while awaiting
POST metadata. No live run was attempted with that helper.

`abc0724` confines the repair to the probe. Initial traffic recording begins before tool construction;
the recorder must match the tool and have its debugger attached. A shared abort signal reaches the
visitor, interactor and Actor, and interrupts readiness and settling. Expected nonexistent-profile
`gone` remains valid; own-profile relationship `self` remains valid. Incomplete, noncanonical or
unsafe evidence stops the run. Pending body reads finish within their existing deadlines before
the report is written. `verify.json` now contains `outcome`, `stop`, initial-load coverage, per-step
sentinels, actual exchange count and profile/drawer summaries. Production runtime behavior is unchanged.

Nineteen probe regressions cover the lost-429 race, startup/active-step cancellation, missing recorder,
profile presence, expected absence, false drawer results, shadow disagreement and failed evidence capture.
The integration gate at `abc0724` passed **437 suites / 4,464 tests**, with one suite and five tests skipped;
all other gates passed, boundaries **0 errors / 56 warnings**. Static timing has 331 entries (226 GEOM,
105 HARNESS), after removing one obsolete stringify-indent allowance. Evidence is under
`results/codex-design-cleanup/`: `pre-live-probe-gate.log`, `probe-blocked-launch.log` and
`probe-blocked-output/verify.json`.

The real Electron probe entrypoint was exercised once with a fresh isolated profile and an explicit
`webRequest` block on every request, installed before the ready handler. It stopped at the initial
navigation with `ERR_BLOCKED_BY_CLIENT`, recorded zero API exchanges and no subsequent steps, wrote
the stopped outcome and exited cleanly. This establishes the launch failure path, not live parsing.
`EPO_BLOCK_NETWORK` alone is handled by the main app, not this probe; the offline smoke test uses
the explicit wrapper saved as `probe-blocked-launch.cjs`.

With Epo closed and its saved run intent stopped, the full real profile was copied to a new private
backup outside the repository: 33,311 files, all sizes verified, and 15 top-level store/settings/runtime
files verified by SHA-256. The exact private path and hashes are in `pre-live-backup.json`. The account
has not been opened or contacted. L1 awaits the followed public target requested from the owner.

### Remaining live sequence

The exact request budgets, stop conditions and do-not-run list are in
[spec section 22](../superpowers/specs/2026-11-02-plan-derived-overhaul-design.md#22-the-minimal-live-test-plan-phase-l-strictly-sequential-run-by-the-lead-only-owner-present).
L1 is a single parsing verification; L4 is the supervised reopen after a night away; L5 observes only approved
planned unfollows. Optional Boost follows also require approval. No live success is inferred from offline tests.

Before L1, verify the checkpoint against `results/codex-final-qa/final-ref-state.json`, then back up the entire real Epo
profile, including the store and both settings files. The integration build has not opened that profile. Use one designated
runner with Epo quit before a probe, keep run intent stopped until the supervised Start, and follow section 22's
spacing and first-wall stop rules. L4 requires Epo to remain quit for at least one night; its first upgraded launch
must read exactly one head page and no census, following list or third-party profile before Start.

`EMPTY_BIO` remains unresolved: the scrubbed corpus contains no empty/null biography example
([ADR 0806](../adr/0806-one-parser-tiers.md)). A followed public target with an empty bio, if available for L1, can
supply that evidence. Until then a null biography stays absent and fail safe; no offline resolution is claimed.
S8 deletion of the legacy extractors and reverse-shadow comparators
requires zero `shadow-disagreed` results from both L1 and L4, then a separate gated deletion commit.
