# 0202 — Two pacing models behind one port

**Status:** accepted · **Area:** engine (`src/engine/pacers.ts`)

## Context

The original loop paced growth with a flat metronome: a configured active-hours
window, a daily operating rate, and a jittered inter-action delay. It is easy to
reason about and easy to configure — and it produces a machine-shaped day: work
starts on the o'clock, runs at a constant rate, stops at a constant number.

The organic model replaces that with a session-driven day: circadian sessions
drawn per day, log-normal gaps inside a session, and a daily volume drawn from a
distribution rather than read off a setting.

## Decision

Keep both, behind one `Pacer` port with two methods:

- `gate(now)` — park when this is not a moment to act, returning the StepResult
  that ends the iteration; `null` means proceed.
- `noteAction(at, kind)` — record the action and return the gap owed before the
  next one.

The model is chosen ONCE, at construction: the composition root injects a
`SessionPlanner` only for the organic model, and the Engine builds an
`OrganicPacer` when one is present, a `LegacyPacer` otherwise. **The loop never
branches on which model is wired** — this is what collapsed two parallel gate
chains in `step()` into a single `pacingGate`.

### What each model gates on

| | Organic | Legacy |
|---|---|---|
| daily cap | hard ceiling only (the planner's volume draw closes the session) | operating rate, then the hard ceiling |
| time of day | session open? (subsumes active hours — overnight intensity tapers to ~0) | inside the active-hours window? |
| burst guard | rolling-hour velocity backstop, ledger-backed | the flat paced delay |
| inter-action gap | planner's log-normal within-session draw | `rate.nextDelayMs()` |

The velocity backstop is deliberately defense-in-depth: it reads the ledger, so
it survives a lost planner snapshot.

## Consequences

- Deleting the legacy model later is a one-file change plus a settings key.
- A third model (say, a schedule imported from a calendar) is a third `Pacer`.
- The rest of the loop — the gate table, the deadline arming, the durable
  pacing snapshot — is model-agnostic.
