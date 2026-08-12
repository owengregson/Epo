# Peanut v3 — Engine Runtime Architecture (Fable-authored)

**Date:** 2026-08-12
**Author:** Fable (architecture). Implementation is delegated to Opus 5 against precise task specs derived from this document.
**Status:** Design — supersedes the implicit/ad-hoc orchestration assumptions in the component specs.

---

## 0. Why this document exists

Phase 1 + the Phase-2 components (Scorer, Churn Scheduler, Follow-back Watcher, Scanner, Chain
Controller) were built bottom-up and are each unit-tested. But they were composed reactively, and that
left **two structural defects that no single component test can catch**:

1. **No conductor.** Nothing owns the running system: start/pause/stop, the interruptible loop, the
   order of operations across a target's life, or the transition from one target to the next. The
   pieces exist; the machine that runs them does not.
2. **Pacing lives in the wrong place (a ban risk).** `ChurnScheduler.tick()` executes *every* due
   follow/unfollow in one pass, gated only by the daily ceiling and active-hours — **with no delay
   between actions**. The human inter-action delay (`RateGovernor.nextDelayMs`, 3–7 min + jitter) is
   defined but never applied in a loop. Live, this is a burst → account ban. Request volume and burst
   shape are *the* ban vectors (§5 of the main spec); the runtime must own their pacing.

This document fixes both by designing the **Engine runtime** (the conductor) and relocating timing to
it, and by pinning the **ports-and-adapters** boundary between the pure, tested components and the
live Instagram side.

---

## 1. Architectural principle: pure core, live edges, one conductor

- **Pure core (already built, keep pure):** Scorer, Churn Scheduler (state transitions), Follow-back
  Watcher (detection logic), Scanner (ranking/enqueue), Chain Controller (promotion/fallback),
  KnowledgeStore, governors. These are deterministic given their inputs and injected **ports**. They
  contain **no timing, no browser, no I/O beyond the store**.
- **Live edges (adapters):** thin implementations of the ports that actually touch Instagram via the
  `InstagramAdapter` (Actor/Reader/Sentinel) + `InstagramTab`, each wrapped by the `RequestBudget`.
- **One conductor (`Engine`):** the *only* place that owns wall-clock time — the interruptible loop,
  every human delay, active-hours/ceiling waits, cadences, lifecycle, and Sentinel-triggered halt.

The rule that makes this safe and testable: **timing is a runtime concern, never a component concern.**
A component decides *what* should happen next; the Engine decides *when*, and paces it.

---

## 2. Ports (the seams between core and live)

These interfaces already exist (I specified them into the components). The Engine supplies **real,
adapter-backed implementations**; tests supply fakes. This document makes the full set explicit and
adds the two that are still missing:

- `ChurnActions { follow(username), unfollow(username): Promise<{ok}> }` — **real impl** wraps
  `Sentinel.check` → `RequestBudget.spend` → `Actor.follow/unfollow`, and is where a single action's
  pre-checks live (NOT the delay — that's the Engine).
- `OwnFollowersSource { nextPage(cursor): Promise<{pks, cursor, hasMore}> }` — **real impl** drives the
  tab to our own followers list and parses pages via `Reader.parseFollowersList`, budgeted per page.
- `FollowerAcquisition { acquire(targetUsername, opts): Promise<{observed}> }` — **NEW port.** The
  followers-scraping loop (open dialog → budgeted scroll → intercept `followers/` → `store.observe` +
  edges) currently lives inline in `foundation-wiring.readFollowers`. **Relocate it behind this port**
  so the Scanner/Engine own acquisition and the IPC handler and the Engine share ONE implementation.
- `TargetDiscovery { discover(currentTargetPk): Promise<DiscoveredTarget[]> }` — injected; real impl
  deferred (see §7). Empty result → Chain Controller falls back to own-followers.
- `OwnFollowersTargetSource { pick(): Promise<string|null> }` — fallback next-target chooser.

**Ports & adapters is the load-bearing decision:** it keeps the brain unit-testable forever and
confines every live/timing concern to a small, replaceable rim.

---

## 3. The Engine runtime

A single main-process object. Owns an `AbortController`; every sleep is interruptible via its signal
(no more un-interruptible waits — the exact bug that plagued the old versions).

```
state: 'idle' | 'running' | 'paused' | 'halted'
controls: start(), pause(), resume(), stop()   // stop() aborts and joins the loop cleanly
```

### 3.1 The loop (one iteration = at most one Instagram action)

```
while running:
  if aborted: break
  s = await sentinel.check()
  if s != 'ok': halt('sentinel:'+s); emit alert; break         // hard safety stop
  if !rate.withinActiveHours(): await sleepUntilActiveWindow(); continue
  if rate.atHardCeiling():       await sleepUntilLocalMidnight(); continue

  churn.advanceTimers(now())     // cheap, no IG traffic: pending→unfollow_queued (timeout), followed_back→unfollow_queued (hold)

  if dueForFollowbackSweep(now()):                              // slow cadence, default every 3–4 h
      await followbackWatcher.check(); markSweep(now())

  if queuedCandidates(currentTarget) < LOW_WATER:              // pool running dry
      await acquisition.acquire(currentTargetUsername)          // budgeted scrape (its own internal 2s scroll pacing)
      scanner.planTarget(currentTargetPk)                       // rank + enqueue top-N as 'queued'

  const action = churn.nextDue(now())                           // the single most-due record needing IG traffic, or null
  if action:
      await churn.execute(action)                               // exactly ONE follow/unfollow via ChurnActions (+ record + edge)
      await sleep(rate.nextDelayMs())                           // ← THE human delay, HERE, between actions
  else if targetComplete(currentTarget):                        // no queued candidates AND no active follow-records left
      const next = await chain.advance(currentTargetPk)
      if !next.nextTargetPk: halt('chain-exhausted'); break
      setCurrentTarget(next.nextTargetPk)
  else:
      await sleep(IDLE_MS)                                       // nothing due yet (all waiting on follow-back/hold); short idle
```

**Why one action per iteration:** it makes pacing trivially correct — a real delay sits between every
single Instagram action, and `stop()`/`pause()` can interrupt *between* actions immediately. Bursts
become structurally impossible.

### 3.2 Required refactor of `ChurnScheduler` (precise, minimal)

The current `tick()` conflates timers + executing-all-actions. Split it to match the loop:

- `advanceTimers(now): void` — the no-IG state transitions only (already in `tick`; extract verbatim).
- `nextDue(now): FollowRecord | null` — return the single most-due actionable record: prefer
  `unfollow_queued` (reclaim slots first), then `queued`; respect nothing else (gating is the Engine's
  job before it calls this). Deterministic ordering (e.g. by `unfollowDueAt`/`followedAt` then pk).
- `execute(rec): Promise<void>` — perform that one record's action via `ChurnActions`, then
  `recordAction` + `observeEdge` + state transition + retry/abandon on failure (the per-record body
  already in `tick`, for one record). **No delay inside** — the Engine paces.

Keep the existing tests; add tests for `nextDue` ordering and single-`execute` semantics. This is a
pure restructuring of logic that already exists and is covered.

### 3.3 Interruptible sleep

One helper: `sleep(ms, signal)` that resolves early on abort. `sleepUntilActiveWindow` and
`sleepUntilLocalMidnight` are built on it. Nothing in the Engine ever calls a bare `setTimeout` that
`stop()` can't cut short.

---

## 4. Settings: one source, derived component configs

Right now each component ships its own `*_DEFAULTS`. That fragments the knobs and lets them drift.
Introduce a single **`Settings`** object (persisted as JSON in `userData`, separate from the DB per §6
of the main spec) that is the ONE place a user tunes behavior; the Engine derives each component's
config from it at construction/reload:

```
Settings ⊇ { seed, ratio band+peak+hard bounds, size band, privateBoost,
             maxWaitForFollowbackDays, holdAfterFollowbackDays, maxRetries,
             dailyHardCeiling, dailyOperatingRate, min/maxDelayMinutes, jitterPercent, activeHours,
             requestBudget {maxPerWindow, windowMinutes}, followbackSweepHours,
             dailyPlanSize, lowWaterCandidates, minFollowBackRate, minPoolSize, dryRun }
```

`ScorerConfig`, `ChurnConfig`, `RateGovernorConfig`, `RequestBudgetConfig`, `FollowbackConfig`,
`ScannerConfig`, `ChainConfig` become **projections** of `Settings` (a set of `toXConfig(settings)`
mappers). The component `*_DEFAULTS` remain as the fallback values inside `DEFAULT_SETTINGS`. Live
edits reload the Engine's derived configs without restart.

---

## 5. Control, status, observability

- **Status** is a projection over the store + governors + Engine state (extends the existing
  `FoundationStatus`): engine state, current target + chain position, actionsToday/remaining,
  hard-ceiling flag, request-budget remaining, queued/pending/held/unfollow-due counts (from
  follow-records), last action, next-action ETA, last Sentinel result. Emitted to the renderer on every
  meaningful transition (push), not polled.
- **Halt semantics:** a non-`ok` Sentinel result, an unrecoverable adapter error, or `stop()` moves the
  Engine to `halted`/`idle`, aborts in-flight sleeps, and surfaces a reason. The Engine never silently
  continues past a block.
- **Dry-run:** `Settings.dryRun` makes the real `ChurnActions` log-and-noop the click while still
  recording intent — so the whole loop, pacing, and UI can be exercised without touching the account.

---

## 6. Where the IPC/manual actions fit

`foundation:followOne/unfollowOne/readFollowers` stay as **manual, one-shot** operations for the live
gate and debugging — they reuse the SAME `ChurnActions`/`FollowerAcquisition` implementations the Engine
uses (no duplicated scraping/acting logic). The Engine is the automated driver on top of the same rim.
`readFollowers`'s inline loop is extracted into the `FollowerAcquisition` adapter and both callers use it.

---

## 7. Deliberately deferred (needs live data + a design pass, not guesswork)

- **`TargetDiscovery` (real impl) — the "find the next popular person in the network."** This is the
  one genuinely-unsolved piece. Discovering a hub *within a poached audience* requires signal we don't
  yet collect: who the target's followers themselves follow (their followings), to find high-in-degree
  accounts. Options to design later, informed by live yield data: (a) sample K scanned followers,
  scrape each one's *following* list (budgeted) and rank shared accounts by frequency; (b) use
  Instagram's "similar accounts" surface off the current target. Until then, `discover()` returns empty
  and the chain advances via the **own-followers fallback**, which is fully built. This keeps the chain
  unbroken while we avoid shipping a guessed heuristic.

---

## 8. Implementation plan (for Opus 5, strictly to spec)

Build order (each a precise, testable task; no design latitude):

1. **ChurnScheduler split** — `advanceTimers` / `nextDue` / `execute` per §3.2. Refactor + tests. (Pure.)
2. **Settings + config projections** — `Settings`, `DEFAULT_SETTINGS`, `toXConfig` mappers, JSON
   persistence. (Pure + a small store-adjacent file.)
3. **Ports: real adapter-backed implementations** — `FollowerAcquisition` (extract from
   `readFollowers`), `ChurnActions`, `OwnFollowersSource`, `OwnFollowersTargetSource`. (Live edges; thin.)
4. **Engine runtime** — the loop (§3.1), interruptible sleeps (§3.3), lifecycle, status projection
   (§5), halt semantics. Unit-tested with FAKE ports + `FakeClock` asserting: one action per iteration,
   a delay between actions, ceiling/active-hours waits, follow-back cadence, chain advance on target
   completion, immediate abort on `stop()`, halt on Sentinel block. (Pure core with injected ports —
   fully testable without a browser.)
5. **Wire Engine into `main.ts` + IPC controls** (start/pause/stop/status) and the UI. (Integration.)

Live validation of the whole loop happens at/after the Phase-1 gate, on top of the same verified rim.

---

## 9. What does NOT change

The knowledge graph, governors' math, adapter Reader/Actor/Sentinel, Scorer curve, Follow-back
detection, Scanner ranking, Chain promotion/fallback logic, and the store schema are all sound and
stay as-is. This document adds the conductor and relocates timing; it does not relitigate the pieces.
