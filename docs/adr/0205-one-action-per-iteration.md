# 0205 — One action per iteration, and the gate table

**Status:** accepted · **Area:** engine (`src/engine/gates.ts`, `engine.ts`)

## Context

The conductor decides, over and over, what to do next: check the tab, park for
the night, sweep follow-backs, refill the queue, act, advance the chain, idle.
Those decisions have a strict precedence, and for a long time that precedence
lived as a 254-line `if`-chain with hand-numbered comments — 24 returns, two
parallel pacing branches, and a prose contract at the top that had already
drifted out of agreement with the code below it.

## Decision

### One action per iteration

`stepOnce()` performs **at most one major thing** and returns exactly one
`StepResult`. Bursts are then structurally impossible rather than rate-limited,
and `stop()`/`pause()` interrupt *between* actions instantly.

The woven prune unfollow shares the SAME action stream — `pickAction` chooses
between a lifecycle churn action and a prune candidate for the one slot, so
unfollows are spread through the session instead of running as a parallel
stream. (A due LIFECYCLE unfollow is never displaced; it is time-sensitive.)

Batching actions inside one iteration would destroy both the pacing model and
the velocity backstop, which count iterations, not intentions.

### The precedence is a table

`GATES` is an ordered array of `{ name, run(ctx) }`. The loop runs each gate in
order and returns the first non-null `StepResult`. The array IS the contract:

```
aborted → sentinel → recovery-hold → sentinel-blocked → clock → pacing
        → target → followback → refill → action → chain → idle
```

Consequences of the ordering, each of which is asserted in
`tests/engine/gates.test.ts`:

- A stopped or halted engine touches nothing — not even the sentinel.
- An auth block halts before any pacing decision is made.
- An armed recovery hold is served BEFORE an `action-blocked` sentinel is routed
  into the ladder; the point of the hold is to stay off Instagram.
- The clock is sampled ONCE per iteration; every gate below reads that instant.
- A parked pacer ends the step before a target is even resolved.
- The follow-back cadence check runs BEFORE refill and actions, so an overdue
  check is the first thing a freshly started engine does (durable schedules).

Each gate delegates its substantive work to the `GateHost` — the Engine — so the
table stays a readable rule list and no gate owns engine state.

## Consequences

- Reordering the loop is reordering an array, and the test that pins the order
  fails loudly rather than a comment quietly rotting.
- Each gate is small enough to read whole, and the pacing fork disappeared into
  one `Pacer` port (ADR 0202).
- The prose contract that used to head `step()` is deleted: the table replaced it.

## Rejected: an actor runtime (`xstate`)

Eleven ordered guards do not need a state-machine library. The table is ~30 lines
with zero new concepts and no new dependency; `RecoverySupervisor` already proves
a hand-written durable FSM reads well in this codebase.
