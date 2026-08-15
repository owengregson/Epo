# Peanut v3 — Overnight Build Handoff

> **2026-08-15 (LIVE unfollow debug — verdict) —** Two live labs against real
> Instagram (scratchpad `unfollow-lab*.ts` → `dist/lab/`, using the user's
> session): 6/6 unfollows succeeded, 5 of them the EXACT usernames that failed
> in the 23:55–00:10 run — including a byte-for-byte production-path run
> (`churnActions.unfollow` → interactor Actor, real Sentinel, default polls).
> DOM dumps confirm the adapter's model: menu = `[role=dialog]`, item text
> exactly "Unfollow" (span in a `div[role=button]`), confirm locatable 1.5 s
> post-click, header flips to "Follow" ≤2 s after confirm. Ledger forensics
> also showed the failed run was WORSE than the log read: only the FIRST
> unfollow succeeded; the "success" log lines print pre-verification and every
> later verification failed too. Verdict: Instagram was rejecting that run's
> unfollow mutations server-side (SPA reverts the button; menu intermittently
> not opening) — an account-level unfollow throttle, since lifted. Hardening
> added: `PRUNE_CONSECUTIVE_FAIL_HALT` (4 straight failed unfollows →
> `halt('actions-failing')`, remainder stays runnable) alongside the earlier
> block-probe / blocked-mapping. `InstagramTab.captureScreenshot()` added for
> future triage. Suite: 552 tests, tsc + lint + build clean.

> **2026-08-15 (block interstitials ≠ drift) —** A live prune run showed
> PERFECT alternation: every unfollow after a successful one threw
> `AdapterStaleError` on the confirm control — the signature of Instagram
> replacing the unfollow menu with a block interstitial ("Try Again Later")
> on every second action, which the Actor could not tell apart from selector
> drift (each one burned a candidate as `fail`). Now: when an expected control
> is missing or a verified click fails to change state, the Actor PROBES the
> screen (the Sentinel's dialog-text probe) — a block-signature match throws
> the new `ActionBlockedError`, which churn-actions maps to `'blocked'`
> (record/candidate untouched; prune parks 30 s and retries, halting only when
> persistent; growth leaves the record for later). Non-matching dialog text is
> warn-logged (200-char head) so any future stale is diagnosable, then drift
> still escalates loud. Robustness alongside: the unfollow-confirm matcher is
> now a PREFIX match (`\b` — "Unfollow @name" variants), and both confirm
> scripts search ALL `[role=dialog]`/`[role=alertdialog]` scopes instead of
> only the first. Suite: 551 tests, tsc + lint + build clean.

> **2026-08-14 (§3 durable schedules + prune runnability) —** New
> `docs/PRINCIPLES.md` §3: configured cadences persist last-run and OVERDUE
> WORK RUNS FIRST at startup. Follow-back check already qualified
> (`sweepLastRunAt` + engine step order runs it before actions); the
> scheduled-prune watcher now evaluates `immediate: true` at launch instead of
> one interval later. **Prune runnability bugs** (user report: scanned ~10 min
> earlier → empty list, grayed Run, "Last run" seemingly stuck): (1) a STOPPED
> or halted run silently dropped its unvisited remainder in memory — every
> early exit now hands it back runnable, like truncation; (2) `SCAN_FRESH_MS`
> 15 min → 6 h, made safe by a new LIVE-GRAPH GUARD in the run loop (a
> candidate whose follows-us edge appeared after the scan is skipped, never
> unfollowed); (3) the candidates list now populates from the saved census
> whenever unvisited rows exist, even when expired for running (Run stays
> gated on freshness); (4) `PruneStatus.scanAt` + a "Last scan" row (with an
> "expired — scan again to run" note) so the state is legible. Suite: 547
> tests, tsc + lint + build clean.

> **2026-08-14 (live UI mirror + follow requests + prune fixes) —**
> **§2 "The UI mirrors the graph, live"** (docs/PRINCIPLES.md): the store now
> fires `onMutation` on every write; the Foundation coalesces bursts
> (`POLL.GRAPH_PUSH_THROTTLE_MS`) into fresh dual-status pushes, so counts tick
> DURING scans/sweeps. `PruneStatus.graph` carries live
> `store.relationshipCounts()` — "Not following back" scrolls while the scan
> walks. **Follow requests** (private-account oversight): the notifications
> pass now also clicks the drawer's "Follow requests" entry, observes
> `friendships/pending/` (rows stored as they parse), and auto-accepts via
> real Confirm clicks — capped (`RIM.REQUEST_ACCEPT_CAP`), paced, each accept
> VERIFIED by the head row changing; accepted requesters get follows-us edges
> + `followed_back` records. Setting `autoAcceptFollowRequests` (default on,
> Cadence card toggle). Drawer etiquette: clicks the "Follows" filter on open,
> scrolls the list up to 2 rounds for older pages (merged/deduped), and leaves
> via the X control (bell-toggle fallback). **Prune fixes**: candidates list
> auto-populates from the persisted snapshot on launch (new
> `prune:candidates` IPC); scan-end counts carry the GHOST BUFFER (scraped +
> deactivated ghosts = the number Instagram displays) in status, snapshot, and
> scan result. Suite: 545 tests, tsc + lint + build clean. NOTE: the whole
> notifications-drawer interaction set (bell, Follows filter, requests entry,
> Confirm buttons, X close) is designed from the live web UI but not yet
> live-verified — watch the first hourly check's log lines.

> **2026-08-14 (facts stream — mandated principle) —** New `docs/PRINCIPLES.md`
> §1 ("facts stream; verdicts wait for completeness") + repo `CLAUDE.md`
> binding future sessions to it: every observed fact commits to the store the
> moment it is parsed; only absence-based verdicts (lost followers, candidate
> sets, baselines) may gate on a verified-complete walk. Violations fixed:
> prune-scan relationship edges used to land only at census end (an aborted
> scan lost every edge it saw) — both own-list sources now write each row's
> profile + edge per row (`ingestRow`: followers → follows-us edge; following →
> `reconcileOwnFollow`, healing drift on sight); `ingestScanCensus`'s additive
> half is now an idempotent re-confirmation, its absence half unchanged. The
> seed check stores its paid-for profile observation; notification follow
> events store the username the feed carried. Streaming contracts documented on
> the `onObservation` ports. Suite: 538 tests, tsc + lint + build clean.

> **2026-08-14 (v4 follow-back + UI truth) —** Follow-back detection now reads
> the NOTIFICATIONS feed instead of paging the whole own-followers list: the
> Actor clicks the nav bell (`locateNotificationsLinkScript`, aria-label
> matched), the drawer's `/api/v1/news/inbox/` response is observed via CDP and
> parsed (`extractActivityFeed`: `story_type` 101 OR "started following you"
> text — either signal admits, so one drifting doesn't blind us), and pending
> records seen in the feed transition to `followed_back` with the hold anchored
> at the EVENT time (clamped to ≥ our own follow). One click + one request per
> check → default cadence is now HOURLY (`followbackSweepHours: 1`; the 1h chip
> exists in Cadence). New `src/rim/follow-notifications.ts`; the watcher's
> paged sweep, head-watermark meta, and `maxPagesPerCheck` are removed
> (`AdapterBackedOwnFollowersSource` now serves only the prune census).
> Queue-order truth: records queued before migration 7 carry NULL scores
> forever, collapsing both `nextDue` and the queue display to pk order —
> `Scanner.rescoreQueued()` backfills them at engine start (the live DB's 29
> legacy records all have counts, so they rank fully). Chain UI: the seed node
> no longer hardcodes "exhausted & chained" — labels are status-truthful
> (current → `followed N`). Suite: 535 tests, tsc + lint + build clean.

> **2026-08-14 (latest) — Background-run survival.** After CDP input dispatch,
> actions STILL failed in the background. An instrumented Electron lab
> (BaseWindow + offset WebContentsView, per-scenario measurement) proved why:
> stock Chromium marks a blurred/occluded/hidden/minimized window's page
> `visibilityState: hidden`, stops rAF entirely (0 vs 180 frames/1.5 s), and
> clamps timers ~15× (→ ~1/min after 5 min) — CDP clicks still ARRIVE
> (trusted), but Instagram's SPA cannot hydrate or advance its UI, so actions
> time out. Fix (re-measured: all background states now identical to
> foreground): `disable-renderer-backgrounding` +
> `disable-background-timer-throttling` + `disable-backgrounding-occluded-
> windows` switches in `main.ts`/`livetest-main.ts`, `backgroundThrottling:
> false` on the IG tab, `Emulation.setFocusEmulationEnabled` at debugger
> attach, and a `powerSaveBlocker('prevent-app-suspension')` (App Nap would
> throttle the MAIN process timers pacing the motion profile; also keeps the
> system awake with the display off). New `InstagramTab.probeInput()` runs on
> an `actions-failing` halt and logs decisively whether input reaches the page.

> **2026-08-14 (later) — Input pipeline: CDP dispatch.** The 2026-08-13
> overnight run failed every single click while reporting `clicked: true`:
> `webContents.sendInputEvent` (the Interactor's transport) only works while
> the host window is FOCUSED — an unattended background run drops everything
> silently. The tab now dispatches all pointer input via CDP
> `Input.dispatchMouseEvent` on its already-attached debugger
> (`src/interaction/cdp-input.ts` converts the Electron-shaped driver events;
> wheel deltas negate back to DOM semantics). CDP injection is the
> Puppeteer/Playwright mechanism: trusted events, focus/occlusion-independent.
> Fallout fixes from the same run: a failed own-followers sweep now THROWS
> instead of resolving empty (an open-failed scrape had stamped the followers
> BASELINE off a read of nothing); and the engine halts with `actions-failing`
> after 8 consecutive failed actions across records (systemic-breakage breaker
> — that night burned 17 candidates + 71 ledger rows clicking into the void).
> `EngineStatus.haltReason` now travels to the UI (LiveStatusCard alert). The
> live DB was repaired by hand: baseline meta cleared, the 17 never-followed
> abandoned records re-queued, the 71 phantom `fail` ledger rows deleted
> (backup at `epo.db.bak-2026-08-14`). Suite: 527 tests, tsc + lint clean.

> **2026-08-14 — Full-codebase remediation pass.** A four-way adversarial audit
> (engine / rim+adapter / store+governors / wiring+renderer) surfaced ~55 real
> defects; all substantive ones are fixed. Headlines:
> **Action integrity** — the Actor's document-wide fallback selector is gone
> (it could click ANOTHER account's Follow button mid-hydration and "verify"
> against it); `outgoing_request` is now parsed, so pending requests to private
> accounts are no longer destroyed by the reconciler; `friendships/show` error
> bodies are SHAPE_MISMATCH, not "no relationship"; a user Stop now surfaces as
> `ActionAbortedError` → `blocked` (record untouched) instead of burning
> retries; interactor clicks guard against degenerate rects.
> **Census integrity** — prune's list walks carry a completeness verdict end to
> end and a truncated census FAILS the scan instead of driving unfollows; a
> complete census is authoritative (records lost followers — the net-growth
> chart's loss side is real now); prune excludes chain targets, retries blocked
> candidates, stops at the active-hours edge, and a cap-truncated run keeps its
> remainder runnable.
> **Effectiveness** — the operating-rate knob actually gates the loop (ceiling
> counts BOTH ledgers); enrichment failure no longer burns targets/chains
> (walled cycles back off; dead accounts are marked `enrich_failed_at`);
> follow-back sweeps use a positional head watermark plus a zero-request
> store pass (a prune census no longer blinds them); `TargetDiscovery` is live
> (store-backed hubs), and the own-followers fallback enriches before ranking.
> **Wiring/UI** — prune/manual ops wait for a genuinely parked engine (pause ≠
> quiesced); teardown drains in-flight manual ops before closing the DB;
> settings autosave sends only edited keys (no more whole-object clobbering of
> prune/backend fields); restart-from-seed is a real backend op; control
> refusals surface as toasts; settings are sanitized on every load/update.
> Suite: 517 tests, tsc + biome clean.

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

**LIVE GATE PASSED (2026-08-12).** `npm run livetest` returned ALL PASS on a real account and a real
churn target: identity, acquire (multi-page scroll), enrich (real `web_profile_info` counts), score+plan
(correct sweet-spot ranking), follow (post-click verified), follow-back check, unfollow (net-zero), and
Sentinel — every mechanical action the app performs is validated against live Instagram. Three live
selector fixes were needed and made along the way (all in `field-notes.ts`/`actor.ts`, evidence-driven
via `npm run inspect`): username resolution via the profile link, opening the followers modal by
text-matching the `<a href="#">` stat, and treating "no scroll container" as non-fatal. The system is
ready to run for real (§5b).

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
  **one Instagram action per iteration with a paced delay between**, enforces active-hours/ceiling/
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

**Quickest first check — the live action smoke test.** Before running the full app, validate every real
Instagram action in a couple of minutes (paced + bounded, safe for a real account):
```bash
PEANUT_TEST_FOLLOW=<a_throwaway_or_friend_account> npm run livetest    # add PEANUT_TEST_DRY=1 for no real clicks
```
A window opens; log in; it then runs Identity → Acquire → Enrich → Score+Plan → Follow → Follow-back
check → Unfollow → Sentinel, each with jittered paced delays (~30–75s between the follow and unfollow),
exactly one follow+unfollow (net-zero), a real ~300/hr budget, and a Sentinel check before each action
that aborts on any block. It prints a `STEP | STATUS | DETAIL` table + total actions/requests. This is
the fastest way to confirm the live adapter works (esp. the enrichment fetch + button selectors) without
waiting for engine cycles. Uses a throwaway temp DB. If a step FAILs, that's the targeted thing to fix.

**§5b — running the engine for real (recommended first-run posture).** After `npm run livetest` is
green, launch `npm run dev`, set your seed + tune Settings, and Start. For the FIRST real run, be
conservative: turn **dry-run ON** in Settings for one session to watch the loop pace and pick candidates
without any real clicks; then turn dry-run off with a **low operating rate** (e.g. 10–15/day) and watch
the first few real follows land ~3–7 min apart. Confirm the Activity log shows one action per interval,
the Rate panel decrements, and the Sentinel stays `ok`. Ramp up only once you've seen a full
follow→follow-back→hold→unfollow cycle behave.

**The manual gate (optional, superseded by §5 livetest)** — launch `npm run dev`, then in the app:
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
