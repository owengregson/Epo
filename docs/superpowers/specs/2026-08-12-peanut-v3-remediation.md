# Peanut v3 — Integration Remediation (Fable-authored)

**Date:** 2026-08-12 · **Author:** Fable. Triage of the assembled-system adversarial review.
**Rule:** these are integration defects — the units are correct, the *composition* is not. Each fix
below is precise; implementation delegated (Opus for mechanical, Fable for the enrichment/loop design).

Severity order matters: **R1 (enrichment) is the showstopper — without it the system cannot work AND
hammers Instagram.** R2–R5 are the safety guarantees that don't actually hold under real control flow.

---

## R1 — Candidate enrichment pass (CRITICAL, finding 1). The system's missing organ.

**Problem:** followers-list observations carry no follower/following counts; nothing in the assembled
graph ever fetches candidate profile stats; so `scoreCandidate` returns `no-counts` for every candidate,
`Scanner.planTarget` enqueues 0 forever, and the Engine re-acquires every iteration with no delay.

**Design (new capability):**
1. **New rim port `ProfileEnricher`** (`src/rim/profile-enricher.ts`):
   `interface ProfileEnricher { enrich(usernames: string[]): Promise<number> }`. Impl
   `AdapterBackedProfileEnricher({ tab, reader, store, budget, sentinel, clock })`: for each username
   (cap by an injected batch size), if `budget.canSpend()` and `sentinel.check()==='ok'`, `tab.evaluate`
   a `fetch('/api/v1/users/web_profile_info/?username='+u, {headers:{'x-ig-app-id':'936619743392459'},
   credentials:'include'})` → `reader.parseProfileInfo(body, clock.now())` → `store.observe(obs)` (writes
   `profiled` counts). Light pacing (~1–2s) between fetches. Metering counts each (R2). Returns count
   enriched. (Direct fetch — cheaper than a full nav; the UA fix makes it work.)
2. **Engine gains an enrichment step** before planning. In the pool-low branch (step 7), the sequence
   becomes: `acquire` (if not yet this cycle) → **select the top-N candidate usernames lacking counts,
   `await enricher.enrich(them)`** → `scanner.planTarget(pk)`. Add `enricher: EngineEnricher` to
   `EngineDeps`; the composition root injects the real one. Enrichment is budget/sentinel-gated like any
   IG work and paced.
3. **Scanner marks the rejected** so the pool shrinks (finding 1's livelock): in `planTarget`, after
   scoring, for candidates that are ELIGIBLE-DECIDABLE-BUT-INELIGIBLE (counts known, score 0), call
   `store.setRole(pk, 'skipped')`. Candidates still lacking counts are left for a future enrich pass
   (bounded — see guard).
4. **`candidatePksForTarget` excludes `role='skipped'`** (in addition to follow-record'd + target). Now
   the pool genuinely shrinks as candidates are evaluated, so step 9 (exhausted → advance) is reachable.
5. **Fix the Engine acquisition guard** so it cannot livelock: track `enrichedThisCycle` too; step 7
   runs `acquire` at most once per cycle and `enrich` at most K passes per cycle; if a plan enqueues 0
   AND there are no more *un-enriched* candidates in the pool, the target is exhausted → advance. Never
   re-acquire/enrich a target with no forward progress.
6. **Pace the `'acquired'`/enrich branches** (finding 10): any step that issued IG traffic ends with a
   short jittered sleep (or a per-iteration floor), so no branch hammers.

## R2 — One concurrent loop only (HIGH, finding 2)

`start()` must not let a stale in-flight loop survive a `stop()`+`start()`. Capture the run's
`AbortController` as a generation token; the loop condition checks *that specific* controller's
`signal.aborted` (identity), not the current `this.runAbort`. A restart creates a new token; the old
loop sees its own token aborted and exits. Alternatively refuse `start()` until the prior `start()`
promise resolves. Add a test that interleaves stop→start around an in-flight `stepOnce`.

## R3 — Manual IPC ops are gated and serialized (HIGH, finding 3)

`followOne`/`unfollowOne` must go through the SAME safety as the engine: check `atHardCeiling()` and
write the `action_ledger` row (route them through a shared "perform one action" helper that both the
scheduler's `execute` and the manual path call — ledger + ceiling + edge). And **all tab use is
serialized behind an async mutex** (acquire/enrich/action/own-followers), OR manual ops are refused
while `engine.state==='running'`. Two concurrent `collect()` subscriptions on one `onResponse` stream
corrupt edges (target A ingesting B's pages) — the mutex prevents it.

## R4 — Blocked ≠ failed (HIGH, finding 4)

`ChurnActions.follow/unfollow` returns a discriminated outcome: `{ status: 'ok' | 'failed' | 'blocked' }`
(blocked = budget-exhausted or sentinel-non-ok, BEFORE any click). `ChurnScheduler.execute` treats
`'blocked'` as "leave the record untouched — no ledger write, no retry bump, no state change." The
Engine checks `budget.canSpend()` (and it already checks the sentinel) BEFORE selecting step 8, so a
saturated window parks on waits instead of burning the queue. Consider counting only `result='ok'`
toward the ceiling; at minimum never manufacture `fail` rows for blocks.

## R5 — Lazy own-username resolution (HIGH, finding 5)

Do not freeze a degraded empty follow-back source at build time. Resolve `ownUsername` lazily/retriably:
the `AdapterBackedOwnFollowersSource` (and the target-source) resolve/refresh `ownUsername` on first use
and per sweep via `current_user` (retry until a real IG page is loaded), so a startup race can't
permanently disable follow-back detection and own-followers chaining. Await `tab.goto` before first
resolution where feasible.

## Punch-list (fold in with the above where the file is already open)

- **finding 9** — wrap each `stepOnce` body (incl. the bare `sentinel.check()`) in try/catch: transient
  `evaluate` rejections → treat as `'idle'`/retry, halt only on persistent failure. A transient error
  must not silently drop the loop to idle.
- **finding 14** — `dispose()` awaits the `start()` loop's exit (keep the promise handle) before
  `store.close()`, so a mid-step store call can't throw on a closed DB.
- **finding 6** — `ensureBuilt` memoizes the in-flight build promise (no double build → no leaked store
  / double metering / orphan engine).
- **finding 11** — `AdapterBackedOwnFollowersSource` STORES its parsed observations (`onObservation` →
  `store.observe`) instead of discarding them; it's free data and gives the fallback target-source real
  account rows + counts to rank.
- **finding 8** — either replay the persisted cursor (seed `max_id`) on the next acquire, or drop the
  half-feature; and make `setScrapeCursor` use the injected clock, not `Date.now()`.
- **finding 7** — prefer genuine incremental own-followers paging (one scroll per `nextPage`) so the
  sweep is O(new); a full head-scrape every 4h is not request-minimal. (Acceptable to defer if boxed.)
- **finding 13** — `RateGovernor.withinActiveHours` supports wrapping windows (start > end), or Settings
  validates against them.
- **finding 12** — dry-run must NOT write a real `ok` ledger row + active edge (pollutes yield after
  dry-run ends); record intent separately or skip the edge/ledger under dry-run.
- **finding 15** — remove dead `PkRegistry`; comment the `news/inbox`/graphql metering intent.

## Execution grouping (post-UI-merge, to avoid touching foundation-wiring while the UI agent holds it)

- **G-A (Fable): R1 core** — new `ProfileEnricher`, Engine enrich-step + guard + pacing (R1.2/5/6, f10),
  Scanner skip-marking (R1.3), `candidatePksForTarget` skip-exclusion (R1.4). The judgment-heavy keystone.
- **G-B (Opus): R4** — ChurnActions discriminated outcome + scheduler leave-untouched + engine canSpend
  pre-check.
- **G-C (Opus): R2 + f9 + f14** — engine loop generation token, per-step catch, dispose await.
- **G-D (Opus): rim/store punch-list** — f11 (store sweep observations), f8 (cursor clock/replay-or-drop),
  f7 (incremental sweep), f6 (build memoize), f13 (overnight hours), f12 (dry-run), f15 (dead code).
- **G-E (Opus): R3 + R5** — manual-op gating+ledger via shared helper, tab mutex, lazy username. (Touches
  foundation-wiring + rim — do LAST, after UI merges.)

G-A and the engine-touching parts of G-B/G-C all edit `engine.ts` — sequence them (A → B → C) rather
than parallel, or assign all engine.ts edits to one agent. Rim/store/scheduler edits can parallelize.
