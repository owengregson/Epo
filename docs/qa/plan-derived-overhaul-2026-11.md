# Plan-derived overhaul — validation record

## Scope and state

This record accompanies the continuation from
[the November 3 handoff](../superpowers/plans/2026-11-03-plan-derived-overhaul-handoff.md). Implementation, cleanup,
offline verification and review are in progress. No live-account validation has been performed by this continuation.

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
| Final integrated checkout | Full gates, composition, cleanup audit, review, background and visual checks | Pending |

The post-merge gate logs are stored outside the repository under the durable handoff folder's
`results/codex-pr-s2r-merge-gates/`, `codex-cautious-floor-gates/`, `codex-cl-dials-gates/`,
`codex-reads-merge-gates/`, `codex-ui-merge-gates/`, `codex-plan-merge-gates/`, `codex-composition-gates/` and
`codex-click-review-gates/`, `codex-read-review-gates/`, `codex-cl-merge-gates/`,
`codex-ui-review-merge-gates/`, `codex-cleanup-share-merge-gates/` and `codex-bookkeeping-merge-gates/`.
The plan/read/UI merges also passed the three lifecycle reachability tests, the 1,260-day plan QC with zero breaches,
and the generated catalog check. Counts above describe the named
checkouts only, not later unmerged work.

Isolated worktrees skip the one differential leak test that needs git-ignored original captures; the shared checkout
runs it. This accounts for their one-test difference. Structural leak checks over every committed corpus always run.

The post-cleanup `knip` advisory was reviewed: its only four unused files are static-scanner input fixtures, read by
the scanner tests rather than imported as modules. The removed runtime bridges and duplicate shared modules no longer
appear. Remaining findings are exported helpers/types and the inherited unused `@testing-library/jest-dom` development
dependency; these are not evidence of unwired runtime modules. The JSON report is in `results/codex-final-qa/`.

## Review and regression work

Review is running over the overhaul against its feature-branch base. Findings are reproduced with synthetic
responses, fake clocks and disposable stores; no live response is requested to investigate them.

- The first full following list is stock, not today's outside follows; successful Epo/manual follows must not be
  charged a second time when they later appear in that list. Regression coverage landed with the read-accounting
  merge, including delayed acceptance and interrupted checks.
- Session realization, repeated Boost re-plans, lowered targets, and Prune's unfollow share need ledger-backed
  budgets. A late Boost must also fit the quiet-hours wall. These fixes passed their integrated full gate.
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
  views being ignored, and initial queued/parked postures showing the wrong state. Focused regressions pass; their
  integration verification is in progress.
- A failed settings-bookkeeping consumption could seed a second account with the same unowned freshness stamp.
  Backup restoration could resurrect the unowned stamp even after a successful consume. Both paths are reproduced;
  ownership now persists before consumption, and consumption must succeed before store seeding. The integrated gate
  passes, including a failure of the second write, restart, and corrupt-primary backup restoration.
- Correct refused-v1 schedule mapping exposed probation fitting past quiet hours. The repair uses the same quiet-aware
  close and reserved tail as normal sessions, shrinks kind allocations, and leaves probation for the next viable slot
  when no slower action fits. Focused all-persona realization and zero-room regressions pass; integration is pending.

## Upgrade behavior

- Settings are written to `epo-settings-v2.json`; the original `epo-settings.json` is left untouched for downgrade.
- An older release restores its legacy 3–7 minute floor. The new engine draws its gaps and interaction tempos from
  the day plan. Steady interval settings are retired.
- Protection applies to every unfollow path, including lifecycle work, Prune and a manual unfollow.
- The user-facing tab stays **Prune**. Settings have their own stage with Easy and Advanced modes.
- Store migrations are not backward compatible. Back up the account profile again immediately before the first
  live launch; reverting code alone does not undo a database migration.

## Isolation and visual checks

Use [the isolated-profile instructions](README.md). Record the final build revision and observed results here once
the fix wave and closing cleanup are merged. The required matrix is widths 1024/1440/1920 by heights
640/800/920/1200, normal and reduced motion. Native checks cover the splash and intro, offline deadline,
maximized restoration, stage changes, focus shortcuts and popovers above the embedded view.

Preliminary native check at `1415cc1`: a fresh isolated profile logged the profile override and network block before
the first tab existed, reached the signed-out shell, displayed the offline placeholder after the blocked load, and
opened Settings with the native Command-comma shortcut. The tour dismissed normally and the process quit cleanly.
This is not the final visual matrix or live-account evidence.

## Live checks remaining

The exact request budgets, stop conditions and do-not-run list are in
[spec section 22](../superpowers/specs/2026-11-02-plan-derived-overhaul-design.md#22-the-minimal-live-test-plan-phase-l-strictly-sequential-run-by-the-lead-only-owner-present).
L1 is a single parsing verification; L4 is the supervised reopen after a night away; L5 observes only approved
planned unfollows. Optional Boost follows also require approval. No live success is inferred from offline tests.
