# 0201 — The recovery ladder

**Status:** accepted · **Area:** engine (`src/engine/recovery.ts`, `recovery-healer.ts`)

## Context

Growth actions fail for two very different reasons: the MACHINERY is broken (the
input pipeline stopped landing events, the tab wedged, a selector drifted), or
Instagram is refusing us (a rate wall). Both look identical at the call site —
every action fails, or every action comes back blocked.

The first design halted terminally on a failure streak (`actions-failing`). That
was wrong in both directions: a rate wall is temporary and waiting fixes it, and
a wedged tab is repairable without spending the day's budget.

## Decision

A classified, durable ladder, owned by `RecoverySupervisor` (`inactive →
holding(n) → probing → exhausted`), with four rules the Engine enforces:

1. **Diagnose the tab BEFORE holding.** The input probe and the renderer canary
   run first. An unhealthy tab is repaired (`recoverTab`) and consumes **no
   rung** and touches **no records** — waiting cannot fix a wedged tab.
2. **Ambiguity presumes a rate wall.** Only a window that is *entirely*
   drift-classified, with clean diagnostics, counts as drift evidence — and
   `adapter-drift` needs **two** such windows, after the first hold. Waiting is
   cheap and reversible; declaring drift is neither.
3. **A definitive refusal skips the streak.** When Instagram's own response
   refuses the mutation (`feedback_required` / 429, surfaced as
   `ChurnActionOutcome.cause === 'rate-limited'`), the ladder is entered on the
   FIRST occurrence: every further attempt deepens the block.
4. **The hold is an absolute deadline, and durable.** It is persisted, so a
   pause, a stop, or an app relaunch mid-hold serves the REMAINDER — stop/start
   is not a way around a backoff. A served hold moves to `probing`; the next
   real actions are the probe, and a verified success clears the ladder.

## The requeue-healer

A ladder reset closes a systemic-incident window, which means the `abandoned`
verdicts that window minted were spurious — the machinery was broken, not the
records. `healIncidentWindow` requeues them **once**, store-only, no IG traffic:

- The window starts `HEAL_GRACE_MS` BEFORE the ladder entry, to cover the entry
  streak's own pre-ladder burn.
- It is capped (`HEAL_MAX_RECORDS`) and each record carries a one-heal marker, so
  a pathological window cannot replay forever.
- Records whose target is no longer active are skipped — nothing would work them.
- The persisted incident is amended with the outcome, so the heal is on record.

## Consequences

- A rate wall costs a long wait instead of a burned queue.
- A wedged tab is repaired without spending a rung.
- The ladder's state survives restarts, which is what makes the hold honest.
- The user's manual Start is the ack that clears an exhausted ladder — and it
  heals the window that terminal halt left open.
