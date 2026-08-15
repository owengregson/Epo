# Macro-Timing Realism — Implementation Plan

**Date:** 2026-08-15
**Status:** Ready for execution by a subagent
**Author:** Fable (authored directly from a full read of the timing/engine/prune/settings
code, the rim/wiring audit, and the activity-dynamics literature)

> **How to read this plan.** §1–§3 are the *what and why* (current shape, target shape,
> the one architecture that produces it). §4–§6 are the *how*, file by file. §7 is the
> invariant checklist you must not break. §8 is the acceptance test. §9 is the order to
> build in. Line numbers are from the 2026-08-15 tree and drift with edits — **verify each
> anchor with a grep before editing**, don't trust the number blindly.

---

## Implementation status (2026-08-15)

- **Phase 1 — timing core (§4): DONE & verified.** `src/timing/{distributions,circadian,
  session-planner}.ts` + the `CIRCADIAN`/`SESSION`/`PATTERN` config groups, with full TDD
  suites and the §8 statistical-validation harness (`tests/timing/macro-pattern.test.ts`),
  which proves the emitted timeline is bimodal-log-normal, circadian, velocity-safe, and
  higher-entropy than the legacy metronome. The realized/day tracks the configured mean
  (~22 for a 25 target after rest days).
- **Phase 2 — engine/governor/settings/wiring (§5): DONE & verified.** The engine runs the
  session-driven loop when `pacing` is injected, keeping the legacy metronome when it is
  not; `RateGovernor.actionsInLastHour`; the new `Settings` knobs + `toPacingConfig` +
  `pacingModel`; `KnowledgeStore.get/setPacingState`; and the composition root builds a
  durable `SessionPlanner` (hydrated from store meta, live-reconfigured on settings change)
  and injects it only when `pacingModel === 'organic'` (default `'legacy'`, so app behavior
  is unchanged until the flag flips). New engine tests cover the organic path with a fake
  planner.
- **Phase 3 — woven prune feed (§5.2/§6.1): DONE & verified.** `EngineUnfollowFeed` on the
  PruneEngine (`nextCandidate`/`executeUnfollow`/`atDailyCap` — live whitelist + follows-us
  guard, ledger/edge writes, self-suspending fail/block breakers); the engine's step-8 woven
  pick (interleave with a bounded unfollow share, never displacing a due lifecycle unfollow,
  no aggregate ratio); the composition-root feed adapter; and scheduled auto-prune becomes
  scan-and-enqueue under weave. Tests: engine weave path + prune feed methods.
- **Phase 4 (partial) — enricher bug fix: DONE & verified.** `profile-enricher.ts` now paces
  on a sentinel block, closing the zero-delay spin loop (ships regardless of the flag).
- **§5.6 — qualitative settings: DONE & verified (data layer + primary UI).** `pattern-map.ts`
  (eight ordinal knobs + 5 personas → numeric config + circadian profile, pure/tested);
  `Settings.persona`/`pattern` with migration-safe derivation (named persona derives; custom/
  legacy preserve); the planner's circadian shape now follows the user's day/week choice; and
  the renderer `PatternCard` (persona picker + eight segmented knobs + a live day-shape preview)
  replacing the old numeric Strategy preset.
- **§5.6 follow-ups — DONE & verified.** (a) Daily volume is a FOLLOW plan: only follows
  spend the daily/session budget (unfollows + reads are weaved in on top, bounded by the
  velocity guard + prune cap) — `SessionPlanner.recordAction`. (b) Activity levels raised so
  the max plans ~100 follows/day (`minimal 15 … aggressive 100`; balanced default 50); the
  hard ceiling, plan size, and prune cap derive from it. (c) Settings page reworked from
  first principles: a `CollapsibleCard` primitive (minimize control + tooltip top-right; all
  sections except Seed·session start minimized), consolidated 9 cards → 6 proper categories
  (Seed·session · Behavior · Targeting · Advanced · Projected growth · Data·session), the
  Behavior card leads with persona + three headline knobs (activity/caution/cleanup) + a
  live preview and tucks the finer knobs under an "Advanced" disclosure, the redundant
  numeric Safety/Cadence/Lifecycle/Dry-run cards were removed (their live knobs
  redistributed), and the auto-accept row's missing horizontal padding was fixed.
- **Remaining:** the rest of the read de-fingerprinting (§6.2, DOM-pacing — `livetest`-gated
  for real validation); the connectivity heartbeat jitter (§6.3 — **deliberately deferred**:
  non-IG traffic, not part of Instagram's fingerprint, not worth risk to the shared
  `ScheduleManager`); and browser-gated settings-UI polish (folding the remaining numeric
  cards into an Advanced section, a richer preview chart) that needs the app running to verify.
- All four gates green throughout (`npx jest` 645 tests · `npx tsc --noEmit` · `npm run lint`
  · `npm run build:dev`).

## 0. Goal

Reshape *when* Epo issues its Instagram actions and reads so that, plotted over days and
weeks, the request timeline is statistically indistinguishable from an organic activity
stream — clustered, circadian, heavy-tailed — instead of the current machine-flat
metronome. The target is the **shape of the emitted data timeline**, not human-input
emulation. Cursor/keystroke motion lives in `src/interaction/*` and is explicitly out of
scope here. Every existing safety and correctness invariant (§7) is preserved.

---

## 1. What the timeline looks like today

Straight from the code:

| Activity | Mechanism (file) | Emitted shape | Why it's a fingerprint |
| --- | --- | --- | --- |
| **Growth follow** | `engine.ts` step 8 acts once, then waits `rate.nextDelayMs()` = `jittered(min,max,jit)` (`rate-governor.ts:91-94`); step 3 hard-gates on `withinActiveHours()`; step 4 parks once `atOperatingRate()` | one follow every **3–7 min ±30%**, **flat across a hard 8:00–22:00 wall**, **exactly `dailyOperatingRate` (25) every day**, then dead until midnight | A metronome. Low variance-to-mean, no clustering, no diurnal shape, identical daily envelope, hard on/off edges. |
| **Prune unfollow** | `prune-engine.ts` `run()` bulk loop, delay `scaled(jittered(...), 1/3)` (`PRUNE_DELAY_FACTOR`, `:265,1040-1046`) | ~1–2.3 min apart, **contiguous burst**, separate from the follow stream | Mass-unfollow burst; the follow batch and unfollow batch are time-separated — the exact follow→unfollow correlation IG flags. |
| **Enrichment** | `profile-enricher.ts:208` `sample(uniform(2.5–4.5s))` per fetch, 25/batch | steady drip, ~60–95 s/pass | Uniform (flat floor+ceiling). Bug: the sentinel-blocked `continue` (`:123-126`) skips the pace → zero-delay spin loop under a persistent block. |
| **Census walk** | `list-page-walker.ts` `uniform(1–3s)`/page (`:399`), `uniform(5–15s)` rest every 7 pages (`:400-409`) | drip + periodic long rest, ≤200 pages | Uniform gaps + a perfectly periodic rest cadence (every 7th page). |
| **Growth dialog scroll** | `followers-page-reader.ts:171-174` `fixed(2000)` when no bounds passed | **exactly 2 s every scroll** | The single most fingerprintable wait in the app — dead-constant. |
| **Notifications sweep** | `follow-notifications.ts` fixed 2 s scroll (`:231`), 800 ms close (`:261`), `uniform(1.5–3s)` accept pace (`:343`) | one-shot, mostly fixed | Fixed constants; accept pace uniform. |
| **Connectivity probe** | `connectivity.ts:56` `every('connectivity:probe', 20_000)` | **perfectly periodic 20 s** to gstatic 204 | Metronomic external beacon (non-IG, but a periodic network signal). |

The through-line: every draw is `uniform()`/`fixed()` — a flat band with hard floor and
ceiling and no clustering. **The distribution *shape*, not just its width, is the tell.**

---

## 2. What organic activity actually looks like, and the model we adopt

Poisson/exponential inter-arrival is the naive guess and it's *wrong* — real activity is
demonstrably non-Poisson. The literature is consistent:

1. **Bursty, heavy-tailed inter-event times** — Barabási, *Nature* 2005. Human gaps follow a
   **power law** (measured exponent **≈ 1.0 for email, ≈ 1.2 for web browsing**, generally in
   **[1, 2]**), a consequence of **priority-queue decision-making**: most actions fire
   quickly, a few wait a very long time; activity comes in bursts between long quiet
   stretches. The heavy tail is the load-bearing feature — a uniform band has none.
2. **The empirical best fit is a bimodal mixture of two log-normals** — Vázquez et al.
   *PNAS* 2010; Jiang et al. *WWW* 2015; and log-normality of interactivity times
   specifically (Blasius, "Are human interactivity times lognormal?", 2016). On a log-time
   axis, inter-activity is **bimodal**: a **within-session** cluster (mode ≈ **1 min**) and a
   **between-session** cluster (mode ≈ **1 day**). The two clusters are separated by a
   **session-boundary gap of ~30 min** — a threshold with a real pedigree (Catledge & Pitkow
   1995 measured a 9.3 min mean inter-event time, +1.5σ ≈ 25.5 min, smoothed to the 30 min
   that is still GA4's default session timeout). We use that 30 min as the natural split
   between "same session" and "new session."
3. **Sessions cluster on a circadian baseline** — Hawkes self-exciting process × a
   diurnal-weekly intensity field λ(t). Two refinements from the deeper reading:
   - The daily curve is **multi-peak**, not a single hump: a **morning-commute peak
     (~07:30–09:00)**, a **lunch bump (~12:00–13:00)**, and a **dominant evening peak
     (~17:00–18:30)**, with the trough **~04:00–06:00** (Twitter/large-corpus diurnal
     studies; LinkedIn/IG "best time" corpora).
   - **Weekly seasonality is a day-of-week vector**, not just weekend/weekday: mid-week
     (Tue/Wed) runs hot, a Friday resurgence, and a genuine weekend dip on some platforms —
     so the model carries a 7-element day weight, not a single weekend factor.
   - The Hawkes self-excitation must stay **sub-critical (branching ratio n < 1)** for
     stability — for an exponential kernel `α·exp(−t/τ)`, `n = α·τ`; social-media estimates
     run well below 1 outside viral cascades. Our within-session excitation is bounded by
     construction (§4.3) so it can never runaway.
4. **Sessions are ON/OFF with Weibull dwell** — web-traffic modeling: session length fits
   **Weibull (shape < 1)** (many short, few long); within-session inter-request fits
   **log-normal**.
5. **Instagram's own detection is velocity-first** — 2026 automation guidance: detection is
   more sensitive to **actions per minute** than per day; keep spacing **≥ 30–60 s**. This is
   an **established account** (no warm-up ramp — the user's account is real and already
   seasoned): the applicable band is ~**150–200 follows/day and ~20–30 follows/hour**;
   **unfollows trip blocks faster**; and IG explicitly flags **temporal follow→unfollow batch
   correlation** (a large follow burst followed later by a large unfollow burst). → the daily
   mean runs at full strength from day one; the hourly velocity cap uses the established tier.
6. **Automation is caught by *timing regularity itself* — low inter-arrival entropy and
   periodicity.** Bot-detection research keys on exactly the signature the current design
   emits: retweet/posting bots are flagged by **low time-interval entropy** and **regular
   (periodic) inter-arrival times** (relative-entropy DNA methods, *Sci Rep* 2022;
   Gianvecchio & Wang chat-bot entropy, USENIX Security 2008), and "a fixed 60-second sleep
   produces near-identical inter-arrival times no human generates." This is the direct
   indictment of `uniform`/`fixed` waits and the justification for high-entropy,
   aperiodic, heavy-tailed draws — and it gives us two hard acceptance metrics (§8):
   **inter-event entropy must be high** and **the event series must show no dominant
   period**.

### The model: a two-level stochastic point process

- **Level 1 — Sessions (the circadian ON/OFF layer).** Session *start* times are drawn from
  a non-homogeneous point process whose intensity is a diurnal-weekly field **λ(t)**
  (circadian curve × weekend factor, tapering to a small overnight floor). This *is* the
  soft active-hours ramp — no hard wall. The number of sessions per day and their placement
  vary day to day.
- **Level 2 — Within-session actions (the burst layer).** Inside an open session,
  inter-action gaps are **log-normal** (median ~90–100 s, **hard floor ~45 s** for IG
  velocity safety) divided by a **Hawkes self-excitation** term that briefly raises
  intensity after each action and decays, so the session naturally winds down. Per-session
  **budget** is drawn **Weibull(shape < 1)** — many short sessions, a few long ones.
- **Aggregate** inter-event law is therefore the empirically-correct **bimodal log-normal
  mixture** → heavy-tailed, with real day/night structure.
- **Daily volume is a distribution**, not a constant: realized as (#sessions × per-session
  budget), varying ~±28% around the configured mean with the occasional near-zero rest day.
  The hard operating-rate *stop* is retired; the **hard ceiling stays only as an
  uncrossable backstop**.
- **Prune is woven into the one action stream** (the user's choice): follows and
  prune/lifecycle unfollows drain from a single within-session queue, interleaved and
  **spread across many sessions over time**. Because Epo's core loop *is* a
  follow→wait→unfollow churn, its natural lifetime ratio is ~1:1 — so there is **no
  aggregate ratio cap**; temporal spreading (not a ratio) is what defeats the
  batch-correlation signal (see §10 R1).
- **De-fingerprint by shape:** replace `uniform±jitter` and `fixed` with
  log-normal/heavy-tailed draws wherever a wait is externally observable; jitter the fixed
  2 s scroll and the 20 s connectivity heartbeat.
- **Explicit anti-regularity objective:** the emitted timeline must have **high inter-arrival
  entropy** and **no dominant period** — the two properties bot detectors key on. These are
  first-class acceptance criteria (§8), not side effects.

### Decisions locked (from the user)

- **Realism model:** the full research-grounded two-level model above.
- **Caps & hours:** soften both — daily volume becomes a distribution; active-hours becomes
  a circadian ramp.
- **Prune:** weave into the growth stream.

---

## 3. Architecture: one planner owns pacing; engines own actions

A single `PacingPlanner` is the sole authority on *when*. It is constructed once, shared by
the growth engine (and, transitively, the woven prune unfollows), and is **kind-aware** so
follows, unfollows, and read-bursts all ride one session rhythm and one velocity envelope.
The planner computes **absolute epoch-ms deadlines**; it never sleeps. Consumers convert
`deadline − now` and pass it to the existing `DelayManager.wait(key, ms, {signal})`, so
`DelayManager` stays the one wait owner and `nextDeadline(...)` keeps feeding the renderer
countdown.

```ts
// src/timing/session-planner.ts
export type PlannerActionKind = 'follow' | 'unfollow' | 'read-burst';

export interface PacingPlanner {
  /** Roll the day when the local dayKey changes (fresh volume draw), close an elapsed
   *  session, and catch up anything that came due while the app was closed (§3).
   *  Idempotent; the engine calls it at the top of the session gate every step. */
  advance(now: number): void;

  /** True while inside an open session that still has budget AND today's drawn volume
   *  is not yet spent. Reads (§6.2) also consult this. */
  isSessionOpen(now: number): boolean;

  /** Epoch ms the open session ends (budget exhausted), else null. */
  sessionEndsAt(now: number): number | null;

  /** Epoch ms of the next session start — always strictly forward (drawn via circadian
   *  thinning; rolls into tomorrow's intensity when today is spent). */
  nextSessionStartAt(now: number): number;

  /** Next within-session inter-action gap: clamp(logNormal(median,sigma),floor,cap)
   *  ÷ Hawkes(now), re-floored AFTER the Hawkes division (the floor is a hard safety
   *  bound, never divided away). */
  nextActionGapMs(now: number): number;

  /** Record an executed action: decrement session budget, bump the day count, push a
   *  kind-stamped entry into the trailing-hour ring (drives Hawkes + the velocity guard). */
  recordAction(now: number, kind: PlannerActionKind): void;

  dailyTarget(now: number): number;    // today's realized volume draw (durable)
  sessionsToday(now: number): number;  // for status/§2

  serialize(): PlannerSnapshot;        // durable store-meta blob; hydrate via deps.snapshot
}
```

Two supporting ports:

- **`EngineUnfollowFeed`** (§6.1) — the growth loop pulls woven unfollow candidates from the
  PruneEngine's scanned census; the growth loop issues the DOM click (it already owns the
  tab and the sentinel gate), the feed writes the ledger row and reconciles the edge.
- **`ScheduleManager.every(key, intervalMs, fn, { jitterPolicy? })`** (§6.3) — an optional
  per-tick jitter so the connectivity probe and auto-prune watcher stop being perfectly
  periodic.

Two cross-cutting rules the parts below rely on:

- **Velocity is guarded twice, on purpose.** The planner enforces the rolling-hour cap from
  its persisted ring; the engine *also* enforces it independently from the durable ledger
  (`rate.actionsInLastHour()`). Both key on the same `hourlyVelocityCap` constant. Two nets so a lost planner
  snapshot can never produce a burst.
- **Reads don't spend the daily budget.** `read-burst` actions are stamped for Hawkes/
  velocity context but do not decrement `dailyTarget`, and the ≥45 s inter-action *floor*
  applies only to account-visible actions (`follow`/`unfollow`); reads keep their own faster
  log-normal policies (§6.2).

---

## 4. Part A — the pure timing core (`src/timing/`)

Renderer-safe, no Node/Electron imports (same constraint as `primitives.ts`), `Rng` + epoch
ms in, deterministic under a seeded rng and `FakeClock`.

### 4.1 `src/timing/distributions.ts`

```ts
import type { DelayPolicy, Rng } from './primitives';

export function normal01(rng: Rng): number;                                   // Box–Muller; consumes rng exactly TWICE
export function logNormal(medianMs: number, sigma: number): DelayPolicy;              // kind 'log-normal'
export interface LogNormalComponent { weight: number; medianMs: number; sigma: number; }
export function logNormalMixture(components: LogNormalComponent[]): DelayPolicy;      // kind 'log-normal-mixture'
export function weibull(scaleMs: number, shape: number): DelayPolicy;                 // kind 'weibull'  (shape<1 ⇒ heavy tail)
export function pareto(xMinMs: number, alpha: number, xMaxMs: number): DelayPolicy;   // kind 'pareto'   (bounded power law)
export function clamp(inner: DelayPolicy, minMs: number, maxMs: number): DelayPolicy; // bounded re-draw
```

Each returns the existing `DelayPolicy` shape (`{ kind, sample(rng) }` from
`primitives.ts:21`), so `sample()` and `DelayManager.wait()` consume them unchanged. Math:

- `normal01`: `u1 = 1 − rng()` (avoids `ln 0`), `u2 = rng()`; `Z = sqrt(−2·ln u1)·cos(2π·u2)`.
  Always exactly two draws — a fixed rng-draw count keeps seeded tests stable, the same
  discipline `jittered` already follows (`primitives.ts:48-61`).
- `logNormal`: `round(medianMs · exp(sigma · normal01(rng)))`. Median-parameterized because
  the config reasons in medians; document `mean = median·exp(σ²/2)` in the constant comment.
- `logNormalMixture`: normalize weights defensively; one `rng()` walks the cumulative
  weights to pick a component; then that component's `logNormal` draw (three draws total).
- `weibull`: `scaleMs · (−ln(1 − rng()))^(1/shape)`; clamp `shape ≥ 0.05`.
- `pareto`: `u = rng()`; `xMin / (1 − u·(1 − (xMin/xMax)^alpha))^(1/alpha)`; both bounds hold
  by construction.
- `clamp`: re-draw `inner` up to **4 times**, take the first sample in `[min,max]`; after 4
  misses project onto the nearer bound. (Pure projection would pile a spike at the bound —
  the very fingerprint we're removing; bounded re-draw preserves the shape, keeps residual
  bound-mass < 0.1% at our parameters, and bounds the draw count for tests.)

**Canonical idiom** used everywhere below: `clamp(logNormal(median, sigma), floorMs, capMs)`
= "log-normal with a safety floor and a tail cap."

### 4.2 `src/timing/circadian.ts`

```ts
export interface CircadianBump { centerHour: number; amplitude: number; widthHours: number; }
export interface CircadianProfile {
  bumps: CircadianBump[];         // sum-of-Gaussians on the 24h circle (morning/lunch/evening)
  overnightFloor: number;         // λ never fully zero — a rare 3am action is human
  dayOfWeekWeights: number[];     // length 7 (Sun..Sat) intensity multipliers — weekly seasonality
  weekendShiftHours: number;      // Sat/Sun activity starts/ends later
  phaseOffsetHours: number;       // per-install jitter, drawn once and persisted
}
export function intensityAt(nowMs: number, profile: CircadianProfile): number;  // → [0,1], local time via Date
export function sampleNextSessionStart(fromMs: number, profile: CircadianProfile,
                                       peakRatePerDay: number, rng: Rng): number;
export function samplePhaseOffset(maxHours: number, rng: Rng): number;
```

Curve — with `h` = local fractional hour + `phaseOffsetHours` (+ `weekendShiftHours` on
weekends) and circular distance `d(h,c) = min(|h−c|, 24−|h−c|)`:

```
raw(h)    = overnightFloor + Σᵢ amplitudeᵢ · exp(−d(h,centerᵢ)² / (2·widthᵢ²))
intensity = clamp(min(1, raw(h)) · dayOfWeekWeights[localDow], 0, 1)
```

Defaults (§4.4): **three** bumps — a morning-commute bump at **8.0** (amp 0.45, width 1.6 h),
a lunch bump at **13.0** (amp 0.5, width 2.0 h), and a dominant evening bump at **18.0**
(amp 1.0, width 3.0 h) — matching the observed morning/lunch/evening triple-peak. Result:
ramps in from ~06:30, distinct morning and midday peaks, maximum ~16:30–19:30, natural
minimum ~04:30 on the floor. No configured hour is ever an exact on/off edge. The
`dayOfWeekWeights` vector applies weekly seasonality (mid-week hot, Friday resurgence,
weekend dip) and `weekendShiftHours` shifts the weekend bumps later.

Session sampling — **Lewis thinning** on λ(t) = `peakRatePerDay · intensityAt(t)`:
`λmax = peakRatePerDay / 86_400_000` (per ms); loop `t += −ln(1 − rng()) / λmax`, accept when
`rng() < intensityAt(t, profile)`, return the first accepted `t`. Iteration cap 10_000 with a
loud-logged `fromMs + 24h` fallback (the positive floor makes non-termination impossible in
practice). `peakRatePerDay` is derived by the planner from the daily mean (§4.3 rule 2).

### 4.3 `src/timing/session-planner.ts`

Implements `PacingPlanner`. Deps: `{ rng?: Rng, profile: CircadianProfile,
cfg: SessionPlannerConfig, snapshot?: PlannerSnapshot | null }` (methods take `now`, so no
clock is needed).

```ts
export interface SessionPlannerConfig {
  dailyMeanActions: number;    // from Settings.dailyOperatingRate (reinterpreted as the mean)
  dailyHardCeiling: number;    // unchanged backstop
  dayVolumeSigma: number; restDayProbability: number; restDayMaxFraction: number;
  sessionsPerDayMin: number; sessionsPerDayMax: number; // session COUNT the target is split across
  gapMedianMs: number; gapSigma: number; gapFloorMs: number; gapCapMs: number;
  hawkesAlpha: number; hawkesTauMs: number;
  maxActionsPerRollingHour: number; // established-account velocity cap (§4.4)
}
export interface PlannedSession { startAt: number; budget: number; }
export interface PlannerSnapshot {
  v: 1;
  dayKey: string;                          // 'YYYY-M-D' local
  dayTarget: number; dayUsed: number;
  dayPlan: PlannedSession[];               // the day's sessions (sorted by startAt)
  nextPlanIdx: number;                     // next session to open
  session: { startedAt: number; budget: number; used: number } | null;
  recentActions: { at: number; kind: PlannerActionKind }[]; // trailing 60 min
  phaseOffsetHours: number;
}
```

Rules:

1. **Day roll.** On a `dayKey` change (or first query): draw `dayTarget`. With probability
   `restDayProbability` (default 0.08) it's a light day `round(dailyMeanActions · uniform(0,
   restDayMaxFraction))`; otherwise `round(dailyMeanActions · exp(dayVolumeSigma ·
   normal01(rng)))` — log-normal, CV ≈ 28%. Clamp to `[0, dailyHardCeiling]`; reset
   `dayUsed`. (No warm-up multiplier — this is an established account; full mean from day
   one.)
2. **Day plan (session layout).** At the same day roll, draw a session COUNT ~ uniform int
   `[sessionsPerDayMin, sessionsPerDayMax]` (capped at `dayTarget`), sample that many start
   times across the day from λ(t) by intensity-rejection (spread morning/midday/evening,
   leaving a 20-min pre-midnight tail so a late session finishes today), sort them, and
   distribute `dayTarget` across them as jittered per-session budgets summing to the target.
   Distributing a fixed target — instead of summing independent Weibull budgets and capping —
   is what keeps realized daily volume on the configured mean; laying starts out up front —
   instead of scheduling each within the shrinking remainder — keeps them circadian.
3. **Session open.** When `now ≥` the next planned session's `startAt` and the day still has
   budget, open it with that entry's budget (truncated to `dayTarget − dayUsed`); advance the
   plan index. Past-due entries after a park open on the next `sync` (catch-up).
4. **Within-session gap.** `nextActionGapMs = reFloor( clamp(logNormal(gapMedianMs,gapSigma),
   gapFloorMs, gapCapMs).sample(rng) / hawkes(now) )`, where `hawkes(now) = 1 + Σᵢ
   hawkesAlpha · exp(−(now − tᵢ)/hawkesTauMs)` over `recentActions` (τ = 90 s). Early
   actions in a session excite (gap shrinks up to ~1.4×), then decay lets it wind down. The
   re-floor guarantees ≥ `gapFloorMs` even after the division.
5. **Velocity guard (hard).** If the trailing-hour `recentActions` count ≥
   `maxActionsPerRollingHour`, the next deadline becomes `oldestInHour + 1h + one floor
   draw` — an uncrossable backstop independent of the distributions.
6. **Session close.** `used ≥ budget` (or a >30 min idle gap) → close the session; the next
   planned entry opens when due.
7. **Durable catch-up (§3).** Constructing with a snapshot restores everything verbatim. An
   an overdue planned session opens on the next query (overdue work runs first);
   `recentActions` survives so a relaunch can't burst past the velocity guard; a stale
   `dayKey` triggers a fresh day-draw exactly as crossing midnight would.

The planner computes deadlines only. The engine turns them into interruptible waits via
`DelayManager` (§5.1).

### 4.4 New `src/timing/config.ts` groups (every value carries a "why", cited)

```ts
export const CIRCADIAN = {
  BUMPS: [ { centerHour: 8.0,  amplitude: 0.45, widthHours: 1.6 },   // morning-commute peak (~7:30–9:00)
           { centerHour: 13.0, amplitude: 0.5,  widthHours: 2.0 },   // lunch bump (~12:00–13:00)
           { centerHour: 18.0, amplitude: 1.0,  widthHours: 3.0 } ], // dominant evening peak (~17:00–18:30)
  OVERNIGHT_FLOOR: 0.015,       // rare odd-hour actions exist in real traces; an exact-zero night is a machine edge
  // Sun..Sat weekly seasonality: mid-week hot, Fri resurgence, weekend dip (diurnal-corpus studies)
  DAY_OF_WEEK_WEIGHTS: [0.9, 1.0, 1.08, 1.08, 1.0, 1.02, 0.92],
  WEEKEND_SHIFT_HOURS: 1.4,     // weekend rhythm starts/ends later
  PHASE_JITTER_MAX_HOURS: 1.5,  // per-install offset so no two installs share an identical curve
} as const;

export const SESSION = {
  SESSIONS_PER_DAY_MIN: 3, SESSIONS_PER_DAY_MAX: 6, // the day's target is split across this many circadian-placed sessions
  GAP_MEDIAN_MS: 95_000, GAP_SIGMA: 0.75,        // within-session mode ≈1–2 min (WWW-2015 within-session cluster)
  GAP_FLOOR_MS: 45_000, GAP_CAP_MS: 8 * 60_000,  // floor: IG ≥30–60s velocity guidance; cap keeps the tail sane
  SESSION_BOUNDARY_MS: 30 * 60_000,              // a gap > this = a new session (Catledge & Pitkow 1995 / GA4 default)
  HAWKES_ALPHA: 0.35, HAWKES_TAU_MS: 90_000,     // exponential kernel; effective branching ratio n≈α<1 (sub-critical/stable) — decays over ~1.5 min
  MAX_ACTIONS_PER_ROLLING_HOUR: 22,              // established-account velocity backstop (IG ~20–30/hr established)
} as const;

export const PATTERN = {
  DAY_VOLUME_SIGMA: 0.28,                 // day-to-day CV ≈28% — a flat exact-N daily count is a fingerprint
  REST_DAY_PROBABILITY: 0.08,             // ~1 light day per ~2 weeks; humans skip days
  REST_DAY_MAX_FRACTION: 0.15,            // a rest day is near-zero, not exactly zero
  MAX_UNFOLLOW_FRACTION_PER_SESSION: 0.5, // keep any single session from being unfollow-dominated (mix within a burst — NOT an aggregate ratio; §10 R1)
  TAIL_EXPONENT: 1.2,                     // between-session/long-gap power-law tail (web-browsing α≈1.2; email≈1.0) — the mixture's long component targets this
} as const;
```

(No warm-up group — the account is established; there is no ramp.)

### 4.5 Part A tests (`tests/timing/`, FakeClock + seeded rng)

- **distributions.test.ts:** `normal01` draw-count (exactly 2) + moments over 10k samples;
  `logNormal` median within 3% + one-sided-σ fraction; `logNormalMixture` component
  fractions + two modes on a log-axis histogram; `weibull`/`pareto` inverse-CDF spot values
  vs. precomputed constants + CCDF; `clamp` never out of bounds + projection after 4 misses
  (draw count asserted with a counting rng).
- **circadian.test.ts:** known-hour intensities (04:30 < 0.05, 18:30 > 0.95, 13:00 ∈
  [0.5,0.8], monotone rise 06:00→10:00); weekend shift+factor; phase-offset equivalence
  (`intensityAt(t, off=2)` == `intensityAt(t−2h, off=0)`); thinning histogram vs λ(t)
  Pearson r > 0.9; dead-zone profile → no starts scheduled; cap fallback path.
- **session-planner.test.ts:** day-draw mean/CV/rest-day fraction/ceiling; budget truncation
  and close; gap ≥ floor always, log-histogram unimodal near ~95 s, Hawkes shortens the gap
  right after quick actions then reverts after > 5τ; velocity guard trips at the cap;
  serialize→hydrate round-trip equality; hydrate with the clock advanced past a planned start
  opens the overdue session on the first query; advanced past midnight redraws the day;
  `recentActions` survives so a relaunch still trips the guard; end-to-end determinism under
  one seed.

---

## 5. Part B — growth engine, governor, settings

### 5.1 `engine.ts` step-loop rewrite

Add `pacing: PacingPlanner` to `EngineDeps` (`engine.ts:200-242`); no default fallback (the
composition root supplies it; tests inject a fake). Reworked precedence (replaces the §3.1
doc block at `engine.ts:556-580` and the branches noted):

| # | Branch | Change |
|---|--------|--------|
| 1 | aborted/halted (`:602`) | unchanged |
| 2 | sentinel gate (`:605-607`) | unchanged |
| 3 | **hard-ceiling backstop only** → park to midnight, `'waited-ceiling'` | keep `atHardCeiling()` from `:620-623`; **remove `atOperatingRate()`** from this branch |
| 4 | **session gate (new):** `pacing.advance(now)`; if `!pacing.isSessionOpen(now)` → `engineWait('engine:session-park', pacing.nextSessionStartAt(now) − now)` → `'waited-session'` | **replaces** the active-hours gate (`:610-613`) and the operating-rate half of `:620-623`; delete `msUntilActiveWindow()` (`:1000-1006`) |
| 4b | **velocity backstop (new):** if `rate.actionsInLastHour() ≥ cfg.hourlyVelocityCap` (established-account cap, §4.4) → `engineWait('engine:velocity-park', clamp(logNormal(8·60_000,0.3),5·60_000,15·60_000))` → `'waited-session'` | independent ledger-based net (defense-in-depth with the planner ring) |
| 5 | `churn.advanceTimers` + target resolution (`:628-639`) | unchanged |
| 6 | follow-back sweep (`:644-649`) | unchanged — now implicitly session-gated by 4, which is exactly the realism we want (reads cluster inside sessions) |
| 7 | pool refill (`:656-659`) | unchanged (but see R5: a session's first refill may precede its first action) |
| 8 | **woven action (§5.2):** owed-delay payoff mechanics unchanged (`:668-677`); after `execute`: `pacing.recordAction(now, kind)` then arm the deadline with `pacing.nextActionGapMs(now)` instead of `rate.nextDelayMs()` (`:696`) | rewritten |
| 9 | chain advance (`:708-726`) | unchanged |
| 10 | idle beat (`:729-730`) | unchanged |

`StepResult` (`:161-170`): rename `'waited-active-hours'` → `'waited-session'` (update
`src/renderer/lib/engine-view.ts`).

**Invariants:** all new waits go through `engineWait` (`:974-978`) under `engine:*` keys, so
`pause()`/`stop()`/`setOnline(false)`'s `cancelAll('engine:')` (`:464,:487,:514`) already
covers them; one-major-thing-per-iteration holds; the owed-delay `action_delay_deadline_at`
mechanics are untouched (`:342,:366,:936-939`) — an owed gap that outlives a session simply
expires while parked and the next session's first action fires at open (realistic and safe);
`awaitParked`/`isDrivingTab` untouched. Add a status emit on `engine:session-park`
registration (mirror the `engine:action-delay` emit at `:976`) so the renderer countdown
gets the session deadline.

**Durable state:** persist the planner snapshot under a new store-meta key **`pacing_state`**
via `KnowledgeStore.getPacingState()/setPacingState(raw: string | null)` (mirror
`get/setActionDelayDeadline`; the meta table exists in `src/store/schema.ts`). The
composition root hydrates the planner **before** constructing the Engine; `pacing.advance()`
in step 4 plus hydrate-at-boot delivers §3 catch-up.

**`EngineStatus` additions** (`:173-197`, projected `:522-552`):
```ts
pacing: { sessionOpen: boolean; sessionEndsAt: number | null; nextSessionAt: number | null;
          sessionsToday: number; dailyTarget: number }
```
`nextActionAt` (`:546-547`) stays; the renderer shows `nextSessionAt` when
`sessionOpen === false`. Renderer consumers to follow up (separate task, R7):
`engine-view.ts`, `LiveStatusCard`, `RateSafetyCard`, `useCountdown`.

### 5.2 The woven action stream (step 8)

Feed port, implemented on `PruneEngine` (§6.1) — **not** its `run()` loop:
```ts
export interface EngineUnfollowFeed {
  /** Next actionable prune unfollow, or null. Pure selection over the scanned census:
   *  applies the live whitelist, the live-graph follows-us guard (never unfollow someone
   *  who now follows us — mirrors prune-engine.ts:592), null-username skip, scan freshness,
   *  and the prune daily cap. No IG traffic; no mutation until reportOutcome. */
  nextCandidate(now: number): { pk: string; username: string } | null;
  /** Settle a woven unfollow: write prune_ledger + reconcile the edge (§1) exactly like
   *  prune-engine.ts:632-653, advance visitCandidate, and track the prune-specific
   *  consecutive-fail breaker. */
  reportOutcome(cand: { pk: string; username: string }, status: ChurnActionOutcome['status'], now: number): void;
  pendingCount(now: number): number;
  atDailyCap(now: number): boolean;
}
```
The growth loop issues the DOM unfollow itself (it owns the tab and the sentinel gate),
through the shared rim `ChurnActions.unfollow(username)`, then calls `reportOutcome`.

**Picking policy — interleave by due-ness, spread over time, NO aggregate ratio cap:**
```
followAvail   = churn.nextDue(now) is a queued FOLLOW
unfollowDue   = churn.nextDue(now) is a lifecycle UNFOLLOW           // already preempts follows, churn-scheduler.ts:190-195
pruneAvail    = feed.nextCandidate(now) !== null && !feed.atDailyCap(now)
unfollowAvail = unfollowDue || pruneAvail
```
- Both a follow and an unfollow available → pick to keep the kinds **mixed within the
  session**: choose an unfollow with probability ≈ its share of the combined pending queue,
  **clamped so unfollows never exceed `PATTERN.MAX_UNFOLLOW_FRACTION_PER_SESSION` of the
  current session's recorded actions** (a mix guard against a mini-burst *inside one
  session* — not a daily ratio). Prefer a lifecycle unfollow over a prune candidate when
  both exist (lifecycle work is time-sensitive).
- Only one kind available → it proceeds.
- After either kind: `pacing.recordAction(now, kind)` + one shared `nextActionGapMs` draw →
  one organic series.

Bounds still in force: the growth daily ledger, the prune daily cap (`feed.atDailyCap`), and
the velocity guard. The temporal spreading across sessions is what defeats the
batch-correlation signal; Epo's churn lifecycle legitimately lands near ~1:1 and that is
correct (§10 R1).

**Outcome handling** mirrors `prune-engine.ts:610-653`: `blocked` → candidate NOT consumed,
`engineWait('engine:prune-park', PRUNE.PARK_MS)`, 3 consecutive blocks →
`halt('blocked-repeatedly')`; `failed` → consume + a **prune-specific** consecutive-fail
counter (reset on a successful *unfollow*, not an intervening follow — R1 in §6.1) that, at
`PRUNE_CONSECUTIVE_FAIL_HALT` (4), **stops feeding unfollows** (growth continues), surfaced
in `PruneStatus`; `ok`/`simulated` reset it and write the ledger row at act time (§1). The
existing growth `consecutiveFailureCount` halt (`:686-690`) is unchanged for follows.

### 5.3 `rate-governor.ts`

- **Delete `nextDelayMs()`** (`:91-94`); its only production caller is `engine.ts:696` (grep
  harness callers first).
- **`atOperatingRate()` → `atDailyTarget()`** (`:59-61`): compare `actionsToday()` to an
  injected `dailyTarget: () => number` wired to `pacing.dailyTarget`; `remainingToday()`
  (`:49-51`) follows the same provider. `atHardCeiling()` (`:63-65`) unchanged.
- **`withinActiveHours()`** (`:76-83`): retired from the engine path (the session gate
  subsumes it), but **kept** and reimplemented as `intensityAt(now, profile) ≥
  MIN_SCHEDULED_INTENSITY` for the two remaining callers — the scheduled-prune gate
  (`foundation-wiring.ts:1106`) and the prune-scan hours gate (`prune-engine.ts:555`) — so
  scans still avoid the dead of night without a hard wall.
- **New `actionsInLastHour()`:** `actionCountSince(now − 3_600_000) +
  realPruneActionCountSince(now − 3_600_000)` (both store queries already accept an arbitrary
  `since`, `:43-46`). `actionsToday()` unchanged (both ledgers, durable).

### 5.4 `settings.ts`

Reinterpret where the semantics survive (UI copy changes; storage keys stay — "one home per
value"):

| Field | New meaning |
|---|---|
| `dailyOperatingRate` (`:114`) | daily-volume **mean** (default 25 stays) |
| `dailyHardCeiling` (`:113`) | unchanged backstop |
| `activeHoursStart/End` (`:117-118`) | soft circadian envelope edges (ramp over `rampHours` inside; ~floor outside) |
| `minDelayMinutes`/`maxDelayMinutes`/`jitterPercent` (`:115-116`) | retained for prune-scan + manual-override pacing only; no longer feed growth |

New knobs (default → clamp in `sanitizeSettings`, `:197-256`): `dailyVolumeVariancePct`
28→0–60; `restDayChancePct` 8→0–30; `sessionsPerDayMin/Max` 3/6→1–12 (max ≥ min);
`gapMedianSeconds` 95→45–600; `gapFloorSeconds` 45→30–300 (floor ≤ median); `rampHours`
2→0.5–4; `weaveEnabled` true; `maxUnfollowFractionPerSession` 0.5→0–1; `hourlyVelocityCap`
22→5–40 (established-account cap); `pacingModel: 'legacy' | 'organic'` (default `'legacy'`,
the §9 rollout flag). No warm-up knobs — the account is established, so full mean from day
one and no age tiering. Day-of-week weights and circadian bump shapes stay registry
constants (`CIRCADIAN`), not user knobs.

Add `toPacingConfig(s)` beside the other mappers (`:299-309`) producing `SessionPlannerConfig`
+ the engine's weave/velocity knobs; `toRateGovernorConfig` drops the delay fields. Backward
compatibility is automatic — `loadSettings` merges over `DEFAULT_SETTINGS` (`:152-171`), so an
old file gains the new knobs at their defaults with no migration code.

**These numeric fields are not the user surface.** They become the **derived/advanced layer**
beneath the qualitative controls in §5.6: the primary UI writes `persona`+`pattern` (ordinal
enums), `resolvePattern()` materializes these numbers, and only a collapsed "Advanced" panel
edits them directly. Everything above stays true — the mappers consume the same numeric fields
whether they came from a persona or an advanced override.

### 5.5 Part B tests

Scripted `PacingPlanner` fake + `FakeClock`; one integration test uses the real seeded
planner (determinism). Cover: closed session → `'waited-session'` (churn/sweep/refill not
called); open session → `'acted'` + exactly one `recordAction`; budget exhaustion parks (no
extra action); the weave interleaves follows/unfollows and no session exceeds
`maxUnfollowFractionPerSession` unfollows (no aggregate ratio gate); lifecycle unfollows
drain as due; empty growth queue → unfollows proceed bounded by the prune daily cap;
`weaveEnabled:false`/at-cap → feed never called; `blocked` retry/3× halt and 4× prune-fail
stops the feed (growth continues, remainder intact in the snapshot); velocity backstop
parks; the ceiling backstop precedes the session gate; owed-gap stop/relaunch still green +
`pacing_state` round-trip + overdue-open acts this step; pause during a session park
re-parks to the same deadline on resume; governor `atDailyTarget` against the provider +
`actionsInLastHour` window edges; every new settings clamp + inverted pairs (floor > median,
min > max sessions) degrade safely + a legacy file loads at defaults.

### 5.6 Settings page revamp — qualitative pattern controls

The numeric knobs in §5.4 describe *distributions* (medians, sigmas, sessions/day, velocity
caps). A user should never see those — they should tune **behavior**, and the numbers are
derived. This generalizes the pattern the app already uses (the Command Console's Strategy
preset already locks rate/delay/jitter for non-Custom presets; `strategy-presets.ts`,
`StrategyCard.tsx`, debounced autosave via `useSettingsDraft`). The revamp keeps the
Command Console visual system (`styles/tokens.css`, 4px spacing, the radial budget gauge —
per `docs/mockups/command-console.html`); it changes *what* the settings mean.

#### 5.6.1 The qualitative model

Settings gains one object of **ordinal enums** — the only thing the primary UI writes:

```ts
export interface PatternSettings {
  activityLevel: 'minimal' | 'light' | 'moderate' | 'active' | 'aggressive';
  consistency:   'clockwork' | 'natural' | 'erratic';   // day-to-day variance + rest days
  rhythm:        'trickle' | 'sessions' | 'bursts';     // within-day session structure
  dayShape:      'morning' | 'balanced' | 'evening' | 'nightowl' | 'business'; // circadian daypart
  weeklyShape:   'uniform' | 'weekdays' | 'weekends' | 'realistic';            // day-of-week
  caution:       'cautious' | 'standard' | 'bold';      // velocity cap + spacing floor
  cleanup:       'off' | 'trickle' | 'steady' | 'deep'; // prune weave intensity
  patience:      'quick' | 'normal' | 'patient';        // follow-back wait + hold (churn lifecycle)
}
export interface Settings {
  // …existing fields…
  persona: 'casual' | 'balanced' | 'grower' | 'nineToFive' | 'nightOwl' | 'custom';
  pattern: PatternSettings;   // the qualitative source of truth (primary UI writes ONLY this)
}
```

#### 5.6.2 The mapping layer — `src/settings/pattern-map.ts` (pure, renderer-safe)

One pure module maps `PatternSettings` → the numeric config, so **the main-process
settings→config path and the renderer's live preview use the identical function** (the
preview can never lie). No Node imports (settings.ts is main-only, but this module is pure
and shared). `resolvePattern(p): ResolvedPattern` returns the display-unit numbers §5.4's
mappers already consume, plus a `CircadianProfile`:

```ts
export interface ResolvedPattern {
  dailyMeanActions: number; dailyHardCeiling: number;   // = round(mean·1.3), the existing rule
  dayVolumeSigma: number; restDayProbability: number;
  sessionsPerDayMin: number; sessionsPerDayMax: number;
  gapMedianSeconds: number; gapFloorSeconds: number;
  hawkesAlpha: number;
  hourlyVelocityCap: number;
  profile: CircadianProfile;                            // bumps/DOW/shift for the daypart+week
  weaveEnabled: boolean; maxUnfollowFractionPerSession: number; pruneDailyLimit: number;
  maxWaitForFollowbackDays: number; holdAfterFollowbackDays: number;
}
```

Representative mappings (each ordinal → a value; full tables live in the module, values are
starting points to tune against the §8 harness):

| Knob | option → value |
|---|---|
| `activityLevel` | `dailyMeanActions` ≈ minimal 6 / light 12 / moderate 22 / active 40 / aggressive 65 (ceiling = round(mean·1.3)) |
| `consistency` | `dayVolumeSigma` 0.12 / 0.28 / 0.45; `restDayProbability` 0.0 / 0.08 / 0.18 |
| `rhythm` | trickle → many small sessions (`sessionsPerDay` 5–9), `gapMedianSeconds` 180, `hawkesAlpha` 0.10; sessions → 3–6/day, gap 95, α 0.35; bursts → 2–4/day, gap 55, α 0.6 |
| `dayShape` | selects `profile.bumps`/`overnightFloor`/`weekendShiftHours`: morning emphasizes the 08:00 bump; evening the 18:00; nightowl shifts peaks to 21:00–01:00 + higher floor; business a strong 09:00–17:00 plateau, muted evening; balanced = the §4.4 default |
| `weeklyShape` | `profile.dayOfWeekWeights`: uniform all 1.0; weekdays Mon–Fri↑/weekend↓; weekends inverse; realistic = the §4.4 default |
| `caution` | `hourlyVelocityCap` 14 / 22 / 30; `gapFloorSeconds` 60 / 45 / 35 (bold nears IG's ~30/hr established ceiling) |
| `cleanup` | off → `weaveEnabled:false`; trickle/steady/deep → `maxUnfollowFractionPerSession` 0.25/0.5/0.7 and `pruneDailyLimit` 20/50/120; deep also surfaces the manual "Prune now (fast)" override prominently |
| `patience` | `maxWaitForFollowbackDays` 2 / 4 / 7; `holdAfterFollowbackDays` 1 / 2 / 4 |

#### 5.6.3 Personas (bundles) + Custom

`persona` is the master: selecting one sets every `pattern` enum to a bundle and **locks the
individual knobs** (exactly like the current non-Custom strategy lock). Editing any knob
flips `persona → 'custom'` and unlocks them. Defaults: **balanced**. Bundles, e.g.:

- **Casual** = light · natural · trickle · evening · realistic · cautious · trickle · normal
- **Balanced** (default) = moderate · natural · sessions · balanced · realistic · standard · steady · normal
- **Grower** = active · natural · sessions · balanced · realistic · bold · steady · quick
- **Nine-to-Five** = moderate · clockwork · sessions · business · weekdays · standard · steady · normal
- **Night Owl** = moderate · natural · bursts · nightowl · realistic · standard · trickle · patient

#### 5.6.4 The live pattern preview (the payoff)

Because the whole point is "reflect the patterns," the settings page **shows the resulting
timeline live**. A `PatternPreviewCard` runs the pure `SessionPlanner` (Part A) with a fixed
seed over a simulated week on every debounced draft change (`resolvePattern(draft.pattern)`
→ planner → event list) and renders, in the Command Console idiom:

- a **24-hour intensity ribbon** (the λ(t) curve) with sampled session clusters overlaid;
- a **7-day strip** showing session bursts and quiet gaps (weekly shape visible at a glance);
- readouts: ~actions/day (with the ± band, since volume varies), sessions/day, typical
  active window, typical inter-action gap; and a **"looks-human" chip** driven by the §8
  metrics (inter-event entropy + no-periodicity) — green when the preview passes, amber when
  a knob combination flattens it.

This reuses the §8 pure simulation and the existing chart layer (`charts/growth-model.ts`,
`GrowthChart.tsx` precedent) — no engine, no IG, instant and deterministic. Dragging
`rhythm` toward *bursts* visibly tightens the clusters; the user tunes by *seeing*.

#### 5.6.5 Storage, derivation, backward compatibility

- The primary UI writes only `persona` + `pattern`. On load/save, `settings.ts` calls
  `resolvePattern(pattern)` and materializes the numeric fields (§5.4) so the existing
  `toPacingConfig`/`toRateGovernorConfig`/`toChurnConfig`/`toPruneConfig` mappers are
  **unchanged** — the qualitative layer sits *in front of* them.
- **Advanced (custom numbers) panel:** a collapsed section exposes the raw numbers for power
  users; editing one sets `persona:'custom'` and stores the override, which
  `resolvePattern` then respects (override wins over the enum-derived value). Nothing is
  lost for power users; it's just not the default surface.
- **Backward compat:** a legacy file has no `pattern` key → `loadSettings` (merges over
  `DEFAULT_SETTINGS`) detects this and maps the existing numbers to the **closest persona**
  (nearest `dailyOperatingRate` bucket etc.), or, if they don't match a bundle, keeps them as
  `persona:'custom'` + advanced overrides. `sanitizeSettings` validates each enum against its
  allowed set (fallback to the default option) and clamps advanced overrides as today.

#### 5.6.6 Components (renderer)

Aligned with `styles/tokens.css` + `useSettingsDraft` debounced autosave (no Save button):

- **`PersonaCard`** (new, top of Settings) — a segmented persona picker; the master control.
- **`PatternCard`** (new, replaces the numeric guts of `StrategyCard`/`CadenceCard`) — the
  eight qualitative knobs as **labeled segmented pills / ordinal sliders** (never number
  inputs), each with a one-line plain-language caption. Disabled/locked while a non-Custom
  persona is selected.
- **`PatternPreviewCard`** (new) — §5.6.4.
- **Advanced panel** — the old numeric cards (`CadenceCard`, `SafetyCard`, `LifecycleCard`)
  move here, collapsed, exposing raw numbers for overrides.
- Unchanged: `SeedSessionCard`, `DryRunCard`, the radial daily-budget gauge (now shows the
  *mean* with a ± band). `useSettingsDraft` gains `persona`/`pattern` in the draft shape.

#### 5.6.7 Tests

`pattern-map` determinism; every enum option resolves to an in-range value; each persona
bundle resolves to a sane, harness-passing config; `sanitizeSettings` falls back on a bad
enum and clamps advanced overrides; a legacy numeric-only file maps to a persona (or
Custom); the preview simulation is pure/deterministic under a fixed seed and matches what the
engine would emit for the same `pattern`; persist/round-trip of `persona`+`pattern`.

---

## 6. Part C — prune weave, read reshaping, external signals, wiring

### 6.1 Prune woven (`prune-engine.ts` side)

**Stays in `PruneEngine`** (the census/verdict half — legitimate §1 absence-verdicts that
gate on a complete walk): `scan()`/`performScan()` (`:421-459,771-931`),
`assertFetchComplete`/`assertScanCoverage` (`:970-998`), the ghost buffer, `ingestScanCensus`
authoritative (`:870`); the raw census + durable snapshot (`pendingCandidates`/`pendingScanAt`,
`save/get/clearPruneScan`, `:337-361,910-916`), `PRUNE_SCAN_FRESH_MS` (6 h, `:273`); the
durable **daily-cap ledger** (`dailyDone()` `:1000-1004`, `recordPruneAction` `:635-653`);
the **live-graph guard** + per-candidate skips (`:579-606`), now invoked from
`feed.nextCandidate`; `visitCandidate` + remainder-handback (`:530-536,711-714,681-696`).

**Removed from the bulk path:** the `run()` unfollow loop's *pacing* (`prune:action-delay`,
`:658`; the `pruneWait` helper `:1055-1059` for that key), **`PRUNE_DELAY_FACTOR`** (delete
from `config.ts:26` and `prune-engine.ts:265`), and the `PRUNE_PARK_MS` park-retry inside the
loop (`:625`) — those move into the woven step (§5.2). Unfollows now inherit the same
within-session gap policy as follows.

**`EngineUnfollowFeed` is implemented here.** `nextCandidate` is pure selection over
already-scanned data (no IG traffic, no mutation until `reportOutcome`), so a sentinel abort
before the click leaves the candidate runnable — the same guarantee today's blocked/not-
visited path gives (`:610-627`). The prune-specific consecutive-fail counter lives on the
feed (resets on a successful unfollow) so a sparse woven stream still breaks on systematic
failure (an intervening successful *follow* must not reset it — that's the correctness point
of putting the counter on the feed, not the engine loop).

**Scheduled auto-prune → scan-and-enqueue** (`maybeRunScheduledPrune`,
`foundation-wiring.ts:1096-1113`): when `pruneDue(...)` (`:1100`) and idle and soft-in-hours,
run a **scan only** — the census walk is the one remaining place prune drives the tab, so
keep the pause → `awaitParked(PRUNE.PARK_TIMEOUT_MS)` → scan → resume hand-off
(`engine.ts:1053-1072`, `:779`) — then let growth drain the census woven over the following
hours/days. Stamp `pruneLastRunAt` at **scan** completion for cadence, and add a guard: **do
not start a new scheduled scan while the feed still has undrained candidates** (R4), so a
slow drain doesn't trigger a redundant re-walk. Keep the 30-min `prune:auto-watcher`
(`:1082`); it now triggers a scan.

**Manual "aggressive prune" override (throughput vs. safety):** the woven default spreads
unfollows across sessions bounded by the prune daily cap, so clearing a large one-time
backlog takes a while. Retain the old bulk `run()` as an **explicit, user-invoked** override
(the existing Prune "Run" button, relabeled "Prune now (fast)" with a caution note), behind
the `dryRun`/confirm path, for a deliberate one-off cleanup at higher detection risk. The
default and scheduled paths use the woven feed.

§1/§2/§3 hold: the scan still streams every row; `PruneStatus` (`:729-748`) live counts
derive from `feed.pendingCount()`; woven unfollows tick `unfollowed` via `reportOutcome` →
`emitStatus`; `pruneLastRunAt` persists; the snapshot/remainder survive restart via
`consumePruneScanCandidate` (`:713`).

### 6.2 Reads: coupled to sessions, de-fingerprinted

Principle: replace every **externally observable, repeating** wait's flat policy with a
heavy-tailed one; **leave poll-loop beats that gate on a local DOM/response condition** (they
produce no periodic network signature, and jittering them only adds flakiness):
`awaitCaptured` 150 ms (`follow-notifications.ts:279`), the accept verify poll 200 ms
(`:324`), and the Actor's 250 ms `POLL_INTERVAL_MS` (`config.ts:66`). Session-gating comes
for free: enrichment and acquisition are invoked from the Engine refill (`engine.ts:844,855`),
which under §5.1 only runs in an open session — so the rim classes stay pure I/O (no
`isSessionOpen` check inside them). The prune census walk is deliberately **not** session-
gated (it must complete) but its per-page pacing is reshaped.

| Path | Today (file:line) | Change |
|---|---|---|
| enricher inter-fetch | `uniform(2.5–4.5s)` `profile-enricher.ts:208` | `clamp(logNormal(3200, 0.4), 1500, 20_000)` |
| enricher sentinel-skip **(BUG)** | `continue` skips `pace()` `:123-126` | **FIX:** pace, then continue (parity with `:137,149,167,180`). Ship regardless of the flag — pure correctness. |
| list-page-walker per-page | `uniform(1–3s)` `:399` | `clamp(logNormal(1600, 0.45), 700, 12_000)` |
| list-page-walker rest | `uniform(5–15s)` every 7 pages `:400-409` | jitter the *interval*: draw the next-rest-after count from `weibull(~7)` (range ~4–12 pages); rest duration `clamp(logNormal(9000, 0.5), 4000, 45_000)`; the retry backoff `:263` shares it |
| followers-page-reader growth scroll **(worst fingerprint)** | `fixed(2000)` `:171-174` | remove the fixed path; always `clamp(logNormal(2100, 0.4), 900, 9000)`; route the prune-scan path (which passes `scanMin/Max`) through a log-normal derived from those bounds too |
| notifications scroll wait | `fixed(2000)` `:231` | `clamp(logNormal(2200, 0.4), 900, 8000)` |
| notifications close delay | `fixed(800)` `:261` | `clamp(logNormal(900, 0.35), 400, 4000)` |
| notifications accept pace | `uniform(1.5–3s)` `:343` | `clamp(logNormal(2100, 0.4), 900, 9000)` + **add the missing last-item guard** (parity with the enricher's `:206` skip-after-last) |
| follower-acquisition | delegates, no own sleeps | inherits the above |

Every swap keeps the `sample(policy, this.rng)` call shape, so rng injection and determinism
are unchanged; only the imported policy constructor changes.

### 6.3 Fixed-cadence external signals

- **Connectivity probe** (`connectivity.ts:56`, 20 s to gstatic 204, non-IG): jitter it
  cheaply. Add an optional `jitterPolicy` to `ScheduleManager.every` (keeping its overlap
  guard, `schedule-manager.ts:56-78`), and pass `clamp(logNormal(20_000, 0.25), 15_000,
  28_000)`. Non-IG, so low stakes, but it removes a perfectly periodic beacon and the same
  option benefits the watcher.
- **Auto-prune watcher** (30 min, `foundation-wiring.ts:1082`): leave the interval (or apply
  the same optional jitter); it only *triggers* a scan behind due/idle/in-hours gates.
- **Renderer keep-alive** (10 s, `POLL.KEEPALIVE_MS`) and **graph-push throttle** (300 ms,
  `config.ts:146`): internal IPC/UI only, invisible to any external observer — **leave both
  untouched** (consistent with the timing-unification scope: renderer presentational timings
  are out of scope).

### 6.4 `config.ts` registry changes

Remove `PRUNE.DELAY_FACTOR`. Convert the RIM min/max pairs to median/sigma/cap trios
(`ENRICH_PACE_*`, `SCROLL_*`, `LIST_WALK_PAGE_*`, `NOTIFICATIONS_SCROLL_WAIT_MS`,
`NOTIFICATIONS_CLOSE_DELAY_MS`, `ACCEPT_PACE_*`) and turn `LIST_WALK_REST_EVERY` into a
weibull shape/scale for the rest interval. Keep the poll beats, bounds, and caps unchanged
(`POLL_INTERVAL_MS`, `POLL_TIMEOUT_MS`, `NOTIFICATIONS_WAIT_MS`, `NOTIFICATIONS_SCROLL_ROUNDS`,
`REQUEST_ACCEPT_CAP`, `FETCH_ALL_*`, `ACQUIRE_*`, `LIST_WALK_MAX_PAGES`,
`LIST_WALK_STAGNANT_STOP`). Import the new `CIRCADIAN`/`SESSION`/`PATTERN` groups. Per-read
median/sigma stay registry constants (anti-fingerprint internals, not user knobs); only the
user-meaningful knobs go to `settings.ts` (§5.4).

---

## 7. Invariants preserved (CLAUDE.md + docs/PRINCIPLES.md)

- **§1 Facts stream; verdicts wait** — per-item store writes; the scan still streams every
  row; the woven unfollow's ledger row + edge reconcile happen at act time; only the
  candidate set (an absence verdict) gates on a complete walk.
- **§2 UI mirrors the graph live** — mutation-driven throttled pushes; the new
  `EngineStatus.pacing` and `PruneStatus` fields tick live; `nextActionAt`/`nextSessionAt`
  feed the countdown.
- **§3 Schedules are durable** — the planner `pacing_state`, the per-day volume draw, the
  owed inter-action gap, and the prune snapshot all persist and catch up overdue on startup.
- **E1** — every wait is interruptible; pause/stop/offline abort it without losing the owed
  remainder; one-major-thing-per-iteration keeps control instant.
- **Sentinel gate first**; durable ledgers as the single write budget; **only one driver on
  the tab** (the scan keeps its hand-off; woven unfollows run on the Engine's own thread via
  the shared rim, so no second driver is introduced).
- IG literals stay in `src/adapter/versions/*`; operational timing constants in
  `src/timing/config.ts`; user knobs in `src/settings/settings.ts`. **Injected clock + rng
  everywhere** — the whole model is deterministically testable.

---

## 8. Statistical validation harness (the acceptance test)

`tests/timing/macro-pattern.test.ts` (plus a runnable `scripts/timing-sim.ts` behind
`npm run timing:sim`):

1. Wire the real `SessionPlanner` + a headless Engine, `FakeClock`, fake IG ports (every
   action/read resolves instantly and records `clock.now()`), a fake store, and a seeded rng.
2. Fast-forward **30 simulated days** by advancing `FakeClock` to each
   `DelayManager.nextDeadline()` (`delay-manager.ts:132-139`) — deterministic, zero
   wall-clock.
3. Emit the timeline `(epoch, kind)` and assert:
   - inter-event log-histogram is **bimodal** — a within-session mode ~45 s–3 min and a
     between-session mode ~1–12 h with a valley between (reject a single-Poisson fit);
   - **heavy tail:** ≥ 5% of gaps exceed 10× the median (impossible for uniform±jitter);
   - **circadian match:** hour-of-day histogram vs `intensityAt` Pearson r > 0.85; < 1.5% of
     actions in 03:00–05:00;
   - **volume:** realized mean daily actions within ~15% of the configured mean (rest days
     intentionally pull the realized mean a little below the per-active-day target); per-day
     CV ∈ [0.2, 0.5]; ≥ 1 rest-ish day in 30; never exactly constant;
   - **velocity safety:** no rolling 60-min window exceeds `MAX_ACTIONS_PER_ROLLING_HOUR`
     (the established-account cap); no account-visible gap below `GAP_FLOOR_MS`;
   - **no correlated unfollow burst:** no session exceeds `maxUnfollowFractionPerSession`
     unfollows, and no rolling-hour unfollow count exceeds the velocity cap. (No aggregate
     follow:unfollow ratio is asserted — the churn lifecycle legitimately runs ~1:1; §10 R1.)
   - **high inter-arrival entropy (anti-regularity):** the Shannon entropy of the log-binned
     inter-event distribution must exceed a human-comparable threshold and must be
     dramatically higher than a `legacy`-model run over the same window — directly countering
     the low-entropy signature bots are flagged by (Sci Rep 2022; Gianvecchio USENIX 2008);
   - **no periodicity:** the autocorrelation (and FFT) of the binned event-count series shows
     **no dominant period** — no spectral spike at any fixed interval (the "fixed-timer"
     signature); assert the peak non-zero-lag autocorrelation stays below a small threshold;
4. **Eyeball:** the harness prints an ASCII inter-event log-histogram and a 24-hour bar to
   stdout, and runs a `legacy` pass alongside for side-by-side comparison. CI asserts the
   numbers; humans read the shape. This is the empirical contract that fails loudly if a
   future parameter edit flattens the distribution back toward a fingerprint.

---

## 9. Rollout, feature flag, verification

`settings.pacingModel: 'legacy' | 'organic'` (default `'legacy'` until validated), plumbed
like `dryRun` (`settings.ts:131`) and read through the runtime-swap paths (`engine.ts:383`,
`rate-governor.ts:27`, `prune-engine.ts:372`) so it flips live with no restart. `dryRun`
stays independent, so `organic` can be exercised end-to-end without touching the account.

Build order (each phase green on the full matrix before the next):

1. **Core (A):** `distributions` + `circadian` + `session-planner` + the config groups +
   their unit tests. No behavior change — nothing consumes them yet.
2. **Engine (B):** the session-driven loop, soft caps/hours, governor, and settings, behind
   `pacingModel:'organic'`; the legacy path stays intact.
3. **Prune weave (C-1):** `EngineUnfollowFeed` + the scan/run split + scheduled scan-and-
   enqueue + the manual override; run the §8 harness with prune enabled.
4. **Reads (C-2):** swap the read policies; **ship the enricher sentinel-skip bug fix now,
   regardless of the flag** (pure correctness).
5. **De-fingerprint (C-3):** the `ScheduleManager.every` jitter option + connectivity/watcher.
6. **Settings revamp (§5.6):** `pattern-map.ts` + `persona`/`pattern` storage + backward-compat
   mapping + the qualitative `PersonaCard`/`PatternCard`, the Advanced panel, and the live
   `PatternPreviewCard` (reusing the §8 sim). Depends on Part A (planner, for the preview) and
   Part B (`toPacingConfig`). Ship behind the same flow; the preview's "looks-human" chip reuses
   the §8 entropy/periodicity checks.
7. **Validate & flip:** run `timing:sim` for 30 simulated days on `organic` vs `legacy`,
   confirm the §8 assertions, then default `pacingModel` to `organic`. **Fallback:** flip to
   `legacy`; legacy constants and policies stay in the tree until `organic` has run clean over
   a sustained live period.

**Verification each phase (CLAUDE.md):** `npx jest` · `npx tsc --noEmit` · `npm run lint`
(`biome lint src`) · `npm run build:dev`. The DOM-level read-pacing phase (C-2 scroll/
notifications) additionally needs `npm run livetest` against a real session — the pure-sim
harness cannot catch a broken selector, so keep both.

---

## 10. Risks & decisions for the executor

- **R1 — No aggregate follow:unfollow ratio cap (deliberate).** Do **not** add one. Epo's
  core operation is a follow→wait-for-followback→unfollow churn engine (`churn-scheduler.ts`),
  so it legitimately unfollows a large fraction of the accounts it follows — the natural
  lifetime ratio is ~1:1–2:1. A 10:1-style floor would backlog unfollows indefinitely (25
  follows/day vs ~2.5 unfollows/day), stall the lifecycle, and inflate the following count.
  The detection signal such a heuristic proxies for is *temporal batch correlation*, which is
  defeated by spreading unfollows across sessions over time (the weave) plus the velocity/
  session model — not by a ratio. The only mix control is the soft per-session
  `MAX_UNFOLLOW_FRACTION_PER_SESSION`.
- **R2 — Velocity is guarded twice on purpose** (planner ring + engine ledger), on one
  constant; keep both.
- **R3 — Reads run faster than the action floor** and are session-gated + stamped for
  velocity, but do not spend `dailyTarget` and are not bound by the ≥45 s account-action
  floor.
- **R4 — "Clean list" vs. slow drain:** `pruneLastRunAt` = scan time for cadence, but a
  non-empty feed blocks a new scheduled scan so a slow drain doesn't re-walk both lists.
- **R5 — Session-gated reads must not starve refill:** a session's first refill may precede
  its first action; `isSessionOpen` must be true for the whole session including its refill
  prologue (refill already precedes actions in `step()`, `engine.ts:652-703`).
- **R6 — Stale comments to update:** the 4 h sweep notes (`engine.ts:232`,
  `foundation-wiring.ts:1410`), the §3.1 doc block, and the CadenceCard copy ("once per
  session" semantics).
- **R7 — Renderer follow-through:** the status-consuming pieces (`engine-view.ts`,
  `LiveStatusCard`, `RateSafetyCard`, `useCountdown`, Prune panel copy, "Prune now (fast)")
  ride the Part B/C status changes; the **settings-page revamp is its own phase (§5.6,
  rollout phase 6)** — new `PersonaCard`/`PatternCard`/`PatternPreviewCard`, the `pattern-map`
  layer, and the Advanced panel. Keep both in the Command Console design system (`tokens.css`,
  `useSettingsDraft` autosave); no number inputs on the primary surface.
- **R9 — Preview must match reality:** the `PatternPreviewCard` and the main-process config
  path must call the **same** `resolvePattern()` + `SessionPlanner`, or the preview lies. This
  is the reason the mapping and the planner are pure and renderer-safe.
- **R8 — Line-number drift:** every `file:line` here is a 2026-08-15 anchor; grep to confirm
  before editing.

---

## References

- Barabási, "The origin of bursts and heavy tails in human dynamics," *Nature* 435 (2005).
  https://www.nature.com/articles/nature03459
- Vázquez et al., "Evidence for a bimodal distribution in human communication," *PNAS* (2010).
  https://www.pnas.org/doi/10.1073/pnas.1013140107
- Jiang et al., "User Session Identification Based on Strong Regularities in Inter-activity
  Time," *WWW* 2015. https://arxiv.org/pdf/1411.2878
- "A Tutorial on Hawkes Processes for Events in Social Media."
  https://www.researchgate.net/publication/319235671
- Diurnal–weekly activity field / circadian social-media rhythm (peak ~16:00–18:00, trough
  ~04:00–06:00). https://link.springer.com/article/10.1140/epjds/s13688-026-00624-7
- Weibull dwell / log-normal inter-request web-session modeling.
  https://arxiv.org/pdf/1712.05813
- Blasius, "Are human interactivity times lognormal?" (2016) — log-normal fit for
  interactivity times. https://arxiv.org/pdf/1607.02952
- Power-law inter-event exponents (email ≈ 1.0, web browsing ≈ 1.2; range 1–2).
  https://arxiv.org/pdf/0903.2999 · https://arxiv.org/pdf/physics/0510117
- 30-minute session boundary pedigree (Catledge & Pitkow 1995; GA4 default session timeout).
  https://www.ringside.ai/articles/30-minute-sessions/ ·
  https://support.google.com/analytics/answer/12798876
- Hawkes branching ratio / sub-criticality (n < 1) and exponential-kernel n = α·τ.
  https://arxiv.org/pdf/1708.06401 · https://arxiv.org/pdf/1403.5227
- Bot detection by timing regularity / low inter-arrival entropy / periodicity.
  Gianvecchio & Wang, "Measurement and Classification of Humans and Bots in Internet Chat,"
  USENIX Security 2008. https://www.usenix.org/legacy/event/sec08/tech/full_papers/gianvecchio/gianvecchio_html/ ·
  "DNA-influenced automated behavior detection on Twitter through relative entropy," *Sci Rep*
  2022. https://www.nature.com/articles/s41598-022-11854-w
- Multi-peak diurnal + weekly seasonality (morning/lunch/evening peaks; weekday vs weekend).
  https://www.researchgate.net/publication/287072856 ·
  https://www.metricswatch.com/blog/peak-engagement-times-social-media-platforms-compared
- Instagram established-account limits (~150–200 follows/day, ~20–30 follows/hour) and
  velocity-based detection (2026). https://smtasker.com/automate-instagram-engagement-without-ban/ ·
  https://www.socialchamp.com/blog/instagram-limits/
