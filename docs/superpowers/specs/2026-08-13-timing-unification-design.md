# Timing Unification — DelayManager, ScheduleManager, and the timing package

**Date:** 2026-08-13
**Status:** Approved

## Problem

Delays and scheduling are scattered across the codebase with heavy duplication and
no shared abstraction:

- The bare `sleep(ms)` promise wrapper is independently defined 8 times
  (`engine.ts`, `adapter/actor.ts`, `adapter/identity.ts`, `rim/followers-page-reader.ts`,
  `rim/profile-enricher.ts`, `livetest/steps.ts`, `capture/*`, `inspect/*`).
- The humanized `base + jitter` delay formula exists in 3 near-verbatim copies
  (`governors/rate-governor.ts:73`, `engine/prune-engine.ts:590` with a ×1/3 factor,
  `rim/followers-page-reader.ts:125` jitterless variant) plus 3 more ad-hoc jitter
  shapes in livetest and `engine.ts:797`.
- `interruptibleSleep` (abort-aware sleep chained to a run token) is copy-pasted
  verbatim between `engine.ts:766` and `prune-engine.ts:598`.
- The `src/adapter/` layer has no cancellable sleep at all — `actor.waitFor` can
  block up to 8 s uninterruptibly; the 90 s `PRUNE_PARK_TIMEOUT_MS` exists as a
  defense against exactly this.
- Operational timing constants are magic numbers strewn across every subsystem.
- Renderer issues: `useEngineStatus`/`usePruneStatus` are byte-identical duplicates;
  `useCountdown` estimates the next action from the settings band midpoint (wrong by
  3× for prune); `ProjectionChart` has an uncancelled 1300 ms timeout; `QueueRowItem`
  hardcodes the 4-day/2-day followback windows that are actually user settings;
  `engine.ts` keeps the 4 h follow-back sweep cadence in memory only, resetting on
  every restart.

Existing good foundations: abort-aware `defaultSleep` (`engine.ts:97`) and the
injectable `SystemClock`/`FakeClock` (`governors/clock.ts`).

## Scope

**In:** all main-process operational delays (engine, prune, governors, adapter, rim,
main wiring, connectivity, dev harnesses); a shared renderer-safe primitives module;
a timing-constant registry; the four approved behavioral improvements
(cancellable adapter waits, real countdown deadlines, persisted sweep cadence,
renderer bug fixes).

**Out:** renderer presentational timings (motion, toasts, tooltips, debounces) beyond
the named bug fixes; exponential backoff (nothing uses it); making registry constants
user-configurable (user knobs stay in `settings.ts`).

## Architecture

New package `src/timing/` with four modules. Two runtime systems — **DelayManager**
(in-flight waits) and **ScheduleManager** (periodic work) — built on a pure
primitives module and a constants registry. Clock and rng are injected everywhere.

### 1. `src/timing/primitives.ts` — pure, renderer-safe, dependency-free

- `sleep(ms, signal?)`: the one canonical sleep. Abort-aware; resolves early on
  abort, never rejects (matching today's `defaultSleep` semantics). Replaces all
  8 local copies.
- `DelayPolicy`: a pure `(rng) => ms` sampler with constructors covering every
  shape found in the codebase:
  - `fixed(ms)` — parks, idle beats, retry spacing
  - `uniform(minMs, maxMs)` — scan pacing, refill pacing, livetest jitter
  - `jittered(minMs, maxMs, jitterPercent)` — the humanized formula
    (uniform base, then symmetric ± jitterPercent), written exactly once
  - `scaled(policy, factor)` — prune's ×1/3 composes instead of forking the formula
- `sample(policy, rng)` for one-off draws (harnesses).
- `withTimeout(promise, ms)` — for `awaitParked` and the connectivity request
  timeout pattern.

`rate-governor.nextDelayMs()` keeps its public API but delegates to `jittered(...)`.
`prune-engine.nextDelayMs()` becomes `scaled(jittered(...), PRUNE.DELAY_FACTOR)`.
`followers-page-reader.nextWaitMs()` becomes `uniform(...)` / `fixed(...)`.

### 2. `src/timing/delay-manager.ts` — the stateful wait owner

Constructed with `{ clock, rng }` (both injectable — this also fixes the currently
untestable `pacingSleep`, which calls `Math.random` directly).

API:

- `wait(key, policyOrMs, { signal?, label? })` → `Promise<{ completed: boolean }>`.
  Registers a named pending delay (`key`, `startedAt`, `deadline`), links to an
  external `AbortSignal` (replacing both `interruptibleSleep` copies), unregisters
  on settle. Never rejects on abort.
- `cancel(key)` / `cancelAll(prefix?)` — prefix-scoped, so `cancelAll('engine:')`
  mirrors today's run-generation abort.
- `pending(): PendingDelay[]` and `onChange(listener)` — observability. Main pushes
  real deadlines into the existing engine/prune status payloads (`nextActionAt`).

Keys are namespaced: `engine:action-delay`, `engine:idle`, `engine:active-hours-park`,
`engine:daily-ceiling-park`, `prune:action-delay`, `prune:park`, etc. The manager is
a live registry of "why are we waiting and until when".

### 3. `src/timing/schedule-manager.ts` — periodic work

- `every(key, intervalMs, fn, { unref?, immediate? })` — tick loops with a built-in
  overlap guard (ticks are dropped while `fn` is in flight, generalizing
  connectivity's `checking` guard). Absorbs the connectivity probe (20 s) and the
  30-min auto-prune watcher. Per-key `stop()`, idempotent `dispose()`, task errors
  caught and logged — an exception never kills the loop.
- `cadence(key, { everyMs, getLastRunAt, setLastRunAt })` — due-by-timestamp
  scheduling with `isDue(now)` / `markRun(now)`. Absorbs `pruneDue()` and the
  follow-back sweep. The sweep's timestamp is persisted via a new
  `sweepLastRunAt` settings field (symmetric with the existing `pruneLastRunAt`),
  so the 4 h cadence survives restarts.

### 4. `src/timing/config.ts` — the timing constant registry

Every hardcoded operational timing constant moves here, grouped by namespace, each
with a one-line "why this value" comment. Renderer-safe (constants only, no Node
imports).

- `ENGINE`: `IDLE_MS` (30 s), `REFILL_PACING_MIN_MS`/`MAX_MS` (2 s / 5 s)
- `PRUNE`: `DELAY_FACTOR` (1/3), `PARK_MS` (30 s), `SCAN_FRESH_MS` (15 min),
  `PARK_TIMEOUT_MS` (90 s)
- `CONNECTIVITY`: `PROBE_INTERVAL_MS` (20 s), `REQUEST_TIMEOUT_MS` (5 s)
- `SCHEDULER`: `AUTO_PRUNE_CHECK_MS` (30 min), `USERNAME_RESOLVE_RETRY_MS` (1.5 s)
- `ADAPTER`: `POLL_INTERVAL_MS` (250), `POLL_TIMEOUT_MS` (8 s),
  `IDENTITY_RETRY_MS` (1.2 s), `IDENTITY_ATTEMPTS` (4), nav-settle poll values
- `RIM`: `SCROLL_WAIT_MS` (2 s), `ENRICH_PACE_MS` (1 s), fetch bounds
  (`maxRounds` / `noNewStop` sets)
- `POLL`: `KEEPALIVE_MS` (10 s, shared with the renderer keep-alive hook)
- `HARNESS`: livetest/capture/inspect poll intervals and settle times

Consumers import from `timing/config`; the old per-file declarations are deleted.
User-configurable values stay in `settings.ts` — one home for each kind of value.
Renderer presentational timings stay in `motion.ts` and their hooks.

### 5. Cancellable adapter layer

`adapter/actor.ts` and `adapter/identity.ts` accept an optional `AbortSignal` in
their deps. Their sleeps become `primitives.sleep(ms, signal)`; `waitFor` and the
identity retry loop check the signal each iteration and bail early. Wiring passes
the engine's run token down, so stop/pause can interrupt the DOM polls.
`profile-enricher` pacing gains the same signal support. `followers-page-reader`
keeps its cooperative `shouldStop` (existing callers) and additionally accepts a
signal. The 90 s `PRUNE_PARK_TIMEOUT_MS` defense stays but should rarely fire.

### 6. Renderer

- New `useKeepAlivePoll(channel, ...)` hook; `useEngineStatus` and `usePruneStatus`
  become thin wrappers over it (deletes the byte-identical duplication).
- `useCountdown` consumes the pushed `nextActionAt` deadline instead of estimating
  from the settings band midpoint — correct for growth and prune by construction.
- Bug fixes: `ProjectionChart`'s 1300 ms timeout gets cleanup-on-unmount and its
  constant moves to `motion.ts`; `QueueRowItem` reads the followback/hold windows
  from settings instead of hardcoded 4-day/2-day copies.
- Debounces, toasts, tooltip and animation timers are untouched.

### 7. Dev harnesses

livetest/capture/inspect swap their local `sleep`/`delay`/`jittered` helpers for
`timing/primitives` and `timing/config.HARNESS` constants. Mechanical, low risk,
not wired into DelayManager (they are standalone processes).

## Data flow

1. Engines receive a `DelayManager` via deps (alongside the existing clock).
2. Every operational wait goes through `delayManager.wait(key, policy, { signal })`,
   where `signal` is the run-generation token the engines already maintain.
3. `DelayManager.onChange` feeds the main process, which includes `nextActionAt`
   (the active wait's deadline, when one is pending) in the engine/prune status
   payloads already pushed over IPC.
4. `ScheduleManager` is owned by `foundation-wiring` (main), started at boot,
   disposed on shutdown; cadence persistence goes through `settings.ts`.

## Error handling

- Waits resolve `{ completed: false }` on abort; they never reject.
- ScheduleManager catches and logs task exceptions; loops keep running.
- `dispose()` on both managers is idempotent and cancels/clears everything.
- Engine semantics preserved: a pause/stop landing during an action still skips the
  humanized delay (no fresh wait is opened), keeping the prune hand-off unblocked.

## Testing

- FakeClock/seeded-rng unit tests for primitives: policy bounds, jitter symmetry,
  `scaled` factor (the existing prune expectation — a 60 000 ms draw scaled to
  20 000 ms — is preserved).
- DelayManager: register/settle lifecycle, `cancel`/`cancelAll` prefix scoping,
  external-signal linking, `pending()`/`onChange` correctness, no-reject-on-abort.
- ScheduleManager: overlap guard drops (not queues) ticks; cadence `isDue`/`markRun`;
  persistence round-trip through the settings field.
- Engine/prune tests inject DelayManager with FakeClock; existing behavioral
  expectations are kept.
- Adapter tests: signal aborts `waitFor` mid-poll and the identity retry loop.

## Migration map

| Today | Becomes |
| --- | --- |
| 8 local `sleep` definitions | `timing/primitives.sleep` |
| `rate-governor.nextDelayMs` formula | `jittered(...)` policy |
| `prune-engine.nextDelayMs` formula | `scaled(jittered(...), PRUNE.DELAY_FACTOR)` |
| `followers-page-reader.nextWaitMs` | `uniform(...)` / `fixed(...)` |
| `engine.ts` + `prune-engine.ts` `interruptibleSleep` | `delayManager.wait(key, policy, { signal })` |
| `engine.ts` `pacingSleep` (raw `Math.random`) | `wait('engine:refill-pacing', uniform(...))` with injected rng |
| `connectivity.ts` `setInterval` probe | `scheduleManager.every('connectivity:probe', ...)` |
| `foundation-wiring` auto-prune `setInterval` | `scheduleManager.every('prune:auto-watcher', ...)` |
| `pruneDue()` + in-memory `lastSweepAt` | `scheduleManager.cadence(...)`, sweep persisted via `sweepLastRunAt` |
| `awaitParked` timeout, connectivity request timeout | `withTimeout(...)` |
| Scattered operational constants | `timing/config` namespaces |
| `useEngineStatus`/`usePruneStatus` bodies | `useKeepAlivePoll` |
| `useCountdown` midpoint estimate | pushed `nextActionAt` deadline |
