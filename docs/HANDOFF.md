# Peanut v3 — Overnight Build Handoff

**As of:** 2026-08-12, overnight session. **Branch:** `v3` (pushed to `origin/v3`).
**Status:** The whole system is **assembled, remediated, and green** — **216 unit tests**, clean
`tsc`/`eslint`/`build`. A Fable adversarial review of the *assembled* system found CRITICAL integration
defects (each part was unit-correct; the composition was not — most importantly the candidate-enrichment
pass was missing, so the engine could enqueue nothing and would **livelock hammering Instagram**). **All
of them are now fixed and re-verified** (see `docs/superpowers/specs/2026-08-12-peanut-v3-remediation.md`
and the `fix(remediation): ...` commits): enrichment is wired, the refill loop is provably livelock-safe
(bounded cycle → exhaust → advance), actions are paced one-per-iteration, budget/sentinel refusals no
longer burn the queue, manual ops are ceiling-gated + refused while the engine runs, and the loop is
concurrency-safe and interruptible.

**The one thing left that needs you is the live Instagram gate (§5)** — a real login → read → follow →
unfollow → run-the-engine to validate the adapter against live Instagram. Everything up to it was built
and verified autonomously; it's the only step that can't be done without a real account.

---

## 1. What Peanut is

A personal Instagram growth engine (Electron desktop app) that runs a **self-chaining follow/unfollow
strategy**: pick a target account, poach its followers (the "numbers users" most likely to follow
back — ranked by the ratio sweet spot), follow them, wait for the follow-back, hold, then unfollow —
netting followers. When a target's viable candidates are exhausted, it **promotes the best discovered
account to the next target and chains onward**, ~indefinitely, with an own-followers fallback so the
chain never dead-ends.

## 2. The strategy, precisely

- **Ratio sweet spot** (`r = following ÷ followers`): eligible band `0.90–1.50`, peak plateau `1.0–1.2`,
  excluded past `0.5`/`3.0`. Private accounts get a score boost. Verified / out-of-size-band excluded.
- **Lifecycle:** `queued → followed (pending follow-back) → followed-back (hold) → unfollow → done`,
  or timeout-reclaim if no follow-back. Timers configurable (default 4-day wait, 2-day hold).
- **Follow-back detection is request-minimal:** `show_many` lacks `followed_by`, so detection reads our
  OWN followers incrementally (new followers appear at top; O(new), not O(all)).
- **Chaining:** yield stats (follow-back rate, pool size, mutual overlap) pick the next target; a
  minimum-yield gate decides promote-discovered vs own-followers fallback.

## 3. Architecture (Fable-designed, layered)

- **Knowledge graph** (`src/store/`) — SQLite (`better-sqlite3`), event-sourced: every Instagram fact is
  an `observe()`d observation → projected current state (per-field provenance/confidence merge, identity
  by numeric `pk`). Directed edges for follows/follow-backs. Durable action ledger + request log. The
  SINGLE module allowed to touch SQL (lint-enforced).
- **Governors** (`src/governors/`) — durable daily action cap + in-code hard ceiling (read from the
  ledger, survives restart), global request budget (counts *real* responses), injectable clock.
- **Instagram Adapter** (`src/adapter/`) — the single versioned surface: `Reader` (parses intercepted
  JSON via `field-notes.ts`, the live-captured source of truth), `Actor` (the ONLY DOM-touching code —
  text-matched buttons, hydration waits, post-click verification, loud `AdapterStaleError` on drift),
  `Sentinel` (block/challenge/logout detection), `tab.ts` (embedded `WebContentsView` on a persistent
  session, CDP response observer, real Chrome UA).
- **Rim** (`src/rim/`) — adapter-backed ports: `FollowerAcquisition` (budgeted scrape + pk-from-URL edge
  back-fill + cursor persistence), `ChurnActions` (budget/sentinel-gated actions), own-followers
  source/target-source, request metering.
- **Engine** (`src/engine/`) — the pure components (Scorer, Churn Scheduler, Follow-back Watcher,
  Scanner, Chain Controller) + the **conductor** (`engine.ts`): an interruptible loop that does at most
  **one Instagram action per iteration with a human delay between**, enforces active-hours/ceiling/
  budget/sentinel gates, runs the follow-back sweep on cadence, and advances the chain. Burst-prevention
  is proven by an event-ordered test.
- **Composition + UI** (`src/main/`, `src/renderer/`) — the composition root wires the graph and runs
  the Engine behind IPC controls (start/pause/stop/status); the renderer is the dashboard beside the
  live Instagram tab.

## 4. Running it

```bash
npm install          # first time (native better-sqlite3 build)
npm run dev          # builds + launches Electron (auto-signs the Electron binary for macOS 26 Gatekeeper)
npm test             # 188 unit tests
```

Notes: the app auto ad-hoc-signs the Electron runtime on launch (macOS 26 XProtect was trashing the old
unsigned Electron 31; we're on Electron 43 + a `fix:electron` prelaunch step). `better-sqlite3` is
rebuilt for the Electron ABI on `dev`/`start` and for Node on `test` — the scripts handle the toggle.

## 5. THE LIVE GATE (needs you — the only blocker)

Launch `npm run dev`, then in the app:
1. **Login** — click Login; log into Instagram in the right-hand tab (2FA fine). Quit + relaunch to
   confirm the session persists. Status should flip to `loggedIn` and the dependency graph builds
   (log: "dependency graph built" with your `ownPk`/`ownUsername`).
2. **Read followers** — enter a small target, Read Followers. Confirm `observed > 0` and (in
   `<userData>/peanut.db`) `accounts` rows appear and `edges` to the target are written. No "useragent
   mismatch" warnings (the UA fix).
3. **Follow one / Unfollow one** — on a test username. Confirm the real action in the tab, an
   `action_ledger` row (`ok`), and the edge added/removed. The Actor verifies the post-click state.
4. **Start engine** — watch it do one action at a time with a 3–7 min gap; Pause/Stop interrupt
   instantly; the dashboard status updates live.
5. **Safety** — point the tab at a `/challenge/` or logged-out URL and confirm actions refuse with a
   sentinel reason and the loop halts.

If anything fails live (most likely: a selector needs adjusting for the current IG DOM, or
`current_user` username resolution), capture the terminal log + what you saw and it's a targeted fix —
the adapter is the one versioned place to update.

## 6. Deliberately deferred (not bugs — design choices)

- **`TargetDiscovery` real implementation** — finding a "popular hub" *within* a poached network needs
  signal we don't yet collect (who the followers themselves follow). Until designed, discovery returns
  empty and the chain advances via the fully-built **own-followers fallback**. See engine-arch §7.
- **Live validation of the churn loop end-to-end** — unit-proven; needs a real run (part of §5).
- **Dashboard visual polish** — built to the metallic-minimal design; needs your eyes in the running app.
- **Two known efficiency residuals** (correctness is fine; deferred as optimizations, tracked in the
  remediation doc): the follow-back sweep does a bounded head-scrape rather than a true one-scroll-per-
  page increment (finding 7), and the persisted scrape cursor isn't yet replayed to skip already-read
  pages (finding 8). Both just mean *slightly* more requests than optimal, well within the budget.
- **Manual follow/unfollow ledger identity** — the manual live-gate buttons key the ledger by username
  (the store has no username→pk reverse index yet); the durable ceiling still counts them, so the safety
  guarantee holds. The engine's own actions use real pks. A `manualActionPk()` seam is left for later.

## 7. Branches & docs

- `v2` (GitHub) — your prior uncommitted TypeScript/Electron WIP, snapshotted and **backdated to
  2026-02-17** (when you actually did it), preserved for history.
- `v3` (GitHub) — this rebuild. Merge to `main` when the live gate passes.
- Design docs (all in `docs/superpowers/specs/`): `...-v3-design.md` (product + knowledge graph),
  `...-v3-engine-architecture.md` (the conductor + review-fix requirements), `...-v3-ui.md` (dashboard).
- `docs/adapter/README.md` + the Task E capture harness (`npm run capture`) — how the live IG shapes
  were captured; re-run it if Instagram changes and the adapter needs re-verification.

## 8. How it was built

Fable dictated the architecture (the specs above) and orchestrated; implementation was delegated to
subagents — Opus for thin precise-spec work, Fable for the judgment-heavy keystones (Engine conductor,
adversarial reviews). Two adversarial reviews were run and their findings folded back into the
architecture (the hydration waits, pk-from-URL edges, budget-from-real-responses, one-action-per-tick
pacing all came from that). Isolated git worktrees kept parallel subagents from colliding.
