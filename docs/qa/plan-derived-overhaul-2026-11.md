# Plan-derived overhaul — validation record

## Scope and state

This record accompanies the continuation from
[the November 3 handoff](../superpowers/plans/2026-11-03-plan-derived-overhaul-handoff.md). Implementation and closing
cleanup, including the native-QA repairs, passed the final source gate at `4a2bbcc`. Runtime native verification at
`aa31274`, normal and reduced-motion native checks at `d80c5dd`, and the final keyboard-only reduced-motion run at
`4a2bbcc` passed with the limits recorded below. Gallery results remain tied to their measured revisions; all six
renderer artifacts at `4a2bbcc` are byte-identical to `d80c5dd`. **Implementation and technical offline verification
are complete at those recorded revisions.** On November 4, the first live parsing attempt stopped at target
eligibility; the authorized second attempt reached the final navigation step and exposed a probe settlement gap.
After that gap was repaired offline, a follow-up stopped on unavailable CDP capture data before the drawer.
Their partial evidence is recorded below and does not qualify L1 or the remaining live sequence.

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
files verified by SHA-256. The exact private path and hashes are in `pre-live-backup.json`. At that
preflight checkpoint, the account had not yet been opened or contacted and L1 awaited the owner's target.

### First live attempt, 2026-11-04

The owner provided a target and authorized live testing. At `4760f43`, source matched the full passing
gate at `abc0724`; Epo was closed, run intent was stopped, and all 33,311 profile files were unchanged
since the verified backup. The lead ran `EPO_PROBE=verify` once, with evidence outside the repository
in `results/live-l1-2026-11-04T090943Z/`. The run began at 09:09:43 UTC and exited at 09:10:00 UTC.

The own profile and supplied target both returned canonical, complete profile bodies. The target was
followed, mutual and **private**, so the public-target precondition stopped the probe at `visit-target`.
This was an eligibility failure, not an observed rate-limit or transport wall. The target's raw body
contains `biography: ""` and boolean `is_verified`; its bio presence was `read`. The own profile has
a text biography and the supported `self` relationship classification. No captured body establishes
that null biographies are readable empty biographies.

The lead and an independent agent reviewed saved artifacts only after the run:

- `verify.json` records `outcome: stopped`, `step-result` at `visit-target`, and six `ok` sentinel checks.
- Two canonical, non-partial profile reads, no drift and zero shadow disagreements were observed.
- Of 45 tracked API exchanges, 38 have status 200 and existing, successfully decoded JSON body files.
  Seven target-step requests were still pending at stop and are explicitly incomplete; they have no
  response status/body and cannot be counted as successful responses.
- No HTML, malformed saved JSON, nonempty top-level GraphQL errors or non-2xx response was observed.
- Recorded operations comprise named queries and auxiliary AJAX/REST traffic. No mutation-named
  operation or follow/unfollow/accept endpoint was observed. The probe's zero composed requests and
  zero scripted mutations are also established by its source path, rather than inferred from its
  report's declaration alone.
- The nonexistent-profile visit, all drawer steps and final own-profile-link step did not run.
  Activity-feed, friend-requests and list parsing remain unqualified; only the own-visit PNG exists
  because target validation stopped before its screenshot. The process exit code was zero, which
  does not override the explicitly stopped outcome.
- The shutdown debugger-detach message followed the recorded stop. Epo exited; all 15 critical
  store/settings/runtime hashes still match the backup and saved run intent remains stopped.

**L1 did not pass.** The owner supplied a replacement target after this result; its exact handle is
kept in the private evidence folder's `next-target.json`. Its public status was unverified at that point
and was subsequently confirmed by the second attempt below.
The default one-run-per-day handoff rule initially paused further live work. The owner then explicitly
overrode it: "we can re run now because its fine, you didnt do anything. you can do the live test."
This authorizes one same-day read-only attempt against the replacement target. L4/L5 have not run, and
the legacy comparators stay in place. The empty-string bio observation is retained in the scrubbed
2026-11-04 corpus independently of the incomplete L1 result. It preserves the private flag and pins
canonical, non-partial parsing with every decision-bearing profile field readable. Null and omitted biographies remain
unread. Production scrubbing plus structural and differential leak checks ran against the private capture;
no raw account identifiers or free-text values are committed.

The integrated corpus change at `8ae9706` passed the complete offline gate: **437 suites / 4,479 tests**,
one suite and six tests skipped, boundaries **0 errors / 56 warnings**. The explicit differential leak
and expected-field run passed 47 tests with no skips against the new private capture. Full integration
log: `results/codex-design-cleanup/post-l1-corpus-gate.log`. No parser behavior changed.

### Second live attempt, 2026-11-04

The owner explicitly authorized another attempt that day. The full profile was backed up again with Epo
closed and run intent stopped: 33,445 files, sizes verified, and all 15 critical hashes verified unchanged
from the original backup. The private backup record is `results/codex-design-cleanup/pre-second-l1-backup.json`.
One verify run at `7cb5cdf` began at 09:21:00 UTC and exited at 09:22:27 UTC; its evidence is in
`results/live-l1-second-2026-11-04T092100Z/`.

- The replacement target was public, followed and not requested. Own and target decision-bearing fields
  were readable; all three captured profile bodies were canonical and non-partial.
- The nonexistent profile returned `gone`. Every drawer press returned true, and the drawer was confirmed
  closed. Saved screenshots show the requests panel and its subsequent closure.
- Two activity-feed bodies and one friend-requests body parsed canonically and completely. The saved raw
  response roots reconcile with those inventories; no relevant unrouted response was found. All 27 recorded
  sentinel checks were `ok`, with no drift or shadow disagreement.
- Of 94 API exchanges, 92 returned 200 with saved decoded bodies. Two had no status/body at stop: an initial
  feed subscription and a final profile-suggestions request. They remain incomplete evidence, not successful
  responses. A posts query returned one auxiliary GraphQL server field error alongside its timeline data;
  no authentication, challenge, rate-limit or refusal signature was found in that error.
- The final own-profile-link step stopped with `input:document-changed-after-press`. The destination's
  canonical profile body arrived, but the step never completed its URL verification. The error's 15-second
  text is the configured input budget, not evidence that the code actually waited 15 seconds.
- No follow, unfollow or accept operation was observed or scripted. Epo exited; the critical store/settings/
  runtime hashes still match the refreshed backup, and saved run intent remains stopped.

**L1 did not pass.** The production input guard correctly treats an old-document click acknowledgment as
uncertain. Production identity/startup callers already re-observe the URL after this navigation race; the
verify step lacked that handling. The repair records only the two named document-change uncertainties,
then re-observes the exact own-profile destination on the expected origin without another click. Other
input failures remain fatal. The probe also now requires real activity-feed and friend-requests body
coverage; successful button results alone cannot certify parsing. The recorder retains CDP request IDs
and audits every exchange after pending reads drain, including an earlier entry displaced by a reused
request ID. Existing failure reasons survive that audit; subscriptions receive no exemption.
The incomplete exchanges and auxiliary server error remain part of this run's evidence after the repairs.

The combined repairs at `5d83f35` passed the full offline gate: **438 suites / 4,502 tests**, one suite
and six tests skipped, boundaries **0 errors / 56 warnings**. The focused regressions cover expected
navigation races, wrong identities/origins, retained cancellation and genuine input failures, missing or
delayed drawer bodies, reused request IDs and preservation of earlier transport failures. Independent
review found no blocker. Evidence: `results/codex-design-cleanup/post-live-navigation-gate.log`.

### Repaired live follow-up, 2026-11-04

Using the owner's authorization to continue live testing that day, the lead made one follow-up run
after the combined gate. Epo was closed and the full profile was backed up again: 33,693 files with
sizes verified and all 15 critical hashes unchanged. Private backup record:
`results/codex-design-cleanup/pre-repaired-l1-backup.json`. The run at `5d83f35` began at 09:34:28 UTC
and exited at 09:35:02 UTC; evidence is in `results/live-l1-repaired-2026-11-04T093428Z/`.

The first failure was CDP `Network.getRequestPostData` returning "No resource with given id was found"
for auxiliary AJAX exchange 56 during `visit-nonexistent`. That exchange returned HTTP 200 with
JavaScript MIME, but its subsequent body retrieval also failed. `verify.stop` correctly retained the
metadata failure; the exchange's `failed` field was overwritten by the later body error. The subsequent
reporting fix at `36c492a`, reproduced by a metadata-then-body failure regression, preserves the first
failure consistently. It changes no admission gate or captured-request scope.

The lead and an independent agent reviewed the saved run:

- 56 API exchanges: 55 recorded HTTP 200 responses; 54 saved, decodable bodies. No observed non-2xx,
  HTML response or non-final decoded body. The initial subscription again has no status/body, while
  exchange 56 has a status but no body. Neither qualifies as complete evidence.
- Every exchange now has a CDP request ID; no IDs were duplicated in this run. Reused-ID accounting
  was therefore not the cause of these two incomplete records.
- Own and eligible public target profiles parsed canonically and completely. Nine sentinel checks
  were `ok`; no drift or shadow disagreement was recorded. A posts response again carried one
  auxiliary server field error without an account-wall signature.
- No completed nonexistent-profile result, drawer result or final navigation result was recorded.
  Only own/target screenshots exist. The navigation repair was **not exercised live** in this run.
- No known relationship-mutation operation/path or scripted follow/unfollow/accept call was found.
  The debugger detach followed the stop during shutdown. Epo exited; all critical hashes remain
  unchanged and run intent remains stopped.

**L1 remains unqualified.** Do not infer a rate limit from a CDP retrieval error, or infer a successful
response from an incomplete record. Investigate capture lifecycle locally before further account traffic;
the original stopped artifacts stay intact. L4/L5 and comparator removal remain pending.

The final reporting fix at `36c492a` passed the complete gate: **438 suites / 4,503 tests**, one suite
and six tests skipped; boundaries **0 errors / 56 warnings**, all other gates green. Full log:
`results/codex-design-cleanup/post-live-recorder-gate.log`. The development renderer build was restored
by that gate for the existing browser preview; no UI source changed during these probe repairs.

### Local capture lifecycle experiment

After the stopped follow-up, the lead ran one isolated diagnostic using installed Electron 44.1.1,
synthetic payloads and a loopback-only server. It imported no Epo modules, used a fresh temporary
profile and non-persistent partitions, and allowed only the exact local test origins. The run made
no account requests. Evidence, runner sources and their hashes are retained outside the repository
under `results/capture-lifecycle-repro/`; the result directory is
`run-2026-11-04T09-46-40-457Z/`. An independent agent reviewed the saved result.

Nine cases completed in 5.039 seconds (5.503 seconds including the launcher); the process exited
normally and removed its temporary profile. All stable POST controls passed. The navigation cases
recorded a change in the renderer's OS process ID, rather than assuming a process change from the URL.

| Synthetic case | Default capture | Bounded buffers | Bounded buffers with durable response storage |
|---|---|---|---|
| Stable POST, early and late request/body retrieval | Passed | Passed | Passed |
| Completed POST, late request metadata after process change | Resource unavailable | Resource unavailable | Resource unavailable |
| Completed POST, late response body after process change | Resource unavailable | Resource unavailable | Exact expected body retained |
| Pagehide beacon, server receipt versus CDP observation | Server received; no matching CDP events within 1 s | Same | Same |

The server independently verified the synthetic payload hashes. Inline POST data and early
`getRequestPostData` succeeded in all POST cases, including the default, so this experiment shows
no benefit from increasing the inline POST limit. The beacon cases are missing observations,
not passes: completion of the planned matrix does not establish complete capture. No non-loopback
URL appeared in recorded events, and the network allowlist recorded no blocked requests.

This reproduces a possible capture-loss mechanism, **not the established cause of live exchange 56**.
The live run did not record process/frame lifecycle evidence sufficient to establish that it was a
process change or pagehide beacon. The diagnostic also does not explain the response-less subscription.
Durable response storage alone is not a complete repair, so no production capture setting changed.
The next investigation must reconcile request metadata and response events with the debugger session,
frame/loader and renderer lifecycle, while retaining the first-failure and complete-coverage gates.
The current source requests missing POST metadata immediately on `requestWillBeSent`; a late-read
synthetic failure alone does not demonstrate a deferred-read bug in that path.

The final branch/ref, backup and store-state checkpoint is
`results/codex-design-cleanup/post-live-ref-state.json`. The last code gate remains the passing
`36c492a` run above; subsequent edits only document the evidence. L1, the overnight reopen and the
planned action checks remain unqualified.

### Native capture repair and qualified L1 evidence, 2026-11-04

The capture repair at `c4747b8`, `34b9cfd` and `61ff085` adds an owned native request inventory,
CDP lifecycle evidence and reciprocal request correlation. Unknown ownership, ambiguous matches,
unsafe responses and missing required Reader bodies remain failures. Positive ancillary navigation
cancellations are accounted separately under [ADR 0807](../adr/0807-probe-transport-evidence.md).
The network-blocked harness now uses the independent session proxy; installing capture listeners
cannot replace its network block. An explicit abort after navigation cannot qualify as a navigation
cancellation. Local experiments and their limitations are preserved under
`results/capture-lifecycle-repair/` and `results/capture-class-integration/` in the private handoff.
The actual-class matrix did not wholly pass: one expected completed keepalive instead aborted.
Its negative controls did correctly reject an explicit abort and a missing required Reader body.

The authorized live run at `61ff085` completed every L1 step in 92.842 seconds. Its immutable
`verify.json` says stopped solely because the new native observer mislabeled absent GET uploads
as missing metadata. `0fed42b` corrects that distinction for GET/HEAD only, preserving supplied
uploads, missing POST metadata and contradictory CDP payload evidence. Thirteen isolated Electron
controls confirmed the semantics, with eleven loopback requests, zero external requests, clean exit
and temporary-profile removal. Private evidence: `results/capture-class-integration/get-head-upload/`.

**L1 qualifies on retained live evidence**, with zero additional account requests. An independent
review checked the separate `qualification-v2.json` and its replay script against all original input
and body hashes; the original stopped report was not modified. Evidence:
`results/live-l1-native-2026-11-04T104118Z/`.

- All 100 CDP/native requests have unique reciprocal matches; all 78 POST payload hashes agree.
- 99 completed responses returned HTTP 200 with parseable MIME and have saved decoded bodies.
  One auxiliary request has a positive native abort overlapping observed navigation and is separately
  classified as canceled. There are no unresolved transports or unsafe responses.
- Own/public-followed-target profiles, nonexistent-profile detection, drawer open/filter/requests/close
  and final own-profile navigation succeeded. All 29 sentinel checks were `ok`.
- Six required responses each join their own canonical, non-partial production Reader result:
  three profile bodies, two feed bodies and one requests body. No shadow disagreement was recorded.
  Offline qualification reuses these original live Reader outcomes; it is not another live run.
- Zero composed requests or scripted mutations; no mutation route/operation found in the saved traffic.
  Epo exited, all 15 critical profile hashes remained unchanged, and desired state remained stopped.

The final complete gate at `0fed42b` passed **442 suites / 4,557 tests**, one suite and six tests
skipped, boundaries **0 errors / 56 warnings**. Evidence: `results/codex-design-cleanup/bodyless-get-final-gate.log`.
The first failed integration gate is retained; its four failures exposed the diagnostic constant's
placement in the frozen legacy timing table, corrected without editing the frozen baseline.

### Production reopen and persisted catch-up, 2026-11-04

The first production upgrade launch at `1179a02` followed roughly 32 hours away, with the real
clock and saved state intact. The complete profile was backed up first: 33,805 files, sizes verified,
all 15 critical hashes unchanged (`results/codex-design-cleanup/pre-production-l4-backup.json`).
Epo ran for 156.383 seconds and quit normally with exit 0. **Start was not pressed**; desired state
remained stopped and unblocked. Private evidence and an independent, read-only closed-store audit:
`results/production-l4-2026-11-04T1053Z/`.

- The observed production catch-up completed the profile, notifications and followers-head steps.
  The drawer produced two bodies, `filtered: true`, 100 fresh events, two partial-preview requesters
  and zero accepts. Exactly one followers page requested 50 rows with no cursor, admitted 24 rows
  with zero duplicate/quarantined rows, and stopped at the one-page bound with a next cursor.
  It initialized and persisted the contiguous frontier; ordering remains unverified because the
  evidence is insufficient to promote it. No following frontier or census was created.
- The durable surface tally records one canonical profile, two canonical feed reads and one
  canonical followers-list read, with zero normalized, recovered, failed, wall, row, field or shadow
  counters. The initialized head plus the walker's refusal of partial pages establishes the admitted
  list page was non-partial. The observer did not save its raw body. One novel list key was
  informational only.
- All 31 recorded CDP API exchanges completed with HTTP 200 and parseable MIME. There was one home
  load and own-profile navigation, with no third-party visit or observed mutation. This passive CDP
  record is not a native request inventory or a full body capture.
- The visible header and stored counts agree at 4,119 followers / 3,494 following. Conservation is
  `4,119 - 3,941 = 100 identified gains + 78 unattributed`, with zero identified losses. The old
  anchor predates this absence; the delta is not evidence that all 178 arrived overnight.
  The feed displayed "While you were away"; Diagnostics displayed "Working normally" for profiles,
  notifications and lists. The real screenshot and accessibility text are retained privately.
- All legacy columns of the action ledger (1,046 rows), prune ledger (539), journal (3), and old
  prune scan/remaining rows match the backup. The uncertain journal entry remains uncertain,
  attempts zero, without a retry. No action was dispatched by the observed production work.
- Settings v2 migration preserved the v1 file bytes, Practice, auto-accept, seed, tour completion,
  18 protected account names and eight protected words. It consumed carried bookkeeping.

**L4 is partial, not passed.** The dashboard observer missed installation, leaving zero startup
frames/status pushes. The run therefore does not prove reveal-relative network timing, the boot
movie, post-Start settlement, probation or action cadence. The reusable observer now detects the
dashboard again after its preload and URL are available. A fresh, network-blocked disposable-profile
launch verified one install, 106 renderer events and 67 frames, normal exit and profile removal
(`results/production-l4-observer/local-2026-11-04T105724Z/`). This local repair does not supply the
missing live visual evidence; the original launched scripts and their hashes are preserved.

The live screen also exposed an elapsed-session label with meaningless `0 of 0` progress.
`63a3847` omits progress when neither planned nor completed work exists, retaining meaningful counts.
All 51 existing sidebar copy/zone checks, typecheck and lint passed for that correction.

### S8 comparator retirement and integration review

The separate retirement commit `be01c6c` integrates reviewed work `e317763`. It removes four legacy
runtime modules, eight obsolete response methods and the endpoint mode switch, including its runtime
schema. The authoritative parser, routing, recovery, admission and mutation handling are unchanged.
Historical shadow-disagreement signatures, counters and fail-closed diagnostics remain readable.
No store migration or data deletion was introduced. [ADR 0806](../adr/0806-one-parser-tiers.md#amendment--2026-11-04-s8-comparator-retirement)
records the evidence and decision.

An independent static review found no blockers. It verified all six former synthetic differential
cases now assert authoritative Reader results directly, all 14 real corpus bodies across three
corpora retain replay coverage, and missing/null flags remain distinct from explicit false flags.
Focused validation passed 38 suites / 617 tests, plus 40 tooling tests in three suites. The six
focused skips include opt-in corpus writers and private-original comparison; ordinary replay and
structural leak checks ran. Review and focused logs: `results/s8-comparator-retirement/`.

The complete integration gate on `be01c6c` passed **441 suites / 4,537 tests**, with one suite and five
tests skipped, boundaries **0 errors / 55 warnings**. Every `package.json` check step ran in order,
with Jest limited to two workers; generated files, typecheck, lint, page freshness and the development
build passed. The lower test count reflects retired comparator-only coverage, not missing safety or
corpus checks. Evidence: `results/codex-design-cleanup/s8-final-gate.log` and
`s8-final-gate-summary.json`. The browser gallery was rebuilt by that same gate.

### Remaining live sequence and actual eligibility

The exact request budgets, stop conditions and do-not-run list are in
[spec section 22](../superpowers/specs/2026-11-02-plan-derived-overhaul-design.md#22-the-minimal-live-test-plan-phase-l-strictly-sequential-run-by-the-lead-only-owner-present).
L1 qualifies on retained evidence; the production pre-Start portion of L4 is recorded above, with
the visual and post-Start portions still unqualified. L5 observes only approved, naturally eligible
planned unfollows. No live success is inferred from offline tests.

The actual migrated account state invalidates the old assumed L5 queue. Saved `weaveEnabled: false`
correctly became `cleanup: 'off'`. Startup protection also moved 32 records to `kept`, all for an
existing protected biography word: 25 previously followed back and **all seven queued unfollows**.
This includes the record linked to the uncertain journal entry; the entry itself remains unchanged.
The migration's wider biography-word matching was intentional and disclosed; no word was added.
Thus the old expectation that this record stays `unfollow_queued`, then supplies the first Requested
unfollow, no longer applies. Do not weaken protections, undo `kept`, enable cleanup, fabricate due
records or alter the clock merely to manufacture a passing test.

All of today's drawn sessions had elapsed at launch. The UI's next session was 1:48 PM Pacific,
but saved cleanup-off intent means that session will not provide the proposed unfollow sequence.
No test or automation has been scheduled for that time. L5 needs actual eligible, unprotected work
and the owner's intended cleanup setting. Optional Boost is not a mandatory validation requirement.
Future live work remains lead-only and sequential, with the existing first-wall stop rules.

`EMPTY_BIO` records the empty-string form observed in the scrubbed 2026-11-04 body
([ADR 0806](../adr/0806-one-parser-tiers.md#amendment--2026-11-04-observed-empty-string-biography)).
Null and omitted biographies remain unread and fail safe; this single field observation does not qualify L1.
S8's narrow parser prerequisite is now supported: six canonical, non-partial profile/feed/requests
reads in L1 and the actually admitted canonical, clean, non-partial list page in production L4,
all with zero shadow disagreements. This qualifies the separate comparator-deletion slice under
section 22; it does not turn the partial L4 run or the unperformed L5 run into a pass.
