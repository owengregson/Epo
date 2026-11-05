# 0104 — One tab lease, and a cool-down keyed on reasons the engine emits

Status: accepted (2026-09-02)

## Context

There is one Instagram page and three things that want it: the growth loop, the
prune scan/run, and the intro tour (which wants nobody on it). That state
machine lived as six mutually-constraining booleans on `Foundation`
(`activeDriver`, `growthPausedForPrune`, `growthPausedForTour`, `tourHold`,
`profileLandDeferred`, `pendingGrowthStart`) mutated from eight call sites, with
the prune↔growth↔tour hand-off — the app's most bug-prone area — testable only
by driving the whole app.

Separately, the scheduled-prune cool-down gated on the halt reason string
`'sentinel:action-blocked'`. The growth engine no longer emits it: that sentinel
status now enters the recovery ladder. Both copies of the gate (before and after
the launch jitter) were therefore half-dead literals.

## Decision

`src/main/services/tab-lease.ts` owns the driver token, the borrow/return pair,
the tour hold, the deferred-landing latch and the growth spin-up bridge. It has
no store, no tab and no electron, so it is unit-testable directly
(`tests/main/tab-lease.test.ts`).

Two invariants are stated in the type rather than in comments:

- `returnToGrowth(borrower)` resumes only if THAT borrower's `pauseGrowthFor`
  paused a running loop. A user's own pause is never undone, and the prune and
  the tour cannot settle each other's debt.
- `borrowFromGrowth` always waits for the pause gate, including when the user
  paused — `pause()` returns while the in-flight step is still running, and
  handing the page over at that moment put two drivers on one WebContents.

`release(owner)` drops the token only if `owner` still holds it. That is the
generation guard: a wedged loop settling after a watchdog restart must not free
the tab under the live run.

The prune cool-down now keys on `isRateLimitHalt()` from
`src/engine/halt-reason.ts` — the engine's own vocabulary, so the set cannot
drift from what it emits — and additionally on a LIVE recovery ladder whose
tally already classified a rate-limited failure. The halt only lands after every
rung is spent; the long hold before it is exactly when a census walk must not
run. One helper (`pruneRateCooldown`) serves both check points.

## Consequences

- `pendingGrowthStart` is now gated (`beginGrowthStart()`), so a repeated start
  can no longer leak a ref-counted veil hold.
- The tour hold pauses without waiting for the pause gate, as before: it only
  needs the loop to stop scheduling work, not to hand the page over.
- `Foundation` still owns the tour POLICY (what to re-run on release); the lease
  owns only the state.
