# Peanut v3 — Ground-Up Redesign

**Date:** 2026-08-12
**Status:** Design approved (pending final spec review)
**Supersedes:** the uncommitted v2 TypeScript rewrite and all committed JS versions

---

## 1. Goal

Rebuild Peanut as a reliable, safe, observable Instagram growth engine that runs a
**self-chaining follow/unfollow strategy** across an ever-advancing sequence of targets,
selecting candidates intelligently and interacting with Instagram in a **request-minimal**
way that avoids rate-limit bans.

The product thesis (targeted follow → follow-back → unfollow churn) is unchanged from every
prior version. The engineering thesis is new and attacks the three things that killed every
prior attempt:

1. **Never verified against real Instagram** → live verification is a mandatory, early build step.
2. **Invisible, out-of-process browser** → Instagram runs as a visible tab *inside* the app.
3. **Fragile DOM selectors + silent failure + in-memory safety** → a single versioned Instagram
   adapter reading the data layer, loud health-checks, durable ledgers, and a request budget governor.

---

## 2. Why prior attempts failed (context that shapes this design)

Established by full history + code audit:

- **`main` has not booted since Jan 2026.** Commit `fa04934` introduced a literal JS syntax error
  in `src/instagram.js` (`/^\\/[^/]+\\/$/`). Every commit after it — including the entire "Redesign
  Control Center" PR — was built on a codebase that cannot start. The app has never run end-to-end.
- Old code calls `page.waitForTimeout()`, removed in its own pinned Puppeteer v22.
- The uncommitted v2 compiles but: its resume cursor is decorative (never replayed); the rate-limit
  daily cap is in-memory only (resets on restart); the scheduler silently drops due unfollows; `stop()`
  races the tick loop into null-pointer crashes; there is zero detection of "Action Blocked"/challenge
  screens; the follow button is found via `header section button` (usually the wrong button) so follows
  fail quietly on nearly every user.
- The plan's own mandated "verify selectors against live Instagram with DevTools MCP" step was skipped.

**Design consequence:** correctness, safety, and Instagram-interaction must be first-class, durable,
and verified — not bolted on.

---

## 3. Product strategy — the self-chaining growth engine

### 3.1 Two account archetypes

- **Numbers user** — a growth-minded account likely to reciprocate a follow. Qualified by the ratio
  sweet spot (§3.2) plus guards. These are **churned**: follow → wait for follow-back → hold → unfollow.
- **Target ("popular person")** — an account with a large pool of *numbers users* among its followers.
  These are **poached** (their followers are harvested and churned). Targets are never churned.

### 3.2 Candidate scoring — the ratio sweet spot

Let **r = following ÷ followers**.

- **Eligible band: `0.90 ≤ r ≤ 1.50`.** This is the zone of highest follow-back likelihood.
- **Peak scoring on the `1.0–1.2` plateau (~1.1 optimum).** Score falls off toward both band edges.
- **Soft edges:** just outside the band → allowed but heavily penalized.
- **Hard exclude:** far outside (defaults: `r > 3.0` or `r < 0.5`) → rejected on ratio alone.
- All bounds (`bandLow=0.90`, `bandHigh=1.50`, `peakLow=1.0`, `peakHigh=1.2`, `hardLow=0.5`,
  `hardHigh=3.0`) are tunable in Settings.

**Scoring function shape:** a plateau-peaked curve — full score across `[peakLow, peakHigh]`,
smoothly decaying to the band edges, steeply penalized in the soft-edge zone, zero (excluded)
past the hard bounds.

### 3.3 Additional candidate qualification (hard/soft filters)

- **Private accounts:** strong score **boost**, not a hard requirement.
- **Size band:** follower count within `[minFollowers, maxFollowers]` (default `[50, 20000]`) — skip
  near-zero (dead/bot) and skip huge/celebrity (won't reciprocate).
- **Hard skips:** verified accounts, accounts already followed / previously churned, self, accounts
  currently in any active FollowRecord state, obvious inactivity signal when available.
- **Ranking within the eligible pool:** ratio score is primary; private boost, activity recency, and
  size-fit are secondary weights (composite, tunable).

### 3.4 The churn lifecycle (per followed user)

State machine, all timers configurable:

```
QUEUED
  → (action budget available) FOLLOWED / pending-followback
      → (follow-back detected)  FOLLOWED_BACK → hold timer starts
          → (hold elapsed)      UNFOLLOW_QUEUED → UNFOLLOWED  [SUCCESS: net +1 follower likely retained]
      → (max-wait elapsed, no follow-back) UNFOLLOW_QUEUED → UNFOLLOWED  [slot reclaimed]
  → (action fails) retry with backoff, capped; then ABANDONED
```

Defaults: `maxWaitForFollowbackDays = 4`, `holdAfterFollowbackDays = 2`, retry backoff exponential
(10m → 30m → 2h, max 3 tries).

### 3.5 Chaining & target discovery

1. **Seed:** user provides **one** initial account (a friend / warm connection) as the first target.
2. **Poach + observe:** while poaching a target's followers, Peanut (a) churns numbers users, and
   (b) watches the network for the most promising **next target** — a "popular person" surfacing in
   that audience — and accumulates **yield statistics** for the run.
3. **Promote:** the best discovered popular person that clears the **minimum-yield criteria** becomes
   the **#1 next target**. It is **followed and retained** (promoted candidate → target, never churned).
4. **Advance:** the next batch runs against that new target. Repeat, chaining ~indefinitely.
5. **Fallback:** if no discovered candidate clears the minimum-yield bar, Peanut selects the next target
   from **your own account's follower list**, so the chain never dead-ends.

**Yield statistics gathered per poaching session** (drive both next-target selection and the
fallback decision):
- follow-back **rate** (% of follows that reciprocated)
- follow-back **latency** (median time to reciprocate)
- qualifying **candidate-pool size** available from the target
- existing **mutual overlap** (how many you already follow / are followed by)
- projected yield of each observed popular person

**Minimum-yield criteria (tunable defaults):** discovered target must project
`followBackRate ≥ 0.15` **and** `qualifyingPoolSize ≥ 300`; otherwise fall back to own followers.

---

## 4. System architecture

### 4.1 Processes & surfaces

Single Electron app:
- **Main process** owns all engine logic and durable state.
- **Embedded Instagram tab** — a `WebContentsView` hosting `instagram.com` inside the app window,
  using a **persistent partitioned `session`** (cookies survive restarts). This *is* the automation
  surface: visible, your real session, driven via CDP / `webContents.executeJavaScript`. No Puppeteer,
  no second Chromium, no headless invisibility.
- **Dashboard renderer** — the UI view (§8), separate from the IG tab.

### 4.2 The Instagram Adapter (single point of contact with Instagram)

Everything Instagram-specific lives behind one **versioned** module. An IG redesign is a one-file fix.

- **Reader** — attaches to the tab's network layer; parses Instagram's **JSON/GraphQL responses**
  (follower lists, `friendships/show_many`, profile info, activity feed, search). Structure-stable.
  Also issues *its own* read-only API calls from within the tab's page context (native session,
  csrf/app-id headers) when a targeted read is cheaper than navigation — e.g. batched relationship checks.
- **Actor** — the **only** code that touches the DOM: click follow/unfollow, open dialogs, scroll.
  Thin, centralized. Every selector is paired with a **health-check**; a stale selector throws a loud,
  specific `AdapterStaleError(component, selector)` — never a silent failure.
- **Sentinel** — watches for "Action Blocked" / "Try Again Later", checkpoint/challenge redirects,
  login expiry, and rate warnings. On detection it **halts the engine** and raises a user alert.

**Actions via DOM, reads via API.** Follow/unfollow are performed as human-like DOM clicks (lower
ban risk, looks native). Detection/enrichment reads use intercepted or directly-issued API calls
(cheap, precise).

### 4.3 Engine services (small, single-purpose)

- **Scanner** — poaches a target: harvests followers (Reader), applies cheap pre-filters, spots
  candidate next-targets.
- **Scorer** — ratio sweet-spot scoring (§3.2) + composite ranking; projects target yields.
- **Churn Scheduler** — drives each FollowRecord through the §3.4 state machine.
- **Follow-back Watcher** — request-minimal reciprocation detection (§5).
- **Chain Controller** — runs yield analysis, promotes next target or triggers own-followers fallback.
- **Rate Governor / Request Budget** — §5. Durable action ledger; hard ceiling enforced in code;
  human delays, jitter, active-hours; global request budget; real `AbortSignal` for instant pause/stop.

### 4.4 Data flow

```
Adapter.Reader ─▶ Scanner ─▶ Scorer ─▶ [state] ─▶ Churn Scheduler ─▶ Adapter.Actor
                                                          │
                    Rate Governor gates every action & read (budget + ceiling + delays)
                                                          │
                    Action Ledger persists ─▶ UI observes via events
Sentinel can halt the pipeline at any point.
Follow-back Watcher ─▶ updates FollowRecord state ─▶ Churn Scheduler.
Chain Controller ─▶ selects next Target ─▶ Scanner.
```

---

## 5. Request-minimal Instagram interaction (the efficiency pillar)

Request **volume** is the primary ban vector. Budgeting reads and writes is a first-class design goal.

### 5.1 Follow-back detection (must NOT diff the full followers list)

- **Primary — batched relationship checks:** `friendships/show_many` returns `following`/`followed_by`
  for **~100–200 user IDs per request**. All pending follows are checked in a few batched calls on a
  **slow cadence** (default every 3–4 h), not per-user. 1,000 pending ≈ 5–10 requests.
- **Free signals — piggyback the activity/notifications feed** (`news/inbox`) whenever the tab is there;
  "started following you" events cost zero extra requests.
- **Backstop — incremental head-read:** own followers return most-recent-first; read only the first
  page and **stop at the first already-known follower**. Cost O(new), never O(all).

### 5.2 General budget discipline

- **Harvest, don't re-fetch:** follower-list JSON already intercepted while poaching carries `is_private`,
  `is_verified`, ids, and often counts — extract everything from responses already being made.
- **Spend profile-visits only where they pay off:** ratio requires follower/following counts (a profile
  read). Cheap pre-filters run first; Peanut fetches full stats only for the **top slice** needed to fill
  the day's quota + a small buffer.
- **Cache with TTL:** recently-seen account stats are cached (default 7-day TTL) — no re-visiting.
- **Real pagination cursors:** persist and replay list cursors so lists are never re-scrolled from the top.
- **One global Request Budget:** a token-bucket governs *all* Instagram requests (reads + writes) per
  rolling window, with jitter, on top of the per-day action ceiling. Reads count too.

---

## 6. Data model (durable, atomic, versioned)

All state persisted under Electron `userData`, written **atomically** (temp-file + rename) with a
`schemaVersion`, so a truncated file can never brick startup.

- **Account** — every account seen: `username`, `id`, `followers`, `following`, `ratio`, `isPrivate`,
  `isVerified`, `activitySignal`, `role` (`candidate | following | target | retained-target | skipped`),
  `statsFetchedAt`, `source`.
- **FollowRecord** — per followed user: current lifecycle state (§3.4), `followedAt`, `followedBackAt`,
  `holdUntil`, `unfollowDueAt`, `retryCount`, `targetId`.
- **Target** — `account ref`, `source` (`seed | discovered | own-followers`), accumulated yield stats,
  `status` (`active | exhausted | retained`), `chainIndex`.
- **ActionLedger** — append-only record of every follow/unfollow with timestamp + result. **Source of
  truth for rate limiting** (survives restart — fixes the in-memory-cap bug).
- **RequestLog** — rolling window of Instagram requests for the budget governor.
- **Chain** — ordered target lineage; inspectable and resumable.
- **Settings** — all tunables (§7).

---

## 7. Settings / configuration

Grouped, all with safe defaults and **live** validation warnings (computed as you type):

- **Targeting:** seed account; ratio band (`bandLow/High`, `peakLow/High`, `hardLow/High`); size band
  (`minFollowers/maxFollowers`); private boost weight; composite weights.
- **Lifecycle timers:** `maxWaitForFollowbackDays` (4), `holdAfterFollowbackDays` (2), retry backoff.
- **Chaining:** minimum-yield criteria (`minFollowBackRate` 0.15, `minPoolSize` 300); own-followers
  fallback toggle.
- **Safety:** `dailyHardCeiling` (50, enforced in code), `dailyOperatingRate` (25), min/max action delay,
  jitter %, active-hours, request-budget rate.
- **Follow-back detection:** batch cadence, batch size.
- **Session:** dry-run toggle, clear session.

**Warnings:** yellow above operating-rate guidance, red near the hard ceiling; the ceiling is a code cap
the UI cannot exceed.

---

## 8. UI design

**Direction:** Linear / ChatGPT-minimal. Monotone greys with whitish/silver **metallic** accents and a
subtle shiny flair. No gradients-as-decoration, no glassmorphism, no emojis. System font stack.

**Layout:** embedded Instagram tab (watch it work live) alongside a dashboard with:
- **Chain view** — the target lineage + live yield stats per session.
- **Candidates / Queue** — real state from the FollowRecord machine (not index arithmetic), grouped by
  lifecycle state.
- **Activity log** — streaming, with *working* level filters (debug included).
- **Settings** — §7, with live warnings.

**Correctness note:** the UI reflects real persisted state and receives explicit progress + error events
(no operation that resolves "success" on failure; no listener leaks; teardown on unmount).

---

## 9. Safety & resilience (built-in)

- Hard daily ceiling enforced **in code** from the durable ledger; operating rate under it.
- Global request budget covering reads + writes; human delays + jitter + active-hours.
- **Sentinel auto-halt + alert** on block/challenge/expiry.
- Instant abort via `AbortSignal` — no un-interruptible long sleeps.
- No silent `catch {}`; all failures surface to the UI; `AdapterStaleError` on selector drift.
- Atomic, versioned persistence; corrupt-file recovery.
- **Live verification against real Instagram (Chrome DevTools MCP) is a mandatory Phase 1 gate**
  before any churn logic is trusted.

---

## 10. Build phasing (verified foundation first)

Each phase is internally parallelizable across Opus agents; phases are sequential gates.

- **Phase 1 — Verified foundation.** Electron shell + embedded IG tab + persistent session; Instagram
  Adapter (Reader/Actor/Sentinel) **proven against live Instagram via DevTools MCP**; durable
  state/ledger + Request Governor + Rate Governor; login flow. Gate: real login, real follower-list
  read, real single follow + single unfollow, block-detection — all verified live.
- **Phase 2 — Churn core.** Scanner + Scorer (ratio sweet spot) + Churn Scheduler + Follow-back Watcher
  (batched detection) + own-target end-to-end churn. Gate: seed target → qualify → follow → detect
  follow-back → hold → unfollow, live, within budget.
- **Phase 3 — Intelligence + UI.** Chain Controller (discovery, yield stats, promotion, own-followers
  fallback) + full dashboard UI + Settings. Gate: chain advances one full hop autonomously.

---

## 11. Non-goals (YAGNI for now)

- No multi-account operation (single logged-in IG account).
- No concurrent multi-target poaching (chaining is sequential by design).
- No like/comment/DM automation.
- No cloud/server component; fully local desktop app.
- No private-API direct actioning (actions stay as human DOM clicks).

## 12. Phase-3 extension list ("other smart features," parked)

Engagement-signal scoring, follow-back retention analytics (who unfollowed you back), A/B timing
experiments, warmup interactions before following, per-target blacklist/whitelist. Captured, not built.

---

## 13. Key risks & mitigations

- **Instagram changes response shapes** → Reader parses defensively + health-checks; `AdapterStaleError`
  surfaces loudly; adapter is one versioned module.
- **Directly-issued API reads look non-native** → issue from the tab's own page context with its real
  session/headers; keep within the request budget.
- **`friendships/show_many` unavailable/changed** → fall back to incremental head-read; degrade cadence.
- **Chain converges to a bad niche** → minimum-yield gate + own-followers fallback + user can reseed.
- **Ban despite care** → conservative defaults, hard ceiling, Sentinel halt, dry-run mode.
