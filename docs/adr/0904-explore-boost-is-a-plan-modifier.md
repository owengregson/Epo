# 0904 — Explore Boost is a plan modifier that never raises a ceiling

**Status:** proposed (the backend landed with the plan core; the runtime and sidebar streams wire it)
· **Area:** kernel plan, governors, main · **Builds on:** ADR 0607

## Context

The owner asked for a control that focuses Epo on "exploration and following new profiles" for a
while. A second pacer or a raised ceiling would break the one plan (ADR 0607) and the safety
envelope. Under "Boost never adds volume" the button would add zero follows in the most common
states (cleanup off, the first days, keep-following), which reads as broken (owner Q5, answered with
the bounded alternative).

## Decision

1. **State and writer.** The window lives in `plan_state.boost` (`{v, startedAt, endsAt, durationMs,
   endedAt, endReason}`) per account; the plan service writes the window and the re-plan in one
   `setPlanState`. Wall time counts (closed, offline, holding). Clock rules: a backward jump past the
   tolerance ends it (`clock`), an over-long window is clamped, a past one expires.
2. **The overlay** (`applyBoost`, the final step of every draw and every re-plan cause): sessions
   starting inside the window (and the open one) get the Boost mix — no unfollows; follows up to
   `P0`; the remainder's unfollow and slack budget become follows — and the day may be **lifted** to
   `automaticDayMax(P0)` (prorated), placed only where a session's window lets it. `M`, `H`, the gap
   floor, the tempo and the D6 totals never move.
3. **Act now** keys on **run intent**, never on the engine's state: when Epo is meant to run, no
   session is open and now lies in the day's central λ_eff mass outside quiet hours, a session opens
   now and the waiting sessions re-lay after it with budgets summing to theirs. "Start Epo and Boost"
   is one ordered command: advance run intent, write the window and re-plan, start the engine.
4. **Honest previews and typed refusals.** `previewBoost` is `applyBoost` on a copy: what moves, the
   lift, the act-now effect and `why` (`ready`, `nothing-to-shift`, `backlog`, `quiet-hours`,
   `day-off`, `limit-reached-today`, `engine-stopped`). Refusals are typed (`already-on`, `not-on`,
   `bad-duration`, `backlog`, `nothing-to-shift`, …). A Boost is refused while earlier Boosts'
   deferred unfollows would not clear within `MAX_BACKLOG_DAYS` non-Boost plan-days.
5. **Never deferred:** the safety prefix, journal settlement, click verification, `MutationWatch`, the
   recovery ladder, the hard and velocity ceilings, and the own-header read at session start. Manual
   prune runs and scans refuse with `boost-active` while a Boost is on.
6. **One projection:** `EpoStatus.boost` (`off | on | waiting | paused`; paused while the window is
   open and run intent is stopped). A quit stops work, not the clock.

## Consequences

- Laws L13 (the overlay survives every re-plan cause), L13b (honesty: with nothing to swap and no
  lift, Boost changes no budget) and L14/L14b (backlog clears; over a week Boost adds at most the
  lifts it granted plus the remainder it reallocated) hold in the kernel tests.
- Back-to-back Boosts cannot grow the following count without bound (the backlog guard).

## Alternatives rejected

- Boost state in Settings (global, wiped by reset) or Chronos (no production consumer): two writers
  of one decision.
- Raising `M` or `H` for the window: ceilings never rise for convenience.
- Inserting the act-now session after starting the engine: it would wait for the next planned
  session instead (the ordered command is a tested contract).
