# 0204 — The wait-noise taxonomy

**Status:** accepted · **Area:** timing (`src/timing/noise.ts`, `wait-runner.ts`)

## Context

Every default install used to wake at exactly `activeHoursStart:00:00.000`,
resume its daily-ceiling park on the same o'clock instant, and sweep
notifications on a bare hourly grid. Deterministic scheduling is a fingerprint,
and it is one no amount of per-action jitter hides.

But not every wait wants the same treatment, and some waits already draw their
own jitter at the call site — noising those again is a double-jitter bug that
quietly widens distributions nobody tuned.

## Decision

Every operational wait is CLASSIFIED, and the class decides the treatment:

| class | what it is | treatment |
|---|---|---|
| `daily-boundary` | a park ending on a configured local-clock boundary | a positive-only offset PAST the boundary, seeded (below) |
| `watcher-cadence` | a persisted due-by interval (the follow-back sweep) | each completed run redraws a bounded factor |
| `retry-backoff` | a park before retrying walled/blocked work | log-normal around the base, bounded |
| `local-beat` | a short internal beat (idle, transient backoff) | uniform inside a band around the base |
| `sub-cadence` | an intra-operation element (scroll waits, rest strides) | same band treatment as a local beat |
| `exact` | the call site already drew its own jitter | passes through untouched |

Three guarantees make this safe, and each is pinned by a test:

1. **One gate.** `WaitRunner` owns the DelayManager for a keyspace and applies
   the class table on every wait, so a classified key cannot reach the delay
   manager un-noised. The class table is `satisfies Record<Key, WaitClass>`, so
   a new key that is not classified is a compile error.
2. **Resume-day seeding.** A daily-boundary offset is seeded by the LOCAL day the
   boundary belongs to (the RESUME day) ⊕ the wait key ⊕ the per-install entropy.
   A park armed at 23:50 and a restart that re-arms it at 00:10 target the same
   boundary, derive the same key, and therefore resume at the IDENTICAL instant —
   which is what makes durable schedules honest. The offset differs per day, per
   key, and per install.
3. **A dedicated noise rng.** Noise never draws from the caller's seeded stream:
   the returned policy samples from the rng bound at construction and ignores the
   sampler's. Merging them would shift every downstream draw and churn every
   seeded test.

## Consequences

- Adding a wait means adding a key and a class — the compiler enforces both.
- The boundary jitter is stable across a mid-park relaunch, so `parkedUntil` is
  a real deadline the UI can count down to.
- `exact` is a deliberate opt-out, not an oversight; its keys are listed in the
  table and asserted by name.
