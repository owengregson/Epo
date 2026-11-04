# Plan-derived overhaul — master design

**Date:** 2026-11-02 · **Branch:** `feat/plan-derived-overhaul` @ `f5e7e50` · **Checkpoint:** `refs/backups/pre-plan-overhaul-2026-11-02`
**Status:** revision 2, accepted for implementation. Revision 2 answers the integration critique (owner coverage,
safety and correctness, implementability); §25 records the points where the critique was adopted in a different form,
with the code evidence. Owner questions in §18 carry the defaults this design adopts; the ones marked ● change visible
behaviour and are answered **before Phase P starts** (workplan gate G0). **G0 is closed: §18.3 records every answer and
wins over any conflicting sentence in §1–§24 and the appendices** (two defaults were reversed: Q5 Boost and Q28 the
"Prune" label).
**Companion:** `docs/superpowers/plans/2026-11-02-plan-derived-overhaul-workplan.md` (streams, ownership, order).

**Authority.** This document is normative and self-sufficient. It synthesizes five topic designs (T1 DayPlan & tempo,
T2 Settings & protection, T3 live sidebar / refresh / boot, T4 parse resilience, T5 reopen reconciliation) and twelve
research reports (U01–U12). Where they disagree, §14 decides and this document wins. The full contracts and copy decks
the topic designs held are folded into **Appendices A–E** (normative, reconciled with §1–§24, scrubbed of
account-specific evidence); the topic designs themselves are optional, non-normative background that no agent needs.
Every decision is labelled:

- **[owner]** stated in the owner's brief (2026-11-02);
- **[lead]** the lead engineer's call, adopted;
- **[arch]** decided here by the integration architect, with the code evidence that forced it (**[arch r2]** = added
  or changed in revision 2).

`path:line` citations refer to `f5e7e50`.

---

## Contents

1. Intent and why
2. Goals, non-goals, anti-goals
3. Axioms and where they bind
4. Architecture: the picture, single writers, durability homes, the one plan-day boundary
5. The DayPlan and the tempo (item 1)
6. Settings v2: Easy and Advanced (items 2, 3)
7. Protection on every unfollow path (item 6)
8. Explore Boost (item 7)
9. Reopen reconciliation: read only what changed, decide at the act (item 8)
10. Parse resilience (item 4)
11. The unfollow confirm fix (item 5)
12. Live sidebar, Settings stage, visual refresh, launch (items 2, 9)
13. No stale state on reopen (item 10)
14. Cross-topic contradictions, resolved
15. Contracts: IPC, pushes, projections, guards, status fields
16. Data and migrations
17. The constants disposition table (nothing left hardcoded)
18. Decisions register and owner questions
19. ADRs to write and amendments
20. Test strategy and laws
21. Risks
22. The minimal live-test plan
23. Defect register
24. Glossary
- Appendix A — DayPlan, tempo, cadence and Boost contracts (from T1 §4)
- Appendix B — Settings and protection contracts, Settings copy (from T2 §13, §18)
- Appendix C — Sidebar, boot, stage, feed contracts and copy (from T3 §10, §15)
- Appendix D — Parse-resilience contracts, guard lines and copy (from T4 §11, §16)
- Appendix E — Reopen contracts and copy (from T5 §4, §10)
25. Review notes (revision 2)

---

## 1. Intent and why

| # | Owner intent | What is wrong today (root cause) | Solved in |
|---|---|---|---|
| 1 | **No static values.** Everything (mouse movements, delays, pauses, waits between actions and between individual movements inside an action) derives from the dynamic **daily plan**. | Three uncoordinated "plans" with three day boundaries (midnight `SessionPlanner`, 08:00 `RateGovernor`, rolling-24 h `ReadBudget`). The real inter-action spacing is `max(legacy 3–7 min metronome, planner gap)` (`mutation-policy.ts:64-65`, `engine.ts:656-657`). 119 frozen registry keys, 61 `MOTION` keys and dozens of raw literals are consumed as module constants. Status reads mutate the planner (`status-projection.ts:13-23` → `sync()`). | §5, §17 |
| 2 | **Sidebar = live only.** All settings move to a **Settings** tab in the top bar beside Graph, Prune, Live. | The sidebar hosts four views including seven settings cards; Settings is always mounted (and fires a hidden live seed check at launch). | §6, §12 |
| 3 | **Easy + Advanced settings** from first principles: few controls, plain language, no timings in Easy; Advanced exposes every value. | One flat 49-key object mixing intent, 14 derived numbers that are silently re-derived on every save, and bookkeeping stamps; failed saves report success. | §6 |
| 4 | **Parse resilience:** small API changes still parse. | The legacy extractors decide while the zod document is shadow-only; `=== true` reads turn an absent key into `false` (which flips held records to `external`); a missing cursor is an end claim even with `has_more:true`; bare `JSON.parse`. | §10 |
| 5 | **Unfollow confirm pop-up** must not hang. | The Actor assumes exactly one confirm press. Private accounts show a second dialog (Variant P). A `Requested` header re-runs admission at the confirm press and throws (Variant R, the 2026-11-02 18:30 production incident). | §11 |
| 6 | **Protection list = all unfollows.** | The whitelist reaches only the prune paths; bio words protect follow-backs only; click-time deferrals retry the same head forever. | §7 |
| 7 | **Explore Boost**, 12 h default, endable, durable. | No concept exists; the operating-rate gate and the return reconciliation would starve it. | §8 |
| 8 | **Recovery on reopen** reads only what changed since the last action. | Hard-coded 1 h / 1 d / 10 × 3 min reentry literals; a DST or timezone change forces a full census; due-record pre-reads wedge the queue; counts are dated at detection. | §9 |
| 9 | **UI refresh:** friendlier, larger, more spacing, more motion that explains change, a launch animation into a fully preloaded app. | 8.5–12 px type; `--faint` fails WCAG on every surface; counts roll up from zero at boot; a possible white first frame; IPC registers after the page starts loading. | §12 |
| 10 | **No stale state on reopen** ("the target profile is not available anymore"). | A hidden mount-time seed check is refused by a busy runtime, typed `exists:false`, rendered as "not found", and never re-validated. | §13 |
| 11 | Great attention to detail; parallel worktree implementation; live tests are scarce. | — | workplan; §22 |

---

## 2. Goals, non-goals, anti-goals

**Goals (each has a test or a live check):**

| Id | Goal | Proof |
|---|---|---|
| G1 | Every Instagram-facing wait anywhere in `src` outside `src/kernel` and `src/renderer` resolves through one `TempoSource`, an exact plan park or a D4 deadline; no numeric literal and no `Math.random` survives outside them unless allow-listed with a reason (geometry, protocol, harness). | `tests/tooling/no-static-timing.test.ts` (every numeric literal in every syntactic position, prior-key property access, the `Math.random` ban) with an allow-list holding only GEOM/harness entries after Phase I |
| G2 | One `DayPlan` per account per plan-day; reading it never writes. | `plan-service.test.ts` (10 000 random reads, store spy); `status-plan.test.ts` |
| G3 | Rate-neutral at Standard (in-session ≈ 11.8/h vs legacy 12.0/h); caution sets density (Cautious ≈ 7.5/h, Bold ≈ 16.2/h). | integration I1 (red against the pre-switch build, green after), law L2 |
| G10 | **No automatic day exceeds today's maximum** `automaticDayMax(P0)` (the supremum of today's `cyclePlan`, ≈ 0.97·P0: 48 at P0 = 50); the day-volume law equals today's realized law; `M − V` is headroom for manual actions and outside residuals only. [arch r2] | laws L1, L6; integration I1 and I11 assert every simulated day's automatic total ≤ `automaticDayMax(P0)` |
| G4 | No protected account is unfollowed on any path; no head-of-line starvation; at most one visit per unreadable record per re-check window. | engine properties §20 (P-PROT-1…5) |
| G5 | Boost reallocates inside the day's ceilings and survives restart, offline and clock changes. | law L13; integration I9 |
| G6 | A typical reopen reads the landing, one drawer pass and 0–2 composed list pages, with zero third-party profile visits before Start. | law L12 (launch passivity); live L4 |
| G7 | No digit renders from a not-built projection; "not found" only with evidence. | law L-ZERO; seed-field tests |
| G8 | `npm run check` green on every commit; boundaries 0 errors; warnings ≤ 100 from F1a step 0 on (147 today; removing the `tab-ports → @/types` hub edge drops `no-circular` 54 → 8 and one orphan) and never growing after. | CI; per-commit counts in commit bodies |
| G9 | Each live step passes on its first run; the only live mutations are the plan's own. | §22 |

**Non-goals** (explicitly out of this overhaul):

- Per-account settings. One global document; per-account run state lives in each account's store.
- Adaptive re-estimation of latency seeds from `SurfaceMeter` (wave B). Seeds stay; the meter is persisted.
- Chronos as a production consumer. The plan and Boost are values in `meta`, not timers.
- A per-install "device persona" for wheel notch size and peak speed (T1 P5; optional follow-up).
- Request-body capture in `tab.ts` (T4 S7 / Q4; optional, last, needs an ADR 1007 amendment).
- Deleting the legacy extractors (T4 S8) before the L1 and L4 evidence exists.
- A "Check now" button (T5 Q10).
- Changing the sidebar width (460) or stage-bar height (44): Instagram's breakpoints at other widths are unmeasured.
- Renaming golden-pinned kernel keys (for example the existing `EMPIRICAL.HUMAN_*` names). New names follow the
  neutral vocabulary.

**Anti-goals** (must never happen; reviewers reject on sight):

- Raising any ceiling, wall-derived limit or read total for convenience (Boost, settings overrides, census sizing);
  an automatic day above `automaticDayMax(P0)`; a settings override that makes an Instagram-facing wait shorter than
  the plan's own briskest draw or a read total larger than the derived one.
- Composing a request Instagram's web client does not make.
- A silent catch; a drifted body turned into an empty list or a `false`; a destructive verdict from a recovered or
  partial read.
- A keep-running patch (alarm, early stop, fallback) in place of a root-cause fix.
- Removing or weakening any background-run survival layer (CDP input chain, the three anti-throttling switches,
  `backgroundThrottling:false`, focus emulation, `powerSaveBlocker`, re-stack concealment).
- Editing the golden snapshot. Retirements go through the `RETIRED` ledger (§5.12).
- Seeding cursor-path micro-noise from the plan (a restart would replay identical paths).
- Any third-party profile visit before the user presses Start.
- "bot", "human", "emulate", "stealth", "mimic", "spoof", "detect", "natural" in new names, comments or copy
  (existing kernel keys such as the consistency ordinal `natural` stay internal and never surface in copy).

---

## 3. Axioms and where they bind

| Axiom | Statement (short) | Bound by |
|---|---|---|
| A1 | One `DayPlan` per account per plan-day, drawn by one writer (`PlanService`) from live Settings intent, kernel fundamentals × dials, Boost state and a counter-seeded rng; persisted; immutable except by named re-plan events; exposed read-only. One plan-day boundary for every counter. | §5; `plan-service.test.ts`, `plan-determinism.test.ts`, I4 |
| A2 | Every Instagram-facing timing is drawn from a spec whose parameters are functions of the plan / session tempo. | §5.8–5.10; `no-static-timing.test.ts`; tempo-identity golden |
| A3 | Static values live only in `src/kernel` with provenance: measured fundamentals, owner dials, guardrail bounds with a guard line, geometry/protocol. They are inputs to the plan. | §17; `fundamentals.test.ts`; guard-line structural tests |
| A4 | Ceilings never rise for convenience. Boost reallocates inside them. | §8; law L13; envelope law (§6.3) |
| A5 | Facts stream; verdicts wait; the UI mirrors the graph live; schedules are durable; no silent catches; drift is `SHAPE_MISMATCH`; IG literals only in `versions/*`; no composed requests the client doesn't make; neutral naming; root-cause fixes; survival layers load-bearing; account safety. | every section; §20 |
| A6 | `npm run check` green; 300-line budget (split first); boundaries 0 errors, warnings must not grow (147 today; re-baselined to 100 by F1a step 0, then never growing); kernel imports nothing from `src`; the renderer never imports `@/kernel` or `settings.ts`; rejected libraries stay rejected. | workplan Phase F; §20 |

**Narrow, argued deviations** ([arch]; 1–2 inherited from the topic designs, 3–4 added in revision 2):

1. **Renderer presentation constants** (animation durations, splash dwell, caption delays) cannot live in the kernel:
   renderer → `@/kernel` is a dependency-cruiser **error** (`.dependency-cruiser.mjs:85-93`). They live in
   `src/renderer/design/motion-scale.ts` as a rule over `PERCEPTION_MS = 100`, and a test pins that constant to
   `EMPIRICAL.DISPLAY.perceptionMs`. None of them touches Instagram (A2's scope).
2. **`src/main/window/shell.ts`** gets additive options whose defaults equal today's behaviour (§12.6). Wrapping cannot
   set `show:false` (a constructor option) or move the dashboard load after IPC registration. Recorded as an ADR 1007
   amendment. Stacking order, `TabPlacement`, `backgroundThrottling` and the frame-rate switch are untouched.
3. **A trailing-24 h backstop on the read allowance** (refines A1 "one plan-day boundary for every counter"). The
   plan-day stays the accounting and reset boundary of D6, and a trailing 24 h window equal to the D6 totals backs it,
   exactly as the rolling hour backs the hourly cap. Evidence: today's allowance is a trailing window (debits expire at
   `at + 24 h`, `resumeAt` = oldest debit + 24 h, `read-budget.ts:29-30,49-55`), which guarantees that no 24 h span
   exceeds D6; a reset at the boundary alone would let reads that run at any hour (launch catch-up, a manual cleanup
   run, a seed check) spend ≈ 2 × D6 within an hour around the quiet minute. It is a rate backstop, not a second day.
4. **Path-shape motion dials stay static** (A2/A3, owner item 1 "mouse movements"). The plan sets how fast and how
   accurately a gesture moves: durations scale with the session's `motion` factor and the speed–accuracy keys
   (overshoot, aim scatter) co-vary with it (§5.11). The keys that describe the *geometry* of a path (gravity, wind,
   momentum, step memories, wheel shape) are declared POLICY dials in `src/kernel/motion-roles.ts`, each with a guard
   line and provenance, listed in Advanced → Under the hood. Varying path geometry per day would change nothing the
   plan controls (speed and pauses) and would only add an unmeasured second source of variation (owner Q42).

---

## 4. Architecture

### 4.1 The picture

```
            ┌──────────────── Settings v2 · one global document · SettingsService (single writer) ───────────────┐
            │ intent (plain choices) · overrides {value, basis} · protection · prefs (practice, accepts, boost) · app │
            └────────┬──────────────────────────────┬───────────────────────────────┬────────────────────────────┘
       EffectiveSettings (live provider)     ProtectionIndex (live)            push epo:settings (SettingsView)
                     │ toPlanIntent()                │
 EMPIRICAL × POLICY  ▼                               │
 × BOUNDS ──▶ ┌──────────────────────────────┐       │
 counter rng  │ PlanService (single writer of │◀── re-plan events: day edge · settings digest · census done ·
 Boost window │ meta.plan_state, per account) │    Boost start/end · clock jump · repair
              │ drawDayPlan() → DayPlan       │
              │ view(now)  PURE → PlanView    │──▶ status.plan / status.boost (rides the throttled status push)
              └───┬───────────────┬───────────┘
          TempoSource         PlanFacts · Admission (session, kind budgets, reads, parks, checkDue, light, probation)
     (pace · motion · depth)          │
   interaction ◀──┤                   ▼
   adapter waits ◀┤      engine rules ─▶ effects ─▶ MutationCadence.preflight (BEFORE any visit)
   rim waits ◀────┘                                   ─▶ click review (protection · journal · verify-at-act)
                                                      ─▶ Actor (confirm-layer loop) ─▶ MutationWatch ─▶ armAtDispatch
                                                         (the plan's GapSpec deadline, persisted)
   FrontierSweep (launch · session · check) ── per-item store writes ── KnowledgeStore.onMutation ── projections push
   SurfaceRead pipeline (tiers C0/C1/C2, presence-gated) ── surface_health / surface_drift ── status.surface
```

### 4.2 Single writers

| State | Only writer | Readers |
|---|---|---|
| `meta.plan_state` (plan, phase offset, Boost window, upgrade-probation flag) | `PlanService.ensure/startBoost/endBoost` | `PlanService.view` (pure), status, engine facts, Settings previews |
| `epo-settings-v2.json` (+ `.bak`, the `epo-settings-v2.created` marker) | `SettingsService.apply(ops, origin)` | `effective()`, `protection()`, `view()` |
| `census.lastCompleteAt` (the last verified-complete census, existing census repo) | the census walk, on completion only | `censusDue` (§5.8.3), the cleanup feed |
| `meta.reopen_state` | `FrontierSweep` (per step, after the step's facts commit) | sweep planner, status, `PlanView.checkDue` anchor |
| `follow_records.state = 'kept'` and the review columns | `ProtectionReconciler`, churn's `applyClickVerdict` | churn selection, projections |
| `effect_intents` (journal) | `MutationCadence` (prepare/dispatch), journal settlement | admission gate, tallies |
| `surface_drift`, `surface_health`, `meta.surface_meter` | production `SurfaceSink` | `SurfaceReport`, `SurfaceGate` |
| Stage (which view covers the IG tab) | `StageController.set` | shell, title, Dock badge |
| Run intent (`epo-runtime.json`) | `RuntimeCoordinator` (unchanged, ADR 0210) | boot sequence |

### 4.3 Durability homes

| Data | Home | Scope | Why there |
|---|---|---|---|
| Intent, overrides, protection lists and rules, prefs (practice, accept requests, Boost defaults), app (mode, tour) | `userData/epo-settings-v2.json` (+ `.bak`); v1 `epo-settings.json` is never written again | install | configuration; survives clear-data; older builds keep reading v1 |
| DayPlan, phase offset, Boost window, upgrade-probation flag | meta `plan_state` | account | run state of one account; PRINCIPLES §3 (edges evaluated at launch) |
| Feed watermark, followers-head frontier, requests snapshot, last sweep, last catch-up summary | meta `reopen_state` | account | cursors, not timers |
| Action deadline | meta `action_delay_deadline_at` (existing) | account | — |
| Read debits | meta `read_budget_state` v1 (+ optional `use` tag) | account | downgrade-safe |
| Surface latency reservoir | meta `surface_meter` | account | — |
| Kept / park / journal-attempt state | columns on `follow_records`, `effect_intents` (migration 14) | account | per record |
| Follower change log, own header series | tables `follower_changes`, `own_counts` (migration 15) | account | dated accounting |
| Drift signatures, per-plan-day health | tables `surface_drift`, `surface_health` (migration 16) | account | history with retention |
| Run intent | `epo-runtime.json` (existing) | install | ADR 0210 |

Rejected homes: Settings JSON for run state (reset would wipe it; global, not per account); Chronos (no production
consumer yet; a plan is a value, not a timer); a "last-known snapshot" file (a second source of truth).

### 4.4 One plan-day boundary for every counter [owner A1; arch for the quiet-hours rule]

- **Definition.** `quietMinute(shape, phase, quietHours)` = the argmin, on a 1-minute local grid, of the weekday
  intensity `λ(t)` multiplied by the quiet-hours mask (0 inside quiet hours, 1 outside). Ties (every minute inside the
  quiet window is 0) break to the **centre of the longest minimal run**. With "No quiet hours" this is T1's trough
  (balanced ≈ 03:12; night owl ≈ 06:15). With the derived quiet window (§6.2) it is the window's centre (balanced
  ≈ 02:45). Days off never move the boundary (computed on a non-day-off weekday curve).
- **Window.** `planDayWindow(now, qm)` = the most recent local instant at `qm` (via `setHours`, DST-safe) up to the
  next one: 23, 24 or 25 h. The key is the local date the window starts on.
- **Every day counter uses it:** hard ceiling `M`, plan usage and remaining volume, the D6 read allowance window
  (plus its trailing-24 h backstop, §3 deviation 3), evidence freshness, cleanup budget, park targets, revisit and
  freshness windows (§5.16), "today" in the sidebar, the feed's day groups, the 7-day spark buckets, outside-activity
  charging, `surface_health` day keys, the protection reconciler's day-roll. The hourly velocity window stays a rolling
  60 min (it is an hour window, not a day counter). The People page growth chart keeps calendar days, labelled.
- **One provider.** Every consumer reads the boundary through the `PlanDayClock` port (`window(t)`, `dayKey(t)`,
  `onRoll(fn)`; defined in Phase F with a local-midnight default, swapped for the plan-backed clock at one site,
  `plan-wiring.ts`, when the plan service lands). No stream computes a day boundary of its own.
- **Shape change.** The current window keeps `[S, E)`; the next one is `transitionDay(E, newQm)`, running from `E` to
  the first `newQm` ≥ 12 h after `E` (12–36 h). When a transition window is shorter than 23 h, **every** day counter
  (`V`, `automaticDayMax`, `M`, the D6 totals, the cleanup budget) is prorated by length/24 h; a longer window never
  enlarges them. DST windows (23/25 h) are not transitions and keep full counters.
- **Time zone / travel.** Only future boundaries move; absolute instants (deadlines, Boost end) are epoch ms.
- **Retired:** the 08:00 `RateGovernor` cycle (`rate-governor.ts:43-63`), the midnight planner day, the rolling-24 h
  read window as the reset boundary (it survives only as the backstop), `activeHoursStart/End`.

---

## 5. The DayPlan and the tempo (item 1)

Source: T1 FINAL, amended by T2 (quiet hours, days off, overrides) and T5 (probation, check anchor, census sizing,
verify-at-act). This section is the contract; the T1 design holds the derivations and scratch evidence.

### 5.1 Model and writer [owner A1]

- `drawDayPlan(input)` is pure and deterministic (`src/kernel/plan/draw.ts`).
- `PlanService` (`src/governors/plan-service.ts`) is the **only** writer of `meta.plan_state`. `ensure(now)` writes
  only on a §5.6 re-plan cause.
- Every reader calls `PlanService.view(now)`: a **pure** function of the persisted plan, the ledger tally, read debits,
  the clock and Boost. No session-open/close/used fields exist in storage; session status is derived. This removes the
  write-on-read bug class (`status-projection.ts:13-23` today calls five `sync()`-running planner methods).

### 5.2 Seeding [owner A1; T1 D3]

- `seed = (installEntropy ⊕ fnv1a('epo-plan|' + dayKey)) >>> 0`. Never `Math.random`: the only true-random call
  outside the renderer is the entropy root `src/utils/entropy.ts` (`node:crypto`), used once to draw
  `installEntropy` (persisted) and for span ids; everything else is a seeded stream (§20.4 scan, all of `src` except
  the renderer).
- `mulberry32` and `fnv1a` live in `src/kernel/rng.ts` (Phase F; today only `src/timing/noise.ts:51,62`, which the
  kernel may not import); `timing/noise.ts` re-exports them.
- Counter-based draws: `u(seed, ...coords)` = one `mulberry32(seed ^ fnv1a(coords.join('|')))()` step mapped to (0, 1);
  `z = Φ⁻¹(u)` (Acklam). Day coordinates: `('volume')`, `('volume-band')`, `('volume-rest')`, `('sessions')`,
  `('budget', s)`, `('start', s)`, `('tempo-day')`, `('tempo', s)`, `('mix', s, k)`, `('gap', s, k, attempt)`.
- **The phase offset is install-seeded, never day-seeded** [arch r2]: `u(installEntropy, 'phase')`. The day key
  depends on the quiet minute, which depends on the phase, so a day-seeded phase would be circular, and a repair would
  re-draw it from another day's seed and move the current window.
- Properties: order-independent (adding a draw site shifts no other); a lost `plan_state` re-derives the identical ideal
  plan (repair is an identity for the current window); A → B → A settings restores plan(A) exactly (common random
  numbers); the gap draw at `('gap', s, k)` with k = the session's dispatched count is restart-stable.
- **Micro-noise is not plan-seeded** [arch, from T1 with code evidence: the Interactor is rebuilt every graph build,
  `graph-builder.ts:101-104`, so plan-seeded motion would replay identical cursor paths after a restart]. Each tempo
  key draws from its own stream `mulberry32(fnv1a(key) ^ launchSeed)`, `launchSeed = installEntropy ⊕ (launch ms &
  0xffffffff)`. A1's seeding governs the plan; micro-noise only follows the plan's *parameters*.

### 5.3 Inputs

`PlanIntent` comes from live `EffectiveSettings` (§6) through `src/settings/plan-intent.ts` `toPlanIntent(e)` (the
`read-allowance.ts` bridge pattern). The kernel never sees Settings.

```ts
export interface PlanIntent {
  readonly operatingRate: number;        // P0 = D1 dailyPlan(activity) (or the pace.dailyVolume override); the day's target, never exceeded automatically
  readonly hardCeiling: number;          // M — headroom for manual actions and outside residuals only (never a volume target)
  readonly hourlyCap: number;            // H
  readonly probationHourlyCap: number;   // H one caution rung down (Bold→22, Standard→14, Cautious→round(14·0.64)=9)
  readonly unfollowHourlyCap: number;    // round(UNFOLLOW_WALL_PER_HOUR.typical · SAFETY_MARGIN · k_caution) (law L3)
  readonly sessions: { readonly min: number; readonly max: number };
  readonly gap: GapShape;                // the rhythm/caution reference shape at time-scale 1
  readonly gapTargetOverrideMs: number | null;   // sessions.gapTypical (effective scale, slower only), else null
  readonly gapFloorOverrideMs: number | null;    // sessions.gapMinimum (effective scale, slower only), else null
  readonly volumeSigma: number;          // dayVariation / 100
  readonly restDayProbability: number;
  readonly consistencyScale: number;     // SCALES.consistency[k]
  readonly cleanupShare: number;         // PREFERENCES.cleanup[level].fraction / max fraction → 0 · .36 · .71 (1.0 retired with 'deep')
  readonly cleanupPerDayCap: number | null;   // the unfollow.cleanupPerDay override (lowering only), else null
  readonly patienceWaitMs: number;       // census freshness (unfollow.censusEveryDays override when set)
  readonly checkSpacingOverrideMs: number | null;   // checks.everyHours (slower only: ≥ the briskest derived spacing), else null
  readonly acceptRequests: boolean;      // prefs.acceptRequests (the accept budget is 0 when off)
  readonly shape: CircadianShape;        // dayShape × weeklyShape
  readonly quietHours: { readonly startMinute: number; readonly endMinute: number } | null;   // resolved (§6.2)
  readonly daysOff: readonly DayOfWeek[];                                                      // Sun..Sat, at most 6
  readonly tempoOverrides: Readonly<Partial<Record<TempoKey, number>>>;   // reference factors ∈ [1, 3] (slower only)
  readonly planBuffer: number;           // POLICY.PLAN_BUFFER (explore sizing)
}
```

- `PlanDemand` is a store snapshot built in `plan-wiring.ts` and recorded in the plan for audit:
  `lifecycleDueByDayEnd, lifecycleBacklog, pruneStock, protectedReeval, journalPending, followsDoneToday,
  outsideToday, pendingRequests, acceptsRecent (mean accepts per plan-day over the trailing 7), ownHeader{followers,
  following}, census{lastCompleteAt, rowsPerPage}`. (`evidenceDueByDayEnd` is dropped: verify-at-act, §9.7.)
- The phase offset is migrated once from `pacing_state.phaseOffsetHours`, else `(2u(installEntropy, 'phase') − 1) ×
  PHASE_JITTER_MAX_HOURS` (§5.2).
- The intent digest is FNV-1a over canonical JSON of `PlanIntent`. Bookkeeping never re-plans.

### 5.4 The draw (in order)

1. **Day mask.** If the window's weekday ∈ `daysOff`: `V = 0`, binding `day-off`, no sessions (stop).
2. **Volume — today's law, drawn once per plan-day** [arch r2; G10]. Today every mutation (growth, woven and run prune
   through the shared `beforeMutation`, accepts through `canAccept`, manual actions) is refused once `actionsToday`
   reaches `cyclePlan(P0)` = `round(P0 · U[0.85, 0.97))` capped at `P0 − 1` (`cycle-plan.ts:16-24`,
   `mutation-policy.ts:44-45,60,102-105`, `rate-governor.ts:84-113`), so the realized day is
   `min(planner volume, cyclePlan)` and `M = 1.3·P0` is never reached. The plan keeps exactly that law:
   - with probability `restDayProbability` a light day `v = u('volume-rest') × REST_DAY_MAX_FRACTION`;
   - else `v_ln = exp(σ_v · z('volume'))` and the **automatic-day band** `b = CYCLE_PLAN_MIN_FRACTION +
     u('volume-band') · (CYCLE_PLAN_MAX_FRACTION − CYCLE_PLAN_MIN_FRACTION)` (today's `cyclePlan` draw, `u ∈ [0, 1)`);
   - `V = min(round(P0 · v_ln), bandDay)` with `bandDay = P0 < CYCLE_PLAN_MIN_CAP ? P0 : min(P0 − 1, max(1, round(P0 · b)))`.

   Hence `V ≤ automaticDayMax(P0)` = the supremum of today's `cyclePlan` = `P0 < 10 ? P0 : min(P0 − 1,
   ⌈0.97·P0 − ½⌉)` (14 at 15, 29 at 30, 48 at 50, 73 at 75, 97 at 100). At P0 = 50 and Typical consistency the day
   averages 0.79·P0 (median 0.88, p10 0.58, p90 0.94) — identical to today's realized day; Even 0.90·P0, Varied
   0.68·P0 (seeded simulation, 200 000 days). The previous revision's draw (a lognormal re-drawn against `M`) would
   have put 38 % of Typical days above today's maximum and 15 % at ≥ 1.15·P0. The three `PATTERN.CYCLE_PLAN_*` keys are
   therefore **kept** (re-roled from "per active-hours cycle" to "the automatic-day band"; values unchanged), not
   retired. `M` is never a volume target: `M − V` is headroom for single manual actions and outside residuals.
3. **Kinds** (deterministic, §5.7): `U_life`, `U_prune`, `A` (accepts), `F`, `slack`.
4. **Session count** `n = min + ⌊u('sessions')·(max − min + 1)⌋`, `min(n, V)`; `n = 0` when `V = 0`.
5. **Session budgets** `w_s = exp(σ_v · z('budget', s))`, apportioned to `V` by largest remainder (each ≥ 1); each kind
   apportioned by the same weights with `U_s ≤ ⌊b_s·u_max⌋` and spill (per-kind totals exact). Replaces
   `0.6 + 0.8·rng` (`session-planner.ts:303`).
6. **Tempo per session** (§5.9) and the gap spec per session (§5.10).
7. **Expected length** `L_s = b_s × targetMean_s`.
8. **Placement** on the **masked** intensity `λ_eff = λ × quietMask`: centre `c_s` = the λ_eff-mass quantile
   `(s − 1 + u('start', s))/n` of `[S, E)`; `start_s = c_s − L_s/2`; a forward pass enforces
   `start_{s+1} ≥ start_s + L_s + SESSION_BOUNDARY`, a backward pass `start_n + L_n ≤ E`; also no session may intersect
   quiet hours (clip, then re-run the passes). Infeasible → merge the two smallest adjacent sessions and repeat.
   Reserve one additional `SESSION_BOUNDARY` after each expected length, including the final session's tail;
   L4 already bounds a drawn gap plus its pre-action work by that span. This reserve is part of placement and
   feasibility, while `expectedEnd` continues to mean `start + b_s × targetMean_s`.
   Replaces the rejection sampler (`session-planner.ts:314-324`) and the 20-minute midnight tail (`:283`).
9. **Reads** (§5.8). The census is **not** pinned here: `censusDue` is a durable predicate evaluated per session
   (§5.8.3).
10. **Feasibility.** If `Σ L_s + (n − 1)·SESSION_BOUNDARY > available unmasked time`, reduce `V` until it fits;
    `volume.binding = 'session-time'`. `'band'` when the band draw bound the day (a typical day); `'light-day'` on a
    rest draw; `'day-off'` on a day off; `'follow-bound'` when follows hit `P0`; `'none'` when the lognormal draw was
    below the band.
11. **Proration.** Sessions whose expected end ≤ `firstOpenAt` become `before: 'first-open'` with budget 0.
    `volume.planned` = Σ kept budgets. Every later reallocation (settings, Boost, demand) works on the **kept** remainder
    and never re-apportions prorated volume into the rest of the day (§5.7 `R`).
12. **Boost overlay** [arch r2]. `applyBoost(plan, boostWindow, now)` is the **final step of `drawDayPlan` and of every
    `replanRemainder` path, whatever the cause** (§5.6): sessions with `startAt ∈ [t0, t1)` (and the open one) get
    `mix: 'boost'` and `U_s = 0` (§8.3). A settings change made during Boost, the plan-day edge inside a 12–24 h Boost, a
    clock re-plan and a repair therefore keep the reallocation, not only the window record (law L13).

### 5.5 Session status (pure; one late-join rule)

For session `s`: `windowEnd_s = start_{s+1}` (or `E`); `used_s` = mutations (ledger union, all writers) with
`at ∈ [start_s, windowEnd_s)`.

- `now < start_s` → `later` (the first is `next`).
- **Unjoined** (`used_s = 0`): at its exact start the full `b_s` is available, independent of millisecond
  rounding. Later, open while `now < expectedEnd_s` with `fit = ⌊(expectedEnd_s − now)/targetMean_s⌋`;
  afterwards `skipped` (or `before-open`). The budget is forfeited: **missed sessions expire, no catch-up** [owner Q6
  default]. A late join's effective budget is `min(b_s, fit at the moment it joins)` [arch r2]: joining one action
  before `expectedEnd_s` never unlocks the full `b_s`.
- **Joined** (`used_s > 0`): open while `used_s < b'_s` (the effective budget), `now < closesAt_s`, day volume remains
  and no cap binds; then `done` or `partial`. `closesAt_s` is the earliest of the next session's start minus
  `SESSION_BOUNDARY`, the next quiet-hours start, and the plan-day end. The expected duration is not a hard close.
- Start pressed between sessions **parks with a countdown** to the next session; **Boost is the act-now control**
  [owner Q4 default]. When no session remains before the next plan-day boundary, `nextSessionAt` is the next plan-day's
  first session (a pure draw of the next key); if that day is also empty (days off), parks end at the next plan-day
  boundary and re-evaluate there — never an undefined delay.

### 5.6 Re-plan events (the only writes after the day's first `ensure`)

| Cause | Trigger | Changes | Never changes |
|---|---|---|---|
| `day-start` / `first-open` | first `ensure` in a new window | the whole plan; `firstOpenAt = now`; Boost overlay | — |
| `settings` | intent digest ≠ `plan.intentDigest` | future kept sessions re-drawn from the same seed (started sessions frozen; Σ future ≤ the kept, prorated remainder and ≤ `V' − used`); the open session gets `max(used, newBudget)`; Boost overlay | the seed; proration |
| `demand` | a census completed | future sessions' kind mix only; Boost overlay | volume, times, tempo |
| `boost-start` / `boost-end` | §8 | the remainder's mix and reads; optional session-now | `V`, `M`, `H`, floors, D6 totals, tempo, Σ kept future budgets |
| `clock` | `now < drawnAt − CLOCK_TOLERANCE_MS` | re-derived for the current window; Boost overlay | ledgers (future-dated rows still count) |
| `repair` | `plan_state` fails validation | re-derived deterministically (the phase is install-seeded, so the current window's start never moves later than the persisted or ledger-implied start); warn log; Boost overlay | a valid Boost window survives |

**Every cause ends with `applyBoost`** (§5.4 step 12); law L13 is asserted for every `ReplanCause`. No re-plan ever
increases Σ of future budgets beyond the kept remainder (law L13b).

Not re-plan events: reads, status pushes, engine start/stop, parks, missed sessions, ordinary demand drift.

**Triggers of `ensure`** (`src/main/modules/plan-control.ts`): graph build; a one-shot timer at
`nextEdgeAt(now) = min(window.endsAt, boost.endsAt, nextSessionStart)` re-armed after each `ensure` through
`ScheduleManager`; system resume; settings change (plan-control subscribes with `settings.onChange` — after Phase F
the old `reloadConfigs`/`g.pacing?.applyConfig` path, `foundation-wiring.ts:1851-1866`, lives in
`settings-service.ts`, and the plan needs no edit there); census completion; Boost commands. The engine's `pacing`
fact source calls `ensure` only when `view().provisional`. `onChanged(view, cause)` pushes status and wakes the plan
parks. PRINCIPLES §3 holds: `endsAt` and `boost.endsAt` are persisted and evaluated at launch, so overdue edges fire
first.

### 5.7 Budgets per kind

- **Volume semantics** [owner Q2 default; arch r2]. `V` = the day's **automatic** mutations: follows, lifecycle
  unfollows, woven cleanup unfollows, accepts and user-started cleanup runs ("Run now" is user-commanded but bulk, so it
  stays inside the automatic day exactly as today's `cyclePlan` gate holds it). `V ≤ automaticDayMax(P0)` always (§5.4).
  Single manual actions (P9: a manual follow or unfollow of one account) are admitted under `M` and `H` only; outside
  (phone) actions, measured as the following-header residual or the exact following check (§9.10), count against `M`
  only [owner Q7 default]. Definitions used everywhere (posture, Boost, preflight):
  ```
  R          = Σ over kept sessions not yet ended (b'_s − used_s)     prorated and skipped sessions contribute 0
  remaining  = max(0, min(R, V − used.auto, M − used.all − outside))   automatic work
  manualOpen = used.all + outside < M ∧ actionsInLastHour < H          a single manual action
  ```
- **Kind allocation (no rng):**
  ```
  u_max   = BOUNDS.PATTERN.MAX_UNFOLLOW_FRACTION_PER_SESSION (0.5); 0 inside a Boost window
  room    = ⌊V·u_max⌋
  U_life  = min(demand.lifecycleDueByDayEnd, room)                              lifecycle first
  c       = intent.cleanupShare                                                  off 0 · a few a day .36 · more each day .71
  U_prune = min(demand.pruneStock, ⌊(room − U_life)·c⌋, intent.cleanupPerDayCap ?? ∞)
  U       = U_life + U_prune
  A       = intent.acceptRequests ? min(demand.pendingRequests + ⌈demand.acceptsRecent⌉, ⌊(V − U)/2⌋) : 0   accepts are growth
  excess  = max(0, demand.lifecycleBacklog − room)
  F       = min(V − U − A − min(⌊(V − U − A)/2⌋, excess), P0 − demand.followsDoneToday)   follows never exceed P0
  slack   = V − U − A − F
  ```
  Backlog yield: when the lifecycle backlog exceeds a day's room (for example after Boost), follows yield up to half
  their share; `u_max` is never raised [owner Q5 default]. The yield applies on every non-Boost plan-day, whether or not
  another Boost follows.
- **Run-time transfers** [arch r2]. An open session with unfollow budget but no unfollow work may use it for follows
  while `follows < min(F + slack, P0 − followsDoneToday)`; accepts use `A_s`, then slack, then the session's follow share
  (accepting is growth), **never** the unfollow share; unfollows never take follow or accept budget. `PlanView.admits
  ('follow')` refuses `kind-spent` once today's follows (all writers) reach `P0`. Automatic unfollows, including
  Prune runs, also refuse once the open session's unfollow allocation is spent; per-session ledger kind counts
  distinguish those unfollows from follows and accepts. Property: for any availability of
  unfollow work and any arrival of requests, cumulative follows ≤ `P0` and the automatic total ≤ `V`.
- **Where the mix is decided:** `src/engine/plan-mix.ts`, inside the `action` fact source. It asks churn for the best
  due unfollow and the best queued follow (`nextDue(now, kind)`), applies `admits`, draws `u('mix', s, k)` against
  `U_left/(F_left + U_left)`, and emits the existing `{due, pruneCandidate, weaveDraw, unfollowFraction}` shape
  (lifecycle unfollows are never displaced by woven candidates). **Unfollow work is unavailable** (follows are chosen)
  while any of: Boost window active; protection paused (§7.6); `SurfaceGate.paused('unfollows')` (§10.6); the cleanup
  cool-down after a rate halt (`RECOVERY.PRUNE_COOLDOWN_AFTER_RATE_HALT_MS`, now applied to woven and run cleanup); the
  **unconfirmed-actions breaker** for unfollows (§11.1 F7). **Follow work from new sources is unavailable** while
  `SurfaceGate.paused('exploration')` (§10.6) or the breaker holds follows; follows of already-queued, enriched
  candidates continue. `pickAction` (`decisions.ts:74-88`) and `rules.ts` are untouched by the plan; the engine's seeded
  weave draw (`engine-facts.ts:207-210`) is deleted.
- **Accepts** have their own budget `A` (above), projected as `kinds.accept: Progress` [arch r2: A1 lists accepts as
  a kind]. Per drawer pass: `acceptsAllowed = min(pending, A_s,left + slack + F_s,left, ⌊H − H/CEILING_HEADROOM⌋,
  H − actionsInLastHour − 1)` (≤ 5 Standard, 3 Cautious, 6 Bold), spaced by `gap.accept`, **one** deadline armed when the
  pass ends [owner Q8 default]. This fixes "one accept per pass" (`mutation-policy.ts:102-111`) and stops a private
  account's requests from waiting once the day's follows are spent. `RIM.REQUEST_ACCEPT_CAP` (20) stays a runaway
  guardrail.

### 5.8 Reads: two layers, one plan-day window

**Layer 1 — D6** (kernel, from live Settings; hard; enforced by `ReadBudget`; accounting window = the plan-day, plus a
trailing-24 h backstop equal to the same totals, §3 deviation 3):

```
profiles        = M + ⌈M·(1 + ORDINARY_FAIL_RATE)⌉ + ⌈dailyPlanSize/queuedPerSource⌉·(profilesPerSlice + sourceOpenReads)
verifyReserve   = M         non-verify profile debits ≤ profiles − verifyReserve (click-time verification always fits)
explorationProfiles / explorationPages   unchanged formulas (identity at the reference)
listPages       = explorationPages + censusPagesMax + frontierPages
censusPagesMax  = min(censusFollowerPages(n_followers, rpp), CENSUS_POLICY.maxWalkPages) + SURFACE.followingWalkPages   [T5 §3.13; bounded, arch r2]
                  censusFollowerPages(n, rpp) = ⌈n·(1 + ORDINARY_DUPLICATE_PAGE_RATE)/max(rpp, MIN_ROWS_PER_PAGE)⌉ + 2
                  header unknown → LIST_WALK_MAX_PAGES (200, today's identity)
frontierPages   = (1 + sessionsPerDayMax) · BOUNDS_REENTRY.FRONTIER_PAGES_MAX     head walks: the catch-up + one per session start  [arch r2]
notifications   = sessionsPerDayMax + ⌈M · targetMean(BEAT_MAX) / checkSpacingMin⌉ + 1
                  checkSpacingMin = max(the briskest derived check.spacing, the checks.everyHours override) — an override only lowers this
backstop        = for every total above: debits in the trailing 24 h ≤ the total (the read-budget park resumes at
                  max(the plan-day boundary, the trailing-window expiry))
```

At balanced: profiles 276 unchanged; pages 218 → 253 (the new frontier term, 7 × 5 = 35 pages, is a **bound** for a
read class that did not exist before — typical use is 0–5 pages a day — while verify-at-act deletes up to 276 profile
pre-reads a day; §25 note 4); notifications drop 30 → 17. Head walks draw from the frontier term and the
session-mode following check (§9.3 step G) from the census term's following share (`SURFACE.followingWalkPages`, used
at most once per plan-day: by the census when one runs, else by the check), so neither can spend the room a census
needs (fixes census starvation). A census starts only when the plan-day's
remaining census allowance covers both sides in full and the host session can finish it (§5.8.3); a census is **one
uninterrupted walk**, never resumed across sessions (row-offset cursors shift, T5 F-shift).

**Layer 2 — the plan's day and session budgets** (scheduling; rules consult them before starting work):

```
reconcile = journalPending + protectedReeval + verify (click) — drawn from the verify reserve and the session's reconcile bucket
explore   = ⌈F·PLAN_BUFFER/queuedPerSource⌉·(profilesPerSlice + sourceOpenReads)     (= D6 share at V = P0, U = 0)
explorePages = ⌈F·PLAN_BUFFER/queuedPerSource⌉·(pagesPerSlice + sourceOpenReads)
census    = censusWalkPages for the session hosting the census (§5.8.3), else 0
checks    = Σ_s (1 + ⌊L_s / check.spacing_s⌋)       one check at each session start + every check.spacing in long sessions
checkPages_s = min(FRONTIER_PAGES_MAX, headWalkPages(…))   at a session start; a mid-session check walks the head only after a feed gap
following = SURFACE.followingWalkPages, at most once per plan-day, when the following residual is non-zero and no census read the following list that day (§9.3 step G)
catchUp   = { profiles: 1, notifications: 1, pages: min(FRONTIER_PAGES_MAX, headPageAllowance(…)) }    reads outside sessions
```

Per-session buckets: explore ∝ `F_s`; reconcile ∝ `U_s` (≥ 1 for journal settlement), unspent carried forward within
the day. The governor enforces D6 totals, the verify reserve and an explore sub-limit equal to the plan's
`explore/explorePages` (law: ≤ the non-verify room; equals D6's share at the reference); it holds no numbers of its own.
Purposes stay `'exploration' | 'reconciliation'`; an optional `use: 'verify' | 'reconcile' | 'explore' | 'check' |
'census' | 'catch-up'` tag rides each debit (older builds ignore it).

**5.8.3 Census: a durable predicate, evaluated per session** [arch r2]. `censusDue` ⇔ cleanup ≠ off ∧ (no complete
census ∨ `census.lastCompleteAt` older than `patienceWaitMs` ∨ `pruneStock` < the next day's `U_prune` estimate). It is
persisted state (the census repo's `lastCompleteAt`), never a draw-time pin: `PlanView` makes the census host the
**first** open session that is non-Boost, non-probation and whose remaining window fits `censusWalkMax` at its walk
tempo. A session that is skipped, prorated, held by recovery or Boosted simply is not the host, so the next eligible
session runs it — an overdue census runs first (PRINCIPLES §3), including for an owner who never opens Epo at the
day's peak. `censusWalkMax = min(CENSUS_POLICY.maxWalkPages (1 000 = 5 × LIST_WALK_MAX_PAGES), the pages that fit the
host session's remaining window at E[walk.page] + E[walk.rest]/E[walk.rest-every] + LATENCY.fetchEnvelope.p50)`. An
account whose header needs more pages is refused with **"too large to check in full"**: cleanup absence verdicts stay
off, the Prune page explains why, and nothing walks partially. This fixes "cleanup does nothing without a manual
scan" and the unbounded large-account walk. The scheduled bulk prune (30-min watcher, `pruneScheduleDays`) is
**retired** (§14 C14).

### 5.9 The tempo

**Axes.** Each session has `{pace, motion, depth}`; a spec names one of four axes:
- `pace` multiplies the gap time-scale and every reading/scroll wait;
- `pace-up` [arch r2] multiplies by `max(1, pace)`: the waits that follow a wall, a refused or blocked action or a
  failure (`backoff.walled`, `park.blocked`, `beat.transient`) are never shorter than today's on a brisk session and
  longer on a relaxed one — retrying sooner because the day drew a brisk tempo would add pressure exactly while
  Instagram is refusing;
- `motion = pace^TEMPO_POLICY.MOTION_ELASTICITY (0.5)` multiplies cursor travel, press, pre-press, hover-settle and
  wheel pauses, and co-varies the speed–accuracy keys (resolved **once per gesture**);
- `depth = 1/pace` multiplies scroll distance per burst and the list-walk rest stride (a brisk session scrolls further
  and rests less often).

Boost never changes tempo. With no open session (launch catch-up, manual operations, a cleanup run between sessions)
the **ambient** tempo `z = z_day` applies.

**Session draw.**
```
σ_pace = ln(1 + POLICY.BAND_HALF_WIDTH) / POLICY.DRAW_CENTRAL_Z × SCALES.consistency[k]   → .128 natural, .055 clockwork, .207 erratic
z_s    = (z('tempo-day') + z('tempo', s)) / √2
pace_s = clamp(exp(σ_pace · z_s), NOISE.BEAT_MIN_FACTOR 0.7, NOISE.BEAT_MAX_FACTOR 1.45)
```
Probation sessions (§9.11) use `H` one caution rung down with the drawn pace.

### 5.10 The gap: rate-neutral and derived (no new dial)

```
targetMean_s = (3600 s · CEILING_HEADROOM / H) · pace_s / BEAT_MIN
```
The briskest allowed session (pace 0.7) runs at exactly `H/CEILING_HEADROOM`; every other session is proportionally
slower. Standard: median 303.9 s ⇒ 11.8/h (legacy 12.0/h); brisk 212.7 s; relaxed 440.6 s. Cautious 477.6 s (7.5/h).
Bold 222.9 s (16.2/h) [owner Q1 default].

- **Shape** (time-scaled, not median-only): the reference shape is median `gapMedianSeconds`, σ `SESSION.GAP_SIGMA`,
  floor `gapFloorSeconds`, cap `SESSION.GAP_CAP_MS`, Hawkes `α`, `τ_h`. The session spec scales median, floor and `τ_h`
  by `τ_s`, and the cap by `min(τ_s·cap, CAP_MAX)` with `CAP_MAX = SESSION_BOUNDARY − (dwell.visit max +
  dwell.before-press max at BEAT_MAX + TAB.GOTO_TIMEOUT_MS) ≈ 28.7 min` (a gap never ends a session; law L4).
- **Solving τ.** `τ_s = max(1, solve stationaryMeanGapMs(shape(τ), b_s) = targetMean_s)`; the estimator is a
  deterministic memoized seeded simulation of the exact draw (~4096 draws, ~1 % error) whose excitation includes the
  just-dispatched action (the code's real semantics, reference mean 103.9 s at balanced). Closed form when the cap does
  not bind; else bisect (≤ 24 iterations). `τ ≥ 1`: the plan never runs faster than the organic shape.
- **Overrides act on the effective scale, slower only** [arch r2]. At Standard `τ ≈ 2.9`, so the real typical pause is
  ≈ 4–5 min and the real floor ≈ 130 s; a reference-shape override (the old "Typical pause 95 s") was absorbed by `τ`
  and did nothing unless raised above ≈ 280 s. The Advanced rows therefore mean what they say: `sessions.gapTypical`
  = "Average pause between actions" overrides the target mean at pace 1 (`targetMean_s = max(derived, override) ·
  pace_s / 1`, recommended `3600·CEILING_HEADROOM/H/BEAT_MIN` = 304 s Standard, 477 s Cautious, 223 s Bold);
  `sessions.gapMinimum` = "Shortest pause between actions" overrides the effective floor (`floor_s = max(gapFloor·τ_s,
  override)`, recommended the plan's floor at pace 1, ≈ 130 s Standard). Both may only lengthen. The internal reference
  shape (median/floor ratio, σ, Hawkes) is shown read-only in "Today's plan in detail" (§6.5).
- **Draw at dispatch.** `gap = floor + (clampedLN(median, σ; floor, cap) − floor)/(1 + Σ α·e^{−(now−t)/τ_h})` over the
  ledger's mutation times in the trailing hour including `now`; lognormal from `u(seed, 'gap', s, k, attempt)` with the
  house bounded re-draw (4 tries, then project).
- **Velocity park** is exact: `oldest-in-trailing-hour + 1 h + one gap draw − now` (the 5–15 min log-normal retires).

### 5.11 The tempo-spec registry (`src/kernel/tempo/specs.ts`)

`scaleAbove(x, floor, f) = floor + (x − floor)·f` (identity at f = 1; never crosses the floor for f ≥ 0). Bands scale
both edges; lognormals scale median and both clamps (σ unchanged); bases scale the value; depth scales viewports (and
the rest stride) with the floor at the call site. A `tempo.<key>` Advanced override (§6) is a **reference factor**
`f_o ∈ [1, SETTINGS_POLICY.TEMPO_OVERRIDE_MAX_FACTOR (3)]` applied as `scaleAbove(prior, floor, f_o)` before the
session factor [arch r2]: an override may only **lengthen** a wait; the brisk side comes from the plan's own pace
draw, so no override can make a wait shorter than anything the plan draws (law L-ENV over every tempo row). It never
replaces a drawn value.

| Key | Prior (identity at tempo 1) | Axis | Floor | Consumer (after) |
|---|---|---|---|---|
| `gap.action` | the reference gap shape (today's planner gap) | pace → τ | caution floor × τ | `MutationCadence.armAtDispatch` (prune pace and probation gap merge into it) |
| `gap.accept` | `RIM.ACCEPT_PACE_*` 1 500–3 000 | pace | `LATENCY.acceptRow.p50` 800 | `request-acceptance.ts` |
| `dwell.visit` | `MOTION.profileDwell*` logN(9 000, .45)[5 000, 30 000] | pace | 5 000 (prior-min; owner-established) | `profile-visit.ts`; from the activity-clock slice, entry spacing for every IG operation |
| `dwell.before-press` (**new**) | `band(PACING_BASE_MS.read)` 2 500–4 500 | pace | 2 500 | after the fresh visit lands, before the dispatch closure (look-before-act) |
| `ui.step-pause` (**new**) | `RIM.NOTIFICATIONS_CLOSE_DELAY_*` 500–1 200 | pace | `DISPLAY.perceptionMs` 100 | a reading pause between the presses of one multi-step flow: bell → Follows chip → requests entry; chip-when-ready retries; **each confirm layer of an unfollow, after it is located and before travel** (§11.1 F2) |
| `drawer.close-settle` | 500–1 200 | pace | 100 | drawer close |
| `scroll.wait.drawer` | `RIM.NOTIFICATIONS_SCROLL_WAIT_*` 1 400–2 800 | pace | `LATENCY.notifications.p50` 900 | drawer scroll |
| `scroll.wait.dialog` | `RIM.SCROLL_WAIT_MS` × [BEAT_MIN, BEAT_MAX] 1 400–2 900 | pace | `LATENCY.hydration.p50` 900 | `followers-page-reader.ts` |
| `scroll.wait.acquire` | `RIM.ACQUIRE_SCROLL_*` 1 400–3 600 | pace | 900 | `follower-acquisition.ts` |
| `scroll.depth.drawer` | 2.0 viewports ± `BAND_HALF_WIDTH` (spread **new**) | depth | `MIN_SCROLL_STEP_PX` 600 | `actor-scroll.ts` |
| `scroll.depth.dialog` | 3.0 viewports ± h | depth | 600 px | `actor-scroll.ts` |
| `walk.page` | `RIM.LIST_WALK_PAGE_*` 1 000–3 000 | pace | `LATENCY.fetchEnvelope.p50` 700 | `list-page-walker.ts` |
| `walk.rest` | `RIM.LIST_WALK_REST_*` 5 000–15 000 | pace | 1 000 | walker rests |
| `walk.rest-every` (**new**, r2) | `NOISE.LIST_WALK_REST_EVERY_MIN/MAX` 5–10 pages, drawn per rest | depth | 1 page | `list-page-walker.ts` rest stride |
| `pause.retry` (**new**, r2) | the sub-cadence band of the call site's D4 retry wait, `[0.7, 1.45] × base` (today `noisify('sub-cadence', base)`, `page-pacing.ts:9-15`) | pace | the call site's D4 poll interval (`pollEveryFor(op)`) | `pauseBeforePageRetry` (landing, identity and username-resolve retries), the list-walk fetch retry |
| `pause.wake-settle` (**new**, r2) | `RECOVERY.RESUME_SETTLE_MIN/MAX_MS` 3 000–10 000 (today `Math.random`, `foundation-wiring.ts:1307-1310`) | pace | `LATENCY.probe.p50` | the wake sequence before the connectivity and tab-health checks |
| `pause.after-task` | `ENGINE.REFILL_PACING_*` 2 000–5 000 | pace | 2 000 | `engine.ts` refill beat (**retired** by the activity clock, S2b) |
| `park.blocked` | `PRUNE.PARK_MS` 30 000 (retry-backoff noise kept) | **pace-up** | = prior | engine + prune blocked parks |
| `backoff.walled` | `ENGINE.ENRICH_BACKOFF_MS` 600 000, clipped to the session window | **pace-up** | = prior | enrich backoff, target recovery (past the window → session park) |
| `beat.transient` | `ENGINE.IDLE_MS` 30 000 | **pace-up** | = prior | transient error retry; interrupted-check retry |
| `check.spacing` | 2 × `SESSION_BOUNDARY` = 60 min (identity with today's sweep) | pace | `SESSION_BOUNDARY` | `PlanView.checkDue` (the `checks.everyHours` override may only lengthen it: ≥ `scaleAbove(60, 30, BEAT_MIN)` = 51 min) |
| `motion.travel` | `MOTION.travelBaseMs/ScaleMs` 100/150, `moveMin/MaxMs` 120/1 400 | motion | moveMin 120; `minEventDelayMs` and peak speed stay enforced | `motion-profile.ts` |
| `motion.press` | logN(70, .24)[40, 120] | motion | 40 | `motion-profile.ts` |
| `motion.pre-press` | `MOTION.prePressMs` [30, 120] (moved literal) | motion | 30 | `interactor.ts:112` |
| `motion.hover-settle` | `MOTION.hoverSettleMs` [250, 600] | motion | 250 (measured transition) | `interactor.ts:93` |
| `wheel.tick-pause` | [30, 90] | motion | 30 | `motion-profile.ts` |
| `wheel.micro-pause` | p .12, [180, 450] | motion | 180 | same |
| `wheel.correction-pause` | [120, 300] | motion | 120 | same |

`MOTION` keys that are **not** duration (tempo) keys gain a role in `src/kernel/motion-roles.ts`:
`speed-accuracy | shape | guardrail | device`; §17.5 lists each. **Speed–accuracy** keys (`overshootProbability`,
`overshootFraction`, `targetSigmaFraction`, `wheelOvershootProbability`, `wheelOvershootFraction`) co-vary with the
gesture's motion factor [arch r2]: `x(m) = x_ref · m^(−TEMPO_POLICY.SPEED_ACCURACY_ELASTICITY (0.5))`, clamped by the
guardrail keys (`targetMarginFraction` keeps the aim inside the target; `overshootMaxPx` bounds overshoot) — a brisker
gesture overshoots and scatters slightly more (±9 % over the pace band). **Shape** keys are POLICY dials with a guard
line and provenance each (§3 deviation 4). `MOTION_REFERENCE === deriveMotion(1)`; `deriveMotion(m)` scales tempo-role
durations by `m` and speed–accuracy keys as above, and nothing else.

```ts
export interface TempoSource {
  current(): SessionTempo;                       // open session's, else ambient (pure read)
  base(key: TempoKey): number;                   // location at the current tempo (WaitRunner bases)
  draw(key: TempoKey): number;                   // one draw from the key's own noise stream
  policy(key: TempoKey): { readonly kind: string; sample(rng?: () => number): number };
  gesture(): { readonly policy: MotionPolicy; readonly rng: () => number };   // resolved ONCE per gesture
  enabled(key: TempoKey): boolean;               // false only for keys added by this overhaul under the reference source (Phase F identity)
}
export declare const REFERENCE_TEMPO: SessionTempo;                    // pace = motion = depth = 1, τ = 1
export declare function referenceTempoSource(launchSeed?: number): TempoSource;   // reproduces today's values exactly
```

### 5.12 What stays static, and the golden that replaces "exactly one moved key"

| Class | Members | Rule |
|---|---|---|
| Fundamentals (tier 0) | walls; soft-wall durations; session boundary; gap/burst/session/volume/rest/circadian beliefs; `LATENCY` seeds; `ORDINARY_*` rates; `DISPLAY` | inputs, never scaled; `UNFOLLOW_WALL_PER_HOUR` gains its consumer (`unfollowHourlyCap`, law L3) |
| Policy dials | existing `POLICY`, `SCALES`, `PREFERENCES`; **new** `TEMPO_POLICY.MOTION_ELASTICITY` 0.5, `TEMPO_POLICY.SPEED_ACCURACY_ELASTICITY` 0.5, `PLAN_POLICY.RETRY_CONFIDENCE` 0.99; the `MOTION` shape dials (§3 deviation 4) | one guard line each, with provenance |
| Bounds | existing `BOUNDS`/`NOISE`; **new** in `tempo-policy.ts`: `CLOCK_TOLERANCE_MS` 5 min, `MIN_SCROLL_STEP_PX` 600; other new bound modules in §17.10 | guard line each |
| Priors | `PACING_BASE_MS`, `MOTION` durations, the RIM/ENGINE/PRUNE/NOISE/RECOVERY keys a spec claims (incl. `ENGINE.IDLE_MS`, `ENGINE.ENRICH_BACKOFF_MS`, `PRUNE.PARK_MS`, `RIM.SCROLL_WAIT_MS`, the rest stride, the resume settle) | reached **only** through `resolve()` at tempo 1; outside `src/kernel/tempo` no code reads them — `no-static-timing` flags any **property access** to a claimed key (`RIM.SCROLL_WAIT_MS`, `MOTION.x`, …), not only imports |
| D4 deadlines and polls | `timeoutFor(op) = p99·TIMEOUT_SLACK`, `pollEveryFor(op)` | **never plan-derived**: a relaxed session must not loosen failure detection; tempo floors use the same seeds' p50; law: every D4 value identical at every tempo |
| D3/D5 | holds, cool-down, breaker posteriors | physics and statistics; the plan only decides *when* work runs |
| `HARNESS` (9 dev keys) | — | never derives (ADR 0605) |

**ADR 0607** redefines the golden invariant:
1. The snapshot (`tests/kernel/legacy-config.snapshot.ts`) is never edited.
2. `src/kernel/registry-changes.ts` holds two ledgers. `RETIRED` lists every retired registry key `{adr: '0607',
   replacedBy, reason}`. `CHANGED` lists every deliberate value change anywhere the snapshot pins one — registry key,
   ordinal grid point, persona or circadian profile — as `{path, from, to, adr}` [arch r2]. Every golden test (registry,
   grid, personas, profiles, "exactly the deliberate changes") computes `EXPECTED = snapshot − RETIRED ⊕ CHANGED`; the
   test of deliberate changes asserts they equal the `CHANGED` ledger. The ledgers land in PR S2r's golden rewrite,
   **before** the cautious-floor commit that uses `CHANGED`.
3. The tempo-identity golden passes: every spec at `REFERENCE_TEMPO` deep-equals its prior; every RIM/ENGINE/NOISE band
   and every `MOTION` duration key is claimed by exactly one spec or listed in `NOT_TEMPO` with a reason.
4. The `MOTION` golden: a frozen `tests/kernel/motion.snapshot.ts` + an `ADDED` ledger + `MOTION_ROLE` coverage.
5. Laws hold over plan × tempo space (§20).
6. The provenance tally is asserted against a reviewed literal, updated in the commit that retires keys.

**Retired registry keys (20)** [finalized from `registry-changes.ts`; all in PR S2r, after the last consumer is
gone]:
- derived (9): `ENGINE.VELOCITY_PARK_{MEDIAN_MS,SIGMA,MIN_MS,MAX_MS}`; `RIM.ENRICH_PACE_{MIN,MAX}_MS`;
  `NOISE.PRUNE_LAUNCH_JITTER_MAX_MS` (C14); `NOISE.CADENCE_SIGMA` (derived from the retired
  `BOUNDS.NOISE.CADENCE_MAX_FACTOR`, `derive.ts:799-813`; the code would not compile without retiring it);
  `NOISE.DAILY_BOUNDARY_JITTER_MAX_MS` (its three users — the daily-ceiling, read-budget and active-hours parks — become
  exact or are deleted, so the `'daily-boundary'` wait class and `jitterBoundary` are deleted with it);
- policy (7): `PRUNE.DELAY_FACTOR`; `RIM.ACQUIRE_MAX_ROUNDS` (dead); `SCHEDULER.AUTO_PRUNE_CHECK_MS`,
  `PRUNE.SCAN_FRESH_MS`, `NOISE.CADENCE_{MIN,MAX}_FACTOR` (C14 and the retired sweep factor);
  `SCHEDULER.USERNAME_REBUILD_BACKOFF_MS`;
- override (2): `ENGINE.REFILL_PACING_{MIN,MAX}_MS` with their two `OVERRIDES` entries (the activity-clock slice);
- harness (2): the unused `HARNESS.ENRICH_PACE_{MIN,MAX}_MS`; the harness visitor shares the visit cadence.

**Kept, re-roled:** `PATTERN.CYCLE_PLAN_{MIN_FRACTION,MAX_FRACTION,MIN_CAP}` are the automatic-day band (§5.4; values
unchanged). **Final tally after S2r:** derived 40 / policy 34 / override 16 / harness 9 (99 keys; previously
49/41/18/11 = 119, `derive-golden.test.ts:184`). **Non-registry `OVERRIDES` changes** (not part of the tally, covered by
the overrides tests): the advisory `ENGINE.ACTIONS_FAILING_HALT` entry is removed (the engine reads
`coldFailingThreshold()` = 7); `CAUTION.cautious.floorSeconds` is removed (the derived 70 applies; grid point and
persona recorded in `CHANGED`); the applied `PRUNE.CONSECUTIVE_FAIL_HALT` 4 entry is added (derived 7, with its reason).

### 5.13 Deleting the legacy pacer safely [lead: in the same change]

Two behaviour-changing merges, each green, then two non-behavioural ones:

- **S1 "one writer"** (pace unchanged: the legacy floor stays). `PlanService` replaces `SessionPlanner` (quiet-minute
  boundary, seeded draw, pure view, expiry and proration) and swaps the plan-backed `PlanDayClock` in at
  `plan-wiring.ts`. `RateGovernor.dayStart()` = `plan.startsAt`; `plannedToday` = the plan's `V` (today's law, §5.4, so
  the automatic-day bound is unchanged); `cycle-plan.ts` is deleted (its draw now lives in the plan); the status
  projection becomes pure; `status.plan` is added (the deprecated `status.pacing` stays, optional, until the Phase I
  removal sweep, because the old renderer reads it). `beforeMutation` still stamps `now + rate.nextDelayMs()`; the
  engine arms `max(store, actAt + gap(τ = 1))`.
- **S2 "the cadence switch"**, one merge:
  1. `MutationCadence.armAtDispatch` replaces `mutation-policy.ts:64-65` (the plan's GapSpec is armed at dispatch).
  2. `performAction` serves the owed remainder, acts, then waits on the store deadline armed at dispatch. The
     `Math.max(store, actAt + pacer.noteAction)` (`engine.ts:656-657`) and `Pacer`/`OrganicPacer`/`LegacyPacer` go.
  3. `preflight` runs **before the visit** and returns a typed `Admission` with `until`; `ActionDeferredError` gains
     `{reason, until}`; callers park exactly (no idle-and-revisit; fixes the visit-then-defer loop).
  4. Accepts: one deadline per pass, inside their own budget `A`.
  5. `budgetOpen` loses `atOperatingRate`; the automatic-day bound moves into `preflight` (`day-done` once
     `used.auto ≥ V`, and `V ≤ automaticDayMax(P0)`), single manual actions are bounded by `M` (`manualOpen`, §5.7).
  6. `RateGovernor` keeps `actionsToday`, `actionsInLastHour`, `atHardCeiling`, `tally()`; `nextDelayMs`,
     `plannedToday`, `remainingToday`, `atOperatingRate`, `withinActiveHours`, `cycleStartMs` are deleted.
  7. Prune: pace, daily plan and active hours deleted; preflight + the shared deadline.
  8. Settings keys deleted **from the engine-facing side only** (the v2 doc's `legacyCarry`, the `@transitional`
     fields of `EffectiveSettings`, `toPacingConfig` and the delay fields of the rate-governor and prune configs):
     `pacingModel`, `minDelayMinutes`, `maxDelayMinutes`, `jitterPercent`, `activeHoursStart`, `activeHoursEnd`.
     `src/settings/v1/*` stays **frozen**: it is the migration's input pipeline and must keep reading every v1 key; after
     S2, `migrate-v1` applies the legacy-pacing mapping itself through `legacy-pacing-migration.ts` (one code path for a
     doc with `legacyCarry` and for a v1 file migrated by a later build). The old renderer is unaffected: it compiles
     against the frozen v1 `Settings` interface and reads `toV1Settings(view)` (§6.10).
  9. The plan-backed `TempoSource` is wired (tempo varies per session); the added sites land (`enabled()` true); D6
     gets the plan-day window, the trailing backstop and `use` tags.
- **S2b "the activity clock"** (`IgActivityClock.spaceEntry()` before every Instagram operation: visit, walker, drawer;
  `pause.after-task` and the enrich pace stop being consumed).
- **S2r "retirements"** (no behaviour change; merges after RO-b and S2b, when the last consumer of every retired key is
  gone): the `RETIRED`/`CHANGED` ledgers, the 18 key deletions, the golden rewrite and tally, `EXPLORATION_POLICY` moves,
  then the cautious floor 60 → 70 s in its own commit (owner Q11) recorded in `CHANGED`. The frozen v1 rules replace
  their two `NOISE.CADENCE_*` references with literal copies plus a reason in the same commit (migration stays
  verbatim without the registry key).
- **Guarding test** `tests/integration/plan-rate.test.ts` lands **first** in S2, red against S1 for the right reason.
  It drives the real `MutationCadence` + `RateGovernor` + `PlanService` + `Engine` + `PruneEngine` with fake time and
  fake tab/actor from `tests/kit`, and asserts: the mean in-session gap ≥ 0.95 × and ≤ 1.25 × the legacy oracle mean
  computed in-test from `jittered(3, 7, 30 %)` at Balanced/Standard; no rolling hour exceeds `H`; velocity parks in
  < 1 % of session-hours; profile visits ≤ mutation attempts at budget or ceiling exhaustion; a cleanup run's spacing
  equals the plan gap with no candidate revisits; one accept pass arms exactly one deadline; day totals ≤ `V`;
  **no simulated day's automatic total exceeds `automaticDayMax(P0)`**, and the mean automatic day is within ±2 % of
  the legacy oracle `min(planner volume, cyclePlan)` computed in-test.
- **"Steady intervals" is deleted** (ADR 0901 executed). A legacy pacing model maps once to intent
  `consistency: 'clockwork'` (shown as **Even**), `rhythm: 'trickle'` with a one-time notice [owner Q9 default].
- **Upgrade probation** [arch r2]. The first `ensure` of any install with a non-empty mutation ledger and no
  `plan_state` sets `plan_state.upgradeProbation = true`, whether or not `pacing_state` exists (legacy-model users never
  had a `SessionPlanner` and change cadence the most); the first session of the first plan-day after the upgrade runs in
  probation; the flag clears when that session closes.

### 5.14 Lifecycle constants (with T5's amendments)

| Constant today | Becomes |
|---|---|
| `REENTRY_POLICY.reconcileAfterMs` 1 h | **deleted** (per-frontier staleness, §9) |
| `…probationAfterMs` 1 d, `…probationActions` 10, `…probationGapMs` 3 min | `probationOwed(lastMutationAt, sessionStartAt, windowOf)` (kernel, pure; §9.11: owed when the absence is ≥ one plan-day length **or** spans a complete plan-day); the session runs in probation for its whole length (H one rung down) |
| `…clockToleranceMs` 5 min | `BOUNDS.CLOCK_TOLERANCE_MS` |
| `RELATIONSHIP_FRESH_MS` + hidden twin `relationshipFreshMs ?? MS_PER_DAY` | **deleted** (verify-at-act, §9.7); `PlanView.freshSince` remains for display |
| `CHURN_DEFAULTS`, `FOLLOWBACK_DEFAULTS`, `SCANNER_DEFAULTS` (`scanner.ts:17`), `?? 4·MS_PER_DAY`, `?? 300` | **deleted**; tests build configs from defaults via `tests/kit/configs.ts` (UD: churn; RO: follow-back; SC: scanner) |
| `SCORER_DEFAULTS`, `CHAIN_DEFAULTS` | reduced to **one declaration** each, reading `SETTINGS_POLICY` (SC) |
| `maxRetries` 3 | `retryLimit() = min k: ORDINARY_FAIL_RATE^(k+1) ≤ 1 − RETRY_CONFIDENCE` = 3; Advanced override `unfollow.attempts` |
| `consecutiveCleanup < 2` | deleted (plan mix) |
| weave draw `min(fraction, 0.5)` | the plan mix draw |
| pending-requests retry 3 min | deleted (requesters are a live predicate, §9.9) |
| interrupted retry 30 s | `tempo.base('beat.transient')` (pace-up: never shorter than 30 s) |
| `ACTIONS_FAILING_HALT` 8 | `coldFailingThreshold()` = **7** (safer) [owner Q11 default] |
| drift `≥ 2` (`recovery.ts:154`) | `driftConfirmThreshold()` |
| `PRUNE_CONSECUTIVE_BLOCK_HALT` 3 | `blockedStreakThreshold()` |
| `PRUNE_CONSECUTIVE_FAIL_HALT` 4 | applied `OVERRIDES` entry (derived 7; reason: a bulk run halts sooner than the loop so a broken unfollow path cannot burn the list) |
| reconciliation halt `≥ 5`, batches of 10 | **deleted** (no batches, no halt; §9) |
| `PRUNE_PROGRESS_EMIT_MS` 250 | `POLL.GRAPH_PUSH_THROTTLE_MS` (300) |
| `FIRST_CENSUS_STOCK_WINDOW_MS` 1 d | one plan-day |
| census coverage `0.98` duplicate | `censusAuthority()` |

### 5.15 Interfaces (condensed; Appendix A holds the full set)

```ts
// src/kernel/plan/types.ts
export type PlanDayKey = string;                                  // local date the window starts on
export interface PlanDayWindow { readonly key: PlanDayKey; readonly startsAt: number; readonly endsAt: number; readonly quietMinute: number }
/** The one plan-day boundary every day counter reads (Phase F port; local-midnight default until PR S1 swaps the plan-backed clock in). */
export interface PlanDayClock { window(t: number): PlanDayWindow; dayKey(t: number): PlanDayKey; onRoll(fn: (w: PlanDayWindow) => void): () => void }
export type MutationKind = 'follow' | 'unfollow' | 'accept';
export type Writer = 'growth' | 'woven' | 'cleanup-run' | 'manual' | 'accept-pass';
export type ReplanCause = 'day-start' | 'first-open' | 'settings' | 'demand' | 'boost-start' | 'boost-end' | 'clock' | 'repair';
export type PlanBinding = 'none' | 'band' | 'session-time' | 'light-day' | 'follow-bound' | 'day-off';
export type ReadUse = 'verify' | 'reconcile' | 'explore' | 'check' | 'census' | 'catch-up';
export interface GapShape { readonly medianMs: number; readonly sigma: number; readonly floorMs: number; readonly capMs: number;
  readonly hawkesAlpha: number; readonly hawkesTauMs: number }
export interface GapSpec extends GapShape { readonly timeScale: number; readonly targetMeanMs: number }
export interface SessionTempo { readonly z: number; readonly pace: number; readonly motion: number; readonly depth: number;
  readonly gap: GapSpec; readonly mix: 'normal' | 'boost'; readonly probation: boolean }
export interface PlannedSession { readonly idx: number; readonly startAt: number; readonly expectedEndAt: number;
  readonly budget: number; readonly mix: { follow: number; unfollow: number; accept: number }; readonly reads: SessionReads;
  readonly tempo: SessionTempo; readonly before: 'none' | 'first-open' }      // no census pin: censusDue is evaluated per session
export interface BoostWindow { readonly v: 1; readonly startedAt: number; readonly endsAt: number; readonly durationMs: number;
  readonly endedAt: number | null; readonly endReason: 'user' | 'expired' | 'clock' | null }
export interface DayPlan { readonly v: 1; readonly window: PlanDayWindow; readonly revision: number; readonly cause: ReplanCause;
  readonly drawnAt: number; readonly firstOpenAt: number; readonly intentDigest: string; readonly seed: number;
  readonly volume: { lognormal: number; band: number; rest: boolean; drawn: number; planned: number; binding: PlanBinding };
  readonly ceilings: { automaticMax: number; day: number; hour: number; unfollowHour: number; probationHour: number;
    followDay: number; acceptsPerPass: number };
  readonly kinds: { follow: number; unfollow: number; lifecycleUnfollow: number; accept: number; slack: number };
  readonly reads: ReadPlan; readonly dayTempo: { z: number }; readonly sessions: readonly PlannedSession[];
  readonly demand: PlanDemand }

// src/governors/plan-view.ts (PURE)
export type AdmitRefusal = 'session-closed' | 'kind-spent' | 'day-done' | 'ceiling' | 'hourly-cap' | 'deadline'
  | 'deferred-by-boost' | 'journal' | 'probation' | 'quiet-hours' | 'day-off' | 'unconfirmed';
export type Admission = { readonly ok: true } | { readonly ok: false; readonly reason: AdmitRefusal; readonly until: number | null };
export type SessionState = 'done' | 'partial' | 'skipped' | 'before-open' | 'now' | 'next' | 'later';
export interface PlanView {
  readonly plan: DayPlan; readonly provisional: boolean; readonly at: number; readonly window: PlanDayWindow;
  readonly sessions: readonly { idx: number; state: SessionState; used: number; budget: number /* effective b'_s */; closesAt: number | null }[];
  readonly open: { idx: number; mixLeft: { follow: number; unfollow: number; accept: number }; readsLeft: SessionReads;
    mix: 'normal' | 'boost'; probation: boolean; censusHost: boolean } | null;
  readonly nextSessionAt: number | null;    // null ⇒ no session before the next plan-day boundary: parks end at window.endsAt
  readonly used: UsageTally; readonly remaining: number /* §5.7 */; readonly R: number /* kept remainder */;
  readonly boost: BoostWindow | null; readonly freshSince: number; readonly tempo: SessionTempo;
  admits(kind: MutationKind, writer: Writer, subject?: { pk: string; intentId?: string }): Admission;
  manualOpen(): Admission;                                 // single manual actions: M and H only
  checkDue(lastSweepEndedAt: number | null): boolean;      // anchored on the sweep's end (T5 V19)
  checkLight(): boolean;                                   // Boost: own header at session start + drawer + accepts
  censusDue(census: { lastCompleteAt: number | null; walkPages: number }): boolean;   // durable predicate, §5.8.3
  acceptsAllowed(pending: number, lastHour: number): number;
  mixDraw(k: number): number | null;
  planDayStartAfter(k: number): number;                    // start of plan-day today + k (T5 parks, revisit windows)
}

// src/governors/plan-service.ts (THE writer)
export interface PlanServiceDeps {
  store: PlanStore; clock: { now(): number }; installEntropy: number; launchSeed: number;
  intent(): PlanIntent; demand(window: PlanDayWindow, now: number): PlanDemand;
  lastMutationBefore(t: number): number | null;            // probation (replaces T1's reentryPhase())
  outsideSince(since: number): number /* increases only */; deadline(): number | null;
  journal: { blocks(pk: string, exceptIntentId?: string): boolean };
  runIntent(): 'running' | 'stopped' | 'paused';            // Boost's act-now insertion keys on intent (§8.2)
  unconfirmed(): { kind: 'follow' | 'unfollow'; streak: number } | null;   // the F7 breaker (§11.1)
  surfaceGate: { paused(a: 'unfollows' | 'exploration'): boolean };
  onChanged?(view: PlanView, cause: ReplanCause): void;
}
export declare class PlanService {
  view(now?: number): PlanView;                 // PURE
  ensure(now?: number): PlanView;               // writes only on a §5.6 cause
  onSettings(now?: number): PlanView; onDemand(now?: number): PlanView;
  startBoost(durationMs: number, now?: number): PlanView; endBoost(reason: 'user', now?: number): PlanView;
  previewBoost(hours: number, now?: number): BoostPreview;      // pure: applyBoost on a copy
  nextEdgeAt(now?: number): number; tempo(): TempoSource; dayStart(): number;
  planDayClock(): PlanDayClock;                 // the plan-backed boundary (swapped in at plan-wiring.ts, PR S1)
  previewDays(intent: PlanIntent, at: number, days: number): readonly PlanPreviewDay[];   // the PlanPreviewPort (§6.5)
}

// src/main/services/mutation-cadence.ts
export interface MutationCadence {
  preflight(kind: MutationKind, writer: Writer, now: number, subject?: { pk: string; intentId?: string }): Admission;   // no I/O; BEFORE the visit
  armAtDispatch(kind: MutationKind, writer: Writer, now: number, subject?: { pk: string; intentId?: string }): number; // re-check + draw + persist
  acceptPassEnded(now: number): number;
}

// src/engine/plan-port.ts
export interface PlanFacts {                    // the `pacing` fact group's new type (group name kept; rules.ts untouched)
  readonly sessionOpen: boolean;
  readonly park: { readonly key: 'engine:session-park' | 'engine:daily-ceiling-park' | 'engine:velocity-park' | 'engine:read-budget-park';
    readonly until: number } | null;           // `until` is always finite: a null nextSessionAt parks to the next plan-day boundary
  readonly admits: { readonly follow: boolean; readonly unfollow: boolean; readonly accept: boolean; readonly explore: boolean };
  readonly mix: 'normal' | 'boost'; readonly probation: boolean;
  readonly reads: { readonly exploreLeft: number; readonly reconcileLeft: number };
  readonly checkDue: boolean; readonly checkLight: boolean; readonly censusDue: boolean;   // censusDue ∧ this session is the host
}
```

### 5.16 Every timing site → its source

| Site (today) | After |
|---|---|
| `engine:action-delay` = `max(legacy, actAt + planner gap)` | serve the store deadline armed at dispatch from the session `GapSpec`; no second draw |
| probation 3 min after each action | the probation session's `GapSpec` (H one rung down) |
| `engine:session-park` | exact `view.nextSessionAt − now` (may be tomorrow's first); `null` → exact to the next plan-day boundary |
| `engine:daily-ceiling-park` 08:00 + ≤ 40 min | **exact** to the next plan-day's first planned session |
| `engine:velocity-park` logN(8 min) | exact window (§5.10) |
| `engine:enrich-backoff`, `target-recovery` | retry-backoff with base `backoff.walled` (pace-up: never shorter than 10 min); ending past the session window → session park |
| `engine:reconcile-backoff` | **deleted** (§9) |
| `engine:read-budget-park` | **exact** `max(resumeAt, nextSessionAt)`, where `resumeAt` = max(the plan-day boundary, the trailing-24 h expiry) |
| `engine:prune-park`, `engine:blocked-park`, `prune:park` | retry-backoff, base `park.blocked` (pace-up: never shorter than 30 s) |
| `engine:idle` 30 s | local-beat, base `max(2 × DISPLAY.perceptionMs, min(IDLE_MS, earliest FUTURE known event − now))` over session start/end, check due, deadline, refill, chain `retryAt`, frontier `resumeAt`; an event already past whose own gate refuses is ignored (no zero-delay loop); `IDLE_MS` stays the staleness bound |
| `engine:transient-backoff` | base `beat.transient` (pace-up) |
| `engine:refill-pacing` U[2, 5] s | `pause.after-task`, then **deleted** by the `IgActivityClock` slice |
| `engine:active-hours-park` | **deleted** |
| `engine:recovery-hold` | unchanged (D3) |
| `budgetOpen` (after the visit) | `MutationCadence.preflight` **before** the visit; cheap re-check in `armAtDispatch` |
| accept deadline per accept (→ 1 per pass) | `gap.accept` inside the pass; one deadline at pass end |
| prune run pace (legacy × ⅓) | deleted; the shared deadline |
| prune gates (active hours; `cyclePlan(50)`) | preflight per candidate; `day-done`/`ceiling` end the run with a typed reason; never crosses `E` |
| `LegacyPacer`/`legacyVerdict`/`cycle-plan.ts`/`action-gap.ts`/`session-planner.ts` | **deleted** |
| profile-visit dwell logN 9 s | `dwell.visit`; from the activity-clock slice, `IgActivityClock.spaceEntry()` before every IG operation (removes stacked pacers `profile-enricher.ts:194-199`, `engine.ts:1007-1012`) |
| look-before-act (missing) | `dwell.before-press` |
| enrich pace U[2.5, 4.5] s | **deleted**; a non-ok sentinel ends the pass |
| list page pace / rest / fetch retry | `walk.page` / `walk.rest` / `pause.retry` |
| rest stride 5–10 pages | `walk.rest-every` (depth axis; drawn per rest) |
| `pruneScanMin/MaxSeconds` | deleted (→ `walk.page`; a v1 value **slower** than the prior becomes a `tempo.walk.page` override; a faster one is dropped with a notice) |
| dialog / acquisition / drawer scroll waits | `scroll.wait.*` |
| drawer rounds 2 | `NOTIFICATIONS_SCROLL_ROUNDS` stays the runaway bound; depth until the watermark (§9.4) |
| drawer close settle; drawer step pauses (missing) | `drawer.close-settle`; `ui.step-pause` |
| confirm layers of an unfollow (moved as soon as a 250 ms poll saw them) | `ui.step-pause` after each located layer, before travel (§11.1 F2) |
| accepts per pass 20 (≈ 1) | `acceptsAllowed` |
| drawer / dialog scroll depth `2·`/`3·clientHeight` | `max(600, draw(scroll.depth.*)·clientHeight)` |
| reconcile / effect batches 10 / 10 | deleted (§9.7–9.8) |
| enrich batches 20 / 25 / 15 | `min(profilesPerSlice, session explore left)`; the duplicate 25 deleted; 15 → `EXPLORATION_POLICY.ownFollowersPickMax` |
| `ACQUIRE_SKIP_POOL_FACTOR` 4 | `EXPLORATION_POLICY.skipPoolFactor × min(F, queuedPerSource)` |
| page-retry pause (`pauseBeforePageRetry`, sub-cadence of the D4 retry wait, `Math.random` default) | `pause.retry` (pace; floor = the D4 poll interval) |
| travel, per-point delays, pre-press, press, hover settle, wheel pauses | `motion.*`, `wheel.*` (per gesture); speed–accuracy keys co-vary with `motion` |
| micro-drift p .15 ±3 px; initial cursor `U(180,720)/U(160,560)` | `MOTION.driftProbability`/`driftPx` (shape dials); the initial-cursor bands move to `MOTION.initialCursorXPx/YPx` as absolute GEOM values in Phase F (the draw happens in the synchronous constructor, before the async `viewport()` exists, `interactor.ts:44-51,179`); a viewport-relative version is a later PR commit with its own re-baseline |
| step watchdog 8 min | unchanged; every plan wait is a registered `engine:` wait; law L11 bounds in-step silence |
| scheduled-prune watcher + 0–20 min jitter | **deleted** (§14 C14) |
| launch passive catch-up | `catchUp` reserve at ambient tempo (§9.6) |
| resume settle 3–10 s `Math.random` (`foundation-wiring.ts:1307-1310`) | `pause.wake-settle` (pace; floor `LATENCY.probe.p50`) |
| revisit and freshness windows: `lowYieldRevisitMs` 1 d; `endedRevisitMs`, `profileFreshMs`, `enrichmentRetryMs`, `unenrichedUsernames` 7 d | PLAN, through the one boundary: low-yield revisit = the next plan-day start; the others = `planDayStartAfter(WEEKLY_CYCLE)` with `WEEKLY_CYCLE` = 7 plan-days, the period of `HUMAN_CIRCADIAN.dayOfWeek` (one full weekly cycle of the plan; identity with today's 7 d) |
| probe and traffic-harness sleeps (`verify.ts:32`, `traffic.ts:26`, `probe-main.ts:188`) | harness only: draws from the probe's own reference `TempoSource` (`dwell.visit`, `ui.step-pause`); allow-listed as harness, never production |

### 5.17 Projection and copy

`EpoStatus.plan?: PlanProjection | null` (renderer-safe types in `src/shared/plan-projection.ts`) rides the existing
throttled status push, plus an explicit push on `onChanged`. No new push channel.

```ts
export interface PlanProjection {
  readonly day: { key: string; startsAt: number; endsAt: number; quietMinute: number; light: boolean; lateStart: boolean;
    binding: PlanBinding; dayOff: boolean };            // dayOff ONLY from the user's days off (posture keys on it, §12.3)
  readonly revision: number; readonly cause: ReplanCause;
  readonly totals: { planned: number; done: number; remaining: number; automaticMax: number; ceiling: number; outside: number };
  readonly kinds: { follow: Progress; unfollow: Progress; accept: Progress };
  readonly reads: { profiles: Progress; pages: Progress; checks: Progress };
  readonly sessions: readonly { idx: number; startAt: number; endAt: number; planned: number; done: number;
    state: SessionState; mix: 'normal' | 'boost'; probation: boolean; censusHost: boolean; pace: 'relaxed' | 'normal' | 'quick' }[];
  readonly now: { sessionIdx: number | null; nextAt: number | null; closesAt: number | null };
  /** Advanced → Timing → "Today's plan in detail" (read-only; the values the plan really uses). [arch r2] */
  readonly detail: {
    readonly caps: { automaticMax: number; day: number; hour: number; unfollowHour: number; probationHour: number; acceptsPerPass: number };
    readonly sessions: readonly { idx: number; pace: number; motion: number; depth: number;
      gap: { targetMeanMs: number; medianMs: number; floorMs: number; capMs: number; timeScale: number };
      kinds: { follow: number; unfollow: number; accept: number }; reads: { profiles: number; pages: number; checks: number } }[];
  };
}
export declare function paceLabel(pace: number): 'relaxed' | 'normal' | 'quick';   // > 1.15 relaxed, < 0.87 quick
```

Copy (neutral; the sidebar renders): "Today's plan · about 44 actions · 21 done" · "Resets at 2:45 AM" · planned kinds
"33 new follows · 6 cleanups · 5 approvals" · session chips "Done · 12", "Now · 5 of 14", "Next · 6:05 PM", "Skipped — Epo
wasn't running", "Before Epo opened", pace "relaxed · normal · quick" · parks "Between sessions — next at 6:05 PM",
"Today's plan is done — next session tomorrow at 9:04 AM", "Today's sessions had already passed when Epo opened — next
session tomorrow at 9:04 AM" (late start), "Light day — no actions planned today. Next session tomorrow at 9:04 AM"
(zero-volume light day), "Daily limit reached — …", "Hourly limit — continuing at 4:12 PM" · "Easing back in — this
session runs at a gentler pace." · "Day off — Epo does no automatic work today." (only on a day the user set off) ·
retired-setting notice "Steady intervals is retired. Epo now paces every action from your daily plan. For more regular
days, Consistency is set to Even."

---

## 6. Settings v2: Easy and Advanced (items 2, 3)

Source: T2 FINAL (spine L1, grafts from L2/L3), amended by §14. The Settings **page** is a stage tab (§12); this section
is the model, storage and contracts.

### 6.1 Three layers: intent → derived → overrides

```
 persisted (epo-settings-v2.json)                    computed per revision in main (never stored)
 intent        14 plain choices                ──▶   derived  = PARAM_SPECS[k].derive(intent, effective upstreams)
 overrides     { ParamKey → value, setAt, basis } ─▶ bounds   = envelope ∩ guards ∩ coupled bounds
 seed · protection · prefs · app · migration   ──▶   effective = clamp(override ?? derived, bounds)
 legacyCarry (transitional; deleted by §5.13 S2)      → EffectiveSettings (engine) · SettingsView (renderer) · PlanIntent
```

- **Intent** = the eight kernel ordinals (activity, caution, rhythm, consistency, dayShape, weeklyShape, patience,
  cleanup without `deep`) + `quietHours`, `daysOff`, `mutuals: 'rotate' | 'keep'`, `audienceFocus`, `audienceSize`,
  `preferPrivate`.
- **Derived** numbers are computed at read time in topological order from the **effective** upstreams (an overridden
  daily volume of 60 makes the recommended ceiling `round(60 × CEILING_HEADROOM)` = 78). This ends today's silent
  revert (`settings.ts:397-414` re-derives all 14 numbers on every save).
- **Override** `{ value, setAt, basis }`: `value` is what the user asked; clamping happens at resolve time and is
  reported; `basis` is the recommendation when set (drives "stale" detection). An override replaces a **reference
  parameter** (for example the median of the day-volume draw, or a tempo spec's reference factor); **it never replaces
  a drawn value** — the plan still draws every day's numbers [owner item 1].
- An intent change never deletes an override; out-of-bounds overrides are clamped with an `Adjustment`; moving the
  intent back restores them. Intent changes that move an overridden key's recommendation return an
  `OverrideConflict` rendered inline ("You set **Most actions in an hour** yourself (30). *Gentle* would use 14.
  [Use 14] [Keep 30]").

### 6.2 The envelope rule and coupled bounds (A3/A4 made mechanical) [arch-adopted from T2; ADR 0608]

- Every `ParamSpec` declares `risk: 'higher-is-riskier' | 'lower-is-riskier' | 'neutral'`.
- **Risky side** bounded by the most permissive value the kernel derives anywhere on the ordinal grid **or** in the
  plan's own draws (`src/kernel/derive-envelope.ts` `ENVELOPE`, computed once): `pace.hourlyCap ≤ 30`,
  `pace.dailyVolume ≤ 100`, `pace.dailyCeiling ≤ 130`, `unfollow.waitDays ≥ 2`, `checks.everyHours ≥ 0.85` (the
  briskest derived check spacing, `scaleAbove(60 min, 30 min, BEAT_MIN)` = 51 min); every timing row — `tempo.*`,
  `sessions.gapTypical`, `sessions.gapMinimum` — is **slower-only** (factor ≥ 1, or ≥ the recommended effective value)
  [arch r2]. An override never raises a read total: D6 reads the slower of the override and the derived value. Going
  past the envelope means changing a POLICY dial (an ADR). Law: `ENVELOPE.hourlyCap.max ≤
  EMPIRICAL.FOLLOW_WALL_PER_HOUR.low`.
- **The automatic day is not an override target.** A `pace.dailyVolume` override changes `P0` (the automatic day stays
  ≤ `automaticDayMax(P0)`); a `pace.dailyCeiling` override moves only `M`, i.e. the headroom for single manual actions
  and outside residuals, never `V`.
- **Safe side** bounded by named guards in `src/kernel/settings-policy.ts` `SETTINGS_GUARDS` (one guard line each).
- **Coupled bounds** from effective upstreams: `gapMinimum ≥ burstFloorSeconds(effective cap) = ⌈3600/(cap ×
  BURST_TOLERANCE)⌉` (this also raises today's 15 s clamp floor to the 20 s safety law); `gapMinimum ≤ gapTypical`;
  `dailyCeiling ≥ dailyVolume`; `cleanupPerDay ≤ dailyCeiling`; ratio curve ordered; follower range ordered;
  sessions min ≤ max.
- **Boost is not an override**: it can never use the envelope to raise anything.
- **Quiet hours**: `{kind:'derived'}` resolves through `deriveQuietHours(dayShape)` = the contiguous overnight
  interval where weekday λ < `QUIET_INTENSITY_FRACTION` (0.2) × peak, edges snapped to 30 min, ≤ `QUIET_MAX_HOURS` (16)
  (balanced ≈ 23:30–06:00, morning ≈ 22:30–05:00, evening ≈ 01:00–06:30, night owl ≈ 04:30–08:00, business
  ≈ 22:00–05:30; the derive-schedule test pins exact values). `{kind:'custom', startMinute, endMinute}` (30-min grid,
  may wrap, start ≠ end) or `{kind:'none'}`.
- **Feasibility** (`derive-schedule.ts`): `feasibility({dailyVolume, hourlyCap, massHours})` with the quiet-hours and
  days-off mask; binding `'hourly-cap'` when raising the cap to the envelope max would make the volume reachable, else
  `'active-time'` (the rule `deriveOperatingPlan` already uses, `derive.ts:527-533`). The live plan's own feasibility
  (§5.4 step 10) is authoritative once the plan port is registered.
- **Risk level** `riskRung(effective)` = max(daily rung from volume vs `ACTIVITY`, hourly rung from cap vs `CAUTION`) →
  `low | standard | elevated | at-limit`. A change that moves the level to `at-limit` needs a once-per-app-session
  acknowledgement ("This runs at the low end of what Instagram is known to allow in a day. Some accounts get
  temporarily restricted at this pace. Continue?").

### 6.3 When a change applies

`ApplyWhen` is part of every spec and every save note: `now` (the live component config reloads, diffed),
`replan` (a §5.6 `settings` re-plan: today's remainder redrawn, counters kept), `next-day` / `next-start` (only while
the plan port is not registered; copy always states the truth for the capability in force).

**Capabilities** (`SettingsView.capabilities = { plan, tempo, boost, protectionEverywhere }`) are set by main when the
dependency is wired. The renderer hides plan-dependent controls (quiet hours, days off, Today/This week previews, the
Timing section, the Boost section) while their flag is false, and shows the old protection copy while
`protectionEverywhere` is false. Each wiring site sets its flag in the same commit; a main test asserts every flag is
true in the fully composed graph (Phase I gate).

### 6.4 Easy mode (no sliders, no timings)

Seven sections, each a heading + one-sentence question + controls. Every number shown comes from
`SettingsView.options` (precomputed per revision, instant hover with no IPC), `SettingsView.typical` or the facts
projection.

| Section | Question | Controls (kind) | Writes |
|---|---|---|---|
| **Growth pace** | "How quickly should Epo grow your account?" | 3 intent cards with live numbers: **Gentle** (light + cautious, about 26 a day), **Balanced** · Recommended (moderate + standard, about 44 a day), **Faster** (active + standard, about 66 a day) — the median of the day law (§5.4) at the user's consistency, from `SettingsView.options`; no per-hour figure in Easy. Below: "Most days land between 29 and 47" (the law's p10–p90, computed by the kernel); safety meter "Epo's own work never uses more than 48% of the lowest daily follow limit Instagram is known to apply" (`automaticDayMax(P0)/FOLLOW_WALL_PER_DAY.low`; the meter's end tick is the hard stop `M`, which only your own actions can reach); feasibility line when short; a selected "Your own mix" pseudo-card when overrides exist | `activity`, `caution` |
| **When Epo works** | "When should Epo be active?" | 5 day cards with 24-bar previews (Through the day · Mornings · Evenings · Late nights · Work hours); quiet-hours row (derived · set my own · none); day-off chips (at most 6 of 7 days; choosing all 7 offers Stop instead); 3 session-style cards (Many short visits 5–9 · **A few regular sessions** 3–6 · A couple of longer sessions 2–4) | `dayShape`, `quietHours`, `daysOff`, `rhythm` |
| **Who to follow** | — | starting-account field (§13); account size cards (Smaller ≤2,000 · **Everyday** 50–20,000 · Larger ≤100,000); "Prefer" (likely to follow back / reach more people, `AUDIENCE_WIDEN_FACTOR` 1.5 in log space); "Give private accounts a small edge"; **Follow requests**: "Accept follow requests automatically" (accepting is growth, so it lives here, not under Unfollowing) | `seed`, `audienceSize`, `audienceFocus`, `preferPrivate`, `prefs.acceptRequests` |
| **Unfollowing** | "Epo unfollows people it followed who didn't follow back… Everyone in Protection is always kept." | follow-back wait 2 days · **4 days** · 1 week; "When someone follows you back": Unfollow after the hold (rotate, default) / Keep following (disables rotation); "People you followed yourself": **Leave them alone** · a few a day · more each day (opt-in confirm sheet with the last census numbers; with cleanup off a manual scan never starts unfollowing) | `patience`, `mutuals`, `cleanup` |
| **Protection** | identical in Easy and Advanced (§7.8) | people list with typeahead, keyword chips with live counts, verified toggle | `protection.*` |
| **Boost** | preferences only — **the only place to choose the length** (the sidebar button starts a Boost with this length in one tap) | default length chips 2 · 4 · 8 · **12** · 24 h; "Keep accepting follow requests during Boost" (on) | `prefs.boost` |
| **Practice & app** | — | Practice mode (`dryRun`; off asks to confirm); Updates (honest `unchecked/unavailable/up-to-date`); Replay intro; Reset to recommended; Clear data & log out ("Your settings and protection list are kept.") | `prefs.practice`, app ops |

Easy never shows timings, per-hour arithmetic, read allowances, retries, refill thresholds, census cadence or
Advanced-only rungs. A section with overrides shows "Fine-tuned in Advanced (2) · [Review] · [Use recommended]".

**One word per concept** [arch r2]: pace cards **Gentle · Balanced · Faster**; consistency **Even · Typical ·
Varied**; cleanup **Leave them alone · a few a day · more each day**; session chips **relaxed · normal · quick**; the
stage tab, the posture and every Settings line say **Prune** ("Prune" tab, "Pruning" posture); the protected
accounts belong to **Protection**, never "whitelist" (recorded owner Q28, §18.3). The card numbers ("about 44 a day") are illustrative values at Typical
consistency and come from `SettingsView.options`, never from copy.

### 6.5 Advanced mode

Advanced is **Easy plus a "Fine-tune" block** under each section (nothing moves), plus five Advanced-only sections:
**Timing** (opens with the read-only **"Today's plan in detail"** block rendered from `status.plan.detail`: per
session start/end, kind budgets, pace factor, effective gap target/median/floor/cap, dwell and motion factors, read
buckets; per day the window, quiet minute, automatic maximum, ceiling, hourly, unfollow-hourly and probation-hourly caps,
accepts per pass — then the `tempo.*` rows; hidden until `capabilities.tempo`), **Finding new people** (`explore.*` +
read-only `EXPLORATION_POLICY` rows), **Limits & reading** (read-only: D6 reads per plan-day and the trailing backstop,
`EMPIRICAL` walls with `src`/`rev`, POLICY dials, the envelope, the risk level), **Under the hood** (read-only, generated
by main from **every** kernel tier-1 module — the registry with tier and provenance, `TEMPO_POLICY`, `PLAN_POLICY`,
`SETTINGS_POLICY`, `SURFACE_BOUNDS`, `CENSUS_POLICY`, `BOOT`, `LIVE`, `RUNTIME_BOUNDS`, `STORE_POLICY`,
`BOUNDS_REENTRY`, `EXPLORATION_POLICY`, the `MOTION` table with roles and shape-dial guard lines — served through
`settingsBasis`; a kernel test asserts every exported tier-1 entry appears in the catalog), **Diagnostics** (the log
panel, the Instagram compatibility panel).

Row anatomy (`ParamView`, rendered generically): label + one-line help (never hover-only); control by kind (`int`/
`number` stepper + typed input with unit, committing on Enter/blur, reverting on Esc; `range` two inputs; `curve` a
small SVG + six inputs; `bool` toggle); "Recommended {v}" with its provenance chain; "SET BY YOU" + "Use recommended"
only when overridden; stale/clamped/inactive notes.

Intent choices also appear as Advanced rows at the top of their sections: activity (Very light 15 · Light 30 ·
Moderate 50 · Active 75 · **Maximum** 100 — the daily target `P0`, with the at-limit acknowledgement), caution
(Careful ≤ 14/h · Standard ≤ 22/h · Quicker ≤ 30/h), consistency (**Even · Typical · Varied** — kernel keys
`clockwork`/`natural`/`erratic`), weekly shape (Every day the same · Typical week · Mostly weekdays · Mostly weekends),
keyword match (anywhere / whole words).

**The catalog** (T2 `ParamKey`s; T1 appends `tempo.*`; v1 key in the last column):

| `ParamKey` | Label | Recommended from | Risk | Bounds (risky · safe) | Applies | v1 key |
|---|---|---|---|---|---|---|
| `pace.dailyVolume` | Daily action target (Epo's days vary below it and never pass ≈ 97 % of it on their own) | `dailyPlan(activity)` 15/30/50/75/100 | ↑ | E ≤ 100 · G ≥ 1 | replan | `dailyOperatingRate` |
| `pace.dailyCeiling` | Most actions in a day, including your own (the hard stop; it never raises Epo's automatic day) | `round(volume × CEILING_HEADROOM)` | ↑ | E ≤ 130 · C ≥ volume | now | `dailyHardCeiling` |
| `pace.hourlyCap` | Most actions in an hour | `CAUTION[caution].cap` 14/22/30 | ↑ | E ≤ 30 · G ≥ 1 | now | `hourlyVelocityCap` |
| `pace.dayVariation` | Day-to-day variation (%) | `VARIANCE_PCT[consistency]` 12/28/45 | · | E [0, 45] | replan | `dailyVolumeVariancePct` |
| `pace.restDayChance` | Chance of a lighter day (%) | `REST_DAY_PCT[consistency]` 0/8/18 | · | E [0, 18] | replan | `restDayChancePct` |
| `pace.candidateBuffer` | People prepared per day | `round(volume × PLAN_BUFFER)` | ↑ | E ≤ 120 · G ≥ 1 | now | `dailyPlanSize` |
| `sessions.perDayMin` / `sessions.perDayMax` | Sessions a day | `RHYTHM[rhythm]` | · | E [2, 9] · C min ≤ max | replan | `sessionsPerDayMin/Max` |
| `sessions.gapTypical` | Average pause between actions (at a normal-pace session; the value shown is the one the plan uses) | `3600·CEILING_HEADROOM/H/BEAT_MIN` = 304 s Standard · 477 s Cautious · 223 s Bold (§5.10) | ↓ | slower only: ≥ recommended · ≤ 3 × recommended | replan | `gapMedianSeconds` (a non-derived v1 value carried as the same ratio, only when slower) |
| `sessions.gapMinimum` | Shortest pause between actions (effective) | the plan's floor at pace 1, `gapFloorSeconds·τ_ref` (≈ 130 s Standard) | ↓ | slower only: ≥ recommended · C ≥ the burst floor of the effective cap · C ≤ gapTypical | replan | `gapFloorSeconds` (same rule) |
| `unfollow.waitDays` | Days to wait for a follow-back | `PATIENCE[p].waitDays` 2/4/7 | ↓ | E ≥ 2 · G ≤ 60 | now | `maxWaitForFollowbackDays` |
| `unfollow.holdDays` | Days to keep someone who followed back | `PATIENCE[p].holdDays` 1/2/4 (inactive when `mutuals:'keep'`) | ↓ | E ≥ 1 · G ≤ 60 | now (future holds) | `holdAfterFollowbackDays` |
| `unfollow.cleanupShare` | Most of a session spent pruning | `CLEANUP[cleanup]` share of room (inactive when off) | ↑ | E ≤ 0.5 · G ≥ 0 | replan | `maxUnfollowFractionPerSession` (+`weaveEnabled`) |
| `unfollow.cleanupPerDay` | Most cleanup unfollows a day | the plan's `U_prune` (lowering override only) | ↑ | C ≤ effective ceiling · G ≥ 0 | replan | `pruneDailyLimit` |
| `unfollow.censusEveryDays` | Re-check who follows you back every (days) | the plan's census slot (patience) | ↓ | G [1, 30] | replan | `pruneScheduleDays` |
| `unfollow.attempts` | Attempts before skipping an account (follows and unfollows) | `retryLimit()` (3) | · | G [0, 10] | now | `maxRetries` |
| `checks.everyHours` | Check for new followers every (hours) | `check.spacing` (1 h at the reference) | ↓ | E ≥ 0.85 h (the briskest derived spacing) · G ≤ 24; D6 uses the slower of override and derived | replan | `followbackSweepHours` |
| `audience.followerRange` | Follower range | `AUDIENCE_SIZE[size]` | · | G min ∈ [0, 10 M], max ∈ [1, 100 M]; C min ≤ max | now | `minFollowers`/`maxFollowers` |
| `audience.ratioCurve` | Follow-back curve (six points) | `audienceCurve(focus)` | · | G each ∈ [0, 100]; ordered | now | `bandLow…hardHigh` |
| `audience.privateBoost` | Edge for private accounts | 0 or `PRIVATE_EDGE` 0.15 | · | G [0, 0.5] | now | `privateBoost` |
| `audience.mutualWeight` / `mutualCap` / `bandEdgeScore` | Scoring details | `SETTINGS_POLICY.RECOMMENDED` 1.5 / 20 / 0.6 (today `SCORER_DEFAULTS`) | · | G [0, 5] / [0, 100] / [0, 1] | now | — |
| `explore.moveOnRate` | Move on from a source below this follow-back rate | `EXPLORATION_POLICY.priorRate` (linked) | · | G [0, 1] | now | `minFollowBackRate` |
| `explore.moveOnPool` | …or when fewer people are left than | `RECOMMENDED.minPoolSize` 300 | · | G [0, 5 000] | now | `minPoolSize` |
| `explore.refillBelow` | Find more people when fewer than N are waiting | `RECOMMENDED.lowWaterCandidates` 5 | · | E ≤ `queuedPerSource` (10) · G ≥ 0 | now | `lowWaterCandidates` |
| `tempo.<TempoKey>` (all keys except `gap.action`, `check.spacing`) | e.g. "Time spent on each profile (reference)" | the tempo-1 prior (the row also shows today's effective range from the plan) | ↓ | slower only: factor ∈ [1, `TEMPO_OVERRIDE_MAX_FACTOR` 3] | replan | `pruneScan*Seconds` → `tempo.walk.page` (only when slower) |

Compile-time exhaustiveness on both sides (`PARAM_SPECS satisfies {[K in ParamKey]: ParamSpec<K>}`;
`PARAM_COPY`/`INTENT_COPY` likewise); a test asserts each key sits in exactly one section and `TOPO_ORDER` is acyclic.
**Search** (`/` or ⌘F) covers titles, labels, help, options and synonyms including every v1 name ("whitelist",
"bio keep-words", "persona", "dry run", "seed", "active hours", "pacing", "jitter" …); in Easy a hit in an
Advanced-only row reads "In Advanced → Finding new people · Show". The mode switch `[Easy | Advanced]` persists as
`app.mode`, never changes a value, keeps the scroll anchor; new and migrated users start in Easy.

### 6.6 One global document, a single writer, persist-first saves

- **File** `userData/epo-settings-v2.json`; v1 `epo-settings.json` is **never written again** (older builds keep their
  lists). **Global** for the install [arch-adopted from T2, owner Q13 default]: protection by pk is safe across
  accounts; per-account run state (plan, Boost, frontiers, cadence stamps) lives in each account's store.
- **Persist protocol** (`src/settings/persist.ts`, injectable fs): write = serialize with `rev + 1` → copy the current
  file to `.bak` (failure = write failure) → write `.tmp`, `fsync`, close → `rename` → fsync the directory (best
  effort, logged) → any failure returns `{ok:false}` with the in-memory doc unchanged. The **first** successful v2 write
  also writes the marker `epo-settings-v2.created` (`{createdAt, fromV1Sha256}`), which nothing ever deletes.
- **Read protocol** (at service construction, before any IPC handler can run; first matching row wins) [arch r2]:

  | Situation | Result |
  |---|---|
  | v2 parses | coerce; `health: ok` (or `migrated` once) |
  | v2 unreadable | rename to `epo-settings-v2.corrupt-<epoch>.json` (never deleted) → try `.bak` → `restored-from-backup`, `protectionState: needs-review` |
  | v2 **missing** but evidence of a previous v2 exists (`.bak`, any `.corrupt-*`, or the `.created` marker) | `.bak` readable → `restored-from-backup`, `needs-review`; else v1 present → `remigrated-from-v1`, `needs-review` — **never** a silent `ready` re-migration (it would drop every protected account and keyword added since the first migration, because v1 is frozen at migration time) |
  | v2 and `.bak` unreadable, v1 present | re-migrate from v1 → `remigrated-from-v1`, `needs-review` |
  | none readable, a knowledge DB exists | defaults → `defaults-after-unreadable`, `needs-review` |
  | nothing at all, no DB | fresh install: defaults, `ready` |
  | v2 missing, **no** v2 evidence, v1 present | **migrate** (§6.10) → `ready` |

  A deliberate re-migration is an explicit app action (op `{op:'migration', action:'remigrate-from-v1'}`, Advanced →
  Practice & app, with a confirm sheet naming what is replaced; result `needs-review`), never a file deletion.

- **Single writer** `SettingsService.apply(ops, origin)` (`src/main/modules/settings-service.ts`): coerce each op
  (ADR 0103: nearest safe value, never a throw; shape already checked by the IPC guard) → resolve next effective
  settings and conflicts → **persist first** (failure → `{kind:'not-saved'}`: no swap, no reload, no push, nothing
  applied — the root fix for "failed saves shown as Saved", `foundation-wiring.ts:1762-1773, 1836-1848`) → commit
  (swap doc and rev, recompile `ProtectionIndex`, rebuild the cached view) → emit `SettingsChangeEvent` (diffed config
  reload; plan `onSettings` when the plan fingerprint changed; `ProtectionReconciler.reapply('rules')` when protection
  changed; `settingsFacts` push) → push `epo:settings` → return `saved`. Every writer goes through it: renderer ops,
  `restartFromSeed`, pk linking, the tour, migration, re-import.
- **Diffed reload** (`src/main/modules/settings-reload.ts`) replaces `Foundation.reloadConfigs`
  (`foundation-wiring.ts:1851-1866`): each projected config (`toChurnConfig`, `toScorerConfig`, `toScannerConfig`,
  `toFollowbackConfig`, `toChainConfig`, `toPruneConfig`, `toRateGovernorConfig`) is compared between prev and next;
  only changed components reload. A protection or seed edit no longer rescans the whole queue.
- **Bookkeeping leaves Settings entirely.** The follow-back sweep's last run lives in `reopen_state.lastSweep` (§9);
  the scheduled bulk prune is retired (§14 C14). That ends 2–4 full settings rewrites per hour and the identity-change
  settings write (`foundation-wiring.ts:286-288`).

### 6.7 Ops, results, undo, reset

```ts
export type SettingsOp =
  | { op: 'intent'; key: IntentKey; value: Intent[IntentKey] }
  | { op: 'override'; key: ParamKey; value: ParamValue } | { op: 'clear-override'; key: ParamKey }
  | { op: 'seed'; handle: string }
  | { op: 'protect-add'; entries: readonly { username: string; pk?: string }[]; source: ProtectedAccount['source'] }
  | { op: 'protect-remove'; match: { pk?: string; username?: string } }
  | { op: 'protect-restore'; accounts: readonly ProtectedAccount[]; words: readonly KeepWord[] }
  | { op: 'word-add'; texts: readonly string[] } | { op: 'word-remove'; text: string }
  | { op: 'protect-rule'; rule: 'keepVerified'; value: boolean } | { op: 'protect-rule'; rule: 'wordMatch'; value: 'anywhere' | 'whole-word' }
  | { op: 'protect-link'; pk: string; username: string; at: number }                 // system only
  | { op: 'pref'; key: 'practice' | 'acceptRequests' | 'boost.acceptRequests'; value: boolean } | { op: 'pref'; key: 'boost.hours'; value: number }
  | { op: 'ui'; mode: 'easy' | 'advanced' } | { op: 'tour-completed'; at: number } | { op: 'tour-version-seen'; version: string }
  | { op: 'dismiss-notice'; id: string } | { op: 'acknowledge-protection' } | { op: 'import-older-version' }
  | { op: 'migration'; action: 'retry' | 'start-from-recommended' | 'remigrate-from-v1' }   // recovery ops (§6.10, §6.6)
  | { op: 'consume-bookkeeping' }                                                     // system only
  | { op: 'reset'; scope: { kind: 'recommended' } | { kind: 'section'; section: SectionId } };
export type SettingsSaveResult =
  | { kind: 'saved'; view: SettingsView; adjustments: readonly Adjustment[]; conflicts: readonly OverrideConflict[];
      applies: readonly ApplyNote[]; inverse: readonly SettingsOp[] }
  | { kind: 'not-saved'; view: SettingsView; detail: string }                         // NOTHING changed
  | { kind: 'refused'; view: SettingsView; reason: 'invalid' | 'internal' | 'migration-pending' | 'protection-not-migrated'; detail: string };
```

- Ops in one call apply atomically. `protect-link` and `consume-bookkeeping` are refused for `origin: 'user'`.
  While a migration was refused (§6.10) every op except `migration` and `ui` is refused with `migration-pending`.
- **Undo** = the `inverse` ops returned with every `saved` result (no server state). Law: `apply(apply(d, ops).inverse)`
  restores `d`.
- **Reset to recommended** changes intent and clears all overrides; it **never** touches the seed, protection (lists,
  rules, state), practice mode, accept-requests, Boost preferences, mode, tour, notices, bookkeeping, Boost state or
  plan state. Reset section: that section's intent + overrides. The confirm is built from
  `previewSettings([{op:'reset', …}])` and highlights lines that would make Epo unfollow more or sooner.

### 6.8 The renderer change queue (`src/renderer/settings/change-queue.ts`)

Optimistic overlay per control key with a pending dot; sends are sequential, coalesced per key; `saved` → clear,
adopt the view by `rev`, "Saved · Undo"; `not-saved`/`refused` → revert, inline error, header "Couldn't save —
nothing was changed. [Try again]". **No debounce** (no loss window at quit; `AUTOSAVE_MS=600` retires): discrete
controls send on change, number inputs on Enter/blur, steppers per click (coalesced), chips on Add. Pushes are ordered
by `rev`; older revs are ignored; pending overlays re-apply on top of a newer view. The initial pull retries through
`useKeepAlivePoll` with an `onError` hook ("Couldn't load settings. [Retry]"; the hook lands in Phase F's renderer kit,
so the Settings and shell streams do not depend on each other for it). The silent catches in
`PruneView.tsx:98-108` and `useTourGate.ts:59-64` go.

### 6.9 Contracts

```ts
// src/shared/settings-intent.ts (pure, no imports; a test pins each tuple to the kernel's key set)
export const ACTIVITY_LEVELS = ['minimal', 'light', 'moderate', 'active', 'aggressive'] as const;
export const CAUTIONS = ['cautious', 'standard', 'bold'] as const;
export const RHYTHMS = ['trickle', 'sessions', 'bursts'] as const;
export const CONSISTENCIES = ['clockwork', 'natural', 'erratic'] as const;
export const DAY_SHAPES = ['balanced', 'morning', 'evening', 'nightowl', 'business'] as const;
export const WEEKLY_SHAPES = ['realistic', 'uniform', 'weekdays', 'weekends'] as const;
export const PATIENCES = ['quick', 'normal', 'patient'] as const;
export const CLEANUP_LEVELS = ['off', 'trickle', 'steady'] as const;     // kernel 'deep' retired from intent
export const MUTUAL_POLICIES = ['rotate', 'keep'] as const;
export const AUDIENCE_FOCUSES = ['likely', 'wide'] as const;
export const AUDIENCE_SIZES = ['small', 'everyday', 'larger'] as const;
export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;                         // Sun..Sat; UI renders Mon-first
export type QuietHours = { kind: 'derived' } | { kind: 'custom'; startMinute: number; endMinute: number } | { kind: 'none' };
export interface Intent { activity; caution; rhythm; consistency; dayShape; weeklyShape; quietHours: QuietHours;
  daysOff: readonly DayOfWeek[]; patience; mutuals; cleanup; audienceFocus; audienceSize; preferPrivate: boolean }
export const PACE_CARDS = { gentle: { activity: 'light', caution: 'cautious' }, balanced: { activity: 'moderate', caution: 'standard' },
  faster: { activity: 'active', caution: 'standard' } } as const;
export const MAX_DAYS_OFF = 6;                                             // seven days off is "Stop", not a plan

// src/settings/doc.ts (main only)
export interface SettingsDocV2 { v: 2; rev: number; intent: Intent; seed: string;
  overrides: Readonly<Partial<Record<ParamKey, { value: ParamValue; setAt: number; basis: ParamValue }>>>;
  protection: ProtectionSettings; protectionState: 'ready' | 'needs-review' | 'unavailable';
  prefs: { practice: boolean; acceptRequests: boolean; boost: { hours: number; acceptRequests: boolean } };
  app: { mode: 'easy' | 'advanced'; tourCompletedAt: number | null; tourVersionSeen: string | null; dismissedNotices: readonly string[] };
  migration: MigrationRecord | null; legacyCarry: LegacyCarry | null /* @transitional: deleted by §5.13 S2 */ }

// src/settings/effective.ts — the engine-facing record; keeps v1 field names wherever the meaning is unchanged
export interface EffectiveSettings { seed: string; /* scorer */ bandLow; bandHigh; peakLow; peakHigh; hardLow; hardHigh;
  minFollowers; maxFollowers; privateBoost; mutualWeight; mutualCap; bandEdgeScore;
  /* lifecycle */ maxWaitForFollowbackDays; holdAfterFollowbackDays; rotateMutuals: boolean; maxRetries; autoAcceptFollowRequests: boolean;
  /* plan inputs */ pattern: OrdinalPattern; dailyOperatingRate; dailyHardCeiling; dailyPlanSize; dailyVolumeVariancePct;
  restDayChancePct; sessionsPerDayMin; sessionsPerDayMax; gapMedianSeconds; gapFloorSeconds /* reference shape */; hourlyVelocityCap;
  gapTargetOverrideSeconds: number | null; gapFloorOverrideSeconds: number | null;   /* effective scale, slower only */
  quietHours: { startMinute: number; endMinute: number } | null; daysOff: readonly DayOfWeek[];
  checkSpacingHoursOverride: number | null; cleanupPerDayOverride: number | null; censusEveryDaysOverride: number | null;
  tempoOverrides: Readonly<Partial<Record<TempoKey, number>>>;     /* factors ∈ [1, 3] */
  /* cleanup */ weaveEnabled: boolean; maxUnfollowFractionPerSession: number;
  /* exploration */ lowWaterCandidates; minFollowBackRate; minPoolSize;
  /* prefs */ dryRun: boolean; boost: { hours: number; acceptRequests: boolean };
  /* @transitional (S2 deletes) */ pacingModel; minDelayMinutes; maxDelayMinutes; jitterPercent; activeHoursStart; activeHoursEnd;
  /* @transitional (protection enforcement deletes) */ pruneWhitelist: string[]; pruneBioFilterWords: string[];
  /* @transitional: derived from the v2 doc so today's consumers keep running; deleted with their consumers */
  followbackSweepHours: number /* RO-b: the sweep cadence moves to plan checks */;
  pruneDailyLimit: number; pruneScheduleDays: number /* PR S2: prune daily plan and scheduled prune deleted */;
  pruneScanMinSeconds: number; pruneScanMaxSeconds: number /* PR S2: walk.page tempo */ }
// NO alias. The engine imports EffectiveSettings from src/settings/effective.ts. The renderer-facing `Settings` that
// src/types.ts exports stays the FROZEN v1 interface (src/settings/v1/settings-v1-types.ts), filled by the transitional
// adapter's toV1Settings(view), until SU's last commit deletes the old UI; backend streams can therefore delete
// engine-facing fields without breaking the old renderer's typecheck [arch r2].

// src/main/modules/settings-service.ts
export interface SettingsService {
  view(): SettingsView; effective(): EffectiveSettings; protection(): ProtectionIndex;
  apply(ops: readonly SettingsOp[], origin: 'user' | 'system'): SettingsSaveResult;
  preview(ops: readonly SettingsOp[]): SettingsPreviewResult;     // pure: no persist, no push, no plan mutation
  basis(): BasisResult; onChange(fn: (e: SettingsChangeEvent) => void): () => void;
  bindStore(binding: SettingsStoreBinding | null): void; setCapabilities(patch: Partial<SettingsCapabilities>): void;
  setPlanPort(port: PlanPreviewPort | null): void;
}
/** Implemented by PlanService (§5.15); pure; never mutates the live plan. */
export interface PlanPreviewPort {
  fingerprint(e: EffectiveSettings): string;                       // differs ⇔ a re-plan event
  previewDays(e: EffectiveSettings, at: number, days: number): readonly PlanPreviewDay[];
  feasibility(e: EffectiveSettings): Feasibility;
}
```

`SettingsView` = `{ rev, health, capabilities, mode, intent, seed, protection, protectionState, prefs, easy
(card match incl. 'custom'), options (numbers for every choice), typical (perDay low/typical/high, ceiling,
perHourMax, sessions, shareOfLowWall, risk, feasibility, week: PlanPreviewDay[] | null), params: ParamView[], reads
(D6, window 'plan-day'), overrides {count, stale, bySection}, effective (summary other views may read), notices, app }`.
`SettingsFacts` (store-derived projection) = `{ built, seed: SeedStatus, ownAccount {isPrivate}, protection
{followingKnown, protectedFollowing, byRule, byWord, bioUnread, entries, kept {total, unreadable}}, cleanup {census
{at, candidates, protectedAmong, verifiedComplete, tooLarge}} }`. Appendix B holds every field.

### 6.10 Migration v1 → v2 (crash-safe, idempotent, downgrade-safe)

Runs at service construction when v2 is missing and v1 exists. Reads the **raw** v1 JSON and records
`{mtimeMs, sha256}`; runs today's own v1 pipeline (`sanitizeSettings(migrateLegacyPattern(parsed))`, moved verbatim to
`src/settings/v1/settings-v1.ts`) to resolve every v1 quirk; maps per the table; reads **both protection lists from
the raw object** (non-string items counted; any drop → `needs-review`). Post-conditions (any failure throws
`MigrationRefused` and never "fixes up"): account-list count = unique normalized raw handles; word count = unique
folded non-blank raw words; seed preserved; `effective(doc)` equals the v1-sanitized object on every retained numeric
key except documented exceptions (cleanup scope, `deep → steady`, values the new bounds clamp, each with a
`value-clamped` note). **v1 is never written or deleted.** Edits made later by an older build are detected by
`{mtimeMs, sha256}` and offered as a **union-only** re-import ("Settings were changed in an older version of Epo: 2
protected accounts and 1 keyword were added there. [Add them here] [Ignore]"); removals there are never applied.

**On refusal (`MigrationRefused`)** [arch r2]: the readable v1 is **not** discarded. The in-memory state is built from
v1 itself — `effectiveFromV1(v1)` (the Phase F adapter: every engine number as v1 resolved it) plus protection read from
the raw v1 lists (each counted; unparseable items listed in the review sheet) and `dryRun` carried (practice mode stays
on if it was on); `health: 'migration-refused'`, `protectionState: 'needs-review'` (no automatic unfollow on any path);
**no v2 is written**. Every `apply` is refused with `migration-pending` except the recovery ops `migration: retry` (runs
the migration again now) and `migration: start-from-recommended` (an explicit, confirmed choice that writes a fresh v2
from recommended intent while keeping the raw v1 lists and practice mode), plus `ui`. `acknowledge-protection` is
refused (`protection-not-migrated`) while the lists did not come from a successful migration. The next launch retries
the migration automatically. Integration test: a refusal keeps practice mode on, writes no v2 after any user op, and
keeps unfollows paused.

**Derived-number rule (†):** for a key derived in v2, write an override `X := v1.X` only if `v1.X ≠ V1_DERIVED(v1.pattern).X`,
where `V1_DERIVED` (`src/settings/v1/derive-v1.ts`) is the **frozen** snapshot-era derivation — today's
`derivePattern` results at the 30 ordinal grid points and the persona points, pinned by a test against
`tests/kernel/legacy-config.snapshot.ts` — never the live `derivePattern` [arch r2]. Otherwise every cautious install
whose v1 floor is 60 would migrate with a spurious `sessions.gapMinimum` override once the derived cautious floor
becomes 70 (owner Q11). A normal install of any persona migrates with **zero overrides**.

| v1 key(s) | v2 home | Rule |
|---|---|---|
| `seed` | `seed` | trim, strip `@`; preserved |
| `bandLow…hardHigh` (6) | `audienceFocus` / `audience.ratioCurve` | all default → `likely`, no override; else `likely` + one ordered, clamped composite override |
| `minFollowers`, `maxFollowers` | `audienceSize` / `audience.followerRange` | exact bucket match → that size; else `everyday` + override |
| `privateBoost` | `preferPrivate` / `audience.privateBoost` | `> 0` → true; override if ∉ {0, 0.15} |
| `maxWaitForFollowbackDays`, `holdAfterFollowbackDays` | from `patience` | † |
| `maxRetries` | `unfollow.attempts` | override if ≠ 3 |
| `dailyHardCeiling`, `dailyOperatingRate`, `dailyPlanSize` | from `activity` | † |
| `minDelayMinutes`, `maxDelayMinutes`, `jitterPercent`, `pacingModel` | `legacyCarry` (before S2) / intent (after S2) | carried verbatim until §5.13 S2 deletes the pacer [lead]; from S2 on, `migrate-v1` applies `legacy-pacing-migration.ts` directly (legacy → consistency `clockwork` (Even) + rhythm `trickle`, notice) |
| `activeHoursStart`, `activeHoursEnd` | `legacyCarry` + `intent.quietHours` | carried until S2; default (8, 22) → `{kind:'derived'}`; hand-edited → `{kind:'custom', startMinute: end·60, endMinute: start·60}` (notice) |
| `followbackSweepHours` | `checks.everyHours` | override if ≠ 1 **and** ≥ 0.85 h (the envelope); a faster value is dropped with a notice |
| `sweepLastRunAt`, `sweepIntervalFactor` | `migration.bookkeeping` → persist the first account's ownership → durable `consume-bookkeeping` → seed `reopen_state.lastSweep` (§9) only after success | the factor is dropped; ownership remains explicit in the normal settings backup (ADR 0105) |
| `autoAcceptFollowRequests` | `prefs.acceptRequests` | copy |
| `lowWaterCandidates` | `explore.refillBelow` | override if ≠ 5; clamped ≤ 10 (it was inert above 10) with a notice |
| `minFollowBackRate`, `minPoolSize` | `explore.moveOnRate`, `explore.moveOnPool` | override if ≠ 0.15 / 300 |
| `dryRun` | `prefs.practice` | copy; never flipped by migration or reset |
| **`pruneWhitelist`** | `protection.accounts` | from **raw** JSON; each → `normalizeHandle`; valid → `{pk:null, username, linkedAt:null, source:'migrated', valid:true}`; all-digit → `{pk:s, username:s}` (matches pk or username as today); invalid → kept with `valid:false`; dedupe case-insensitively; count post-condition |
| **`pruneBioFilterWords`** | `protection.words` | raw; trimmed; non-blank; deduped by fold; count post-condition; notice "Your bio keywords (3) now protect everyone, not only people who follow you back." |
| `pruneDailyLimit` | `unfollow.cleanupPerDay` | override if ≠ 50, clamped (notice on clamp) |
| `pruneScheduleDays` | `intent.cleanup` + `unfollow.censusEveryDays` | `> 0` → `cleanup = pattern.cleanup ∈ {steady, deep} ? 'steady' : 'trickle'` (an install whose woven cleanup was off and that pruned once a week maps to the gentlest level, `trickle`, never to `steady`) [arch r2] + override if ≠ 7; `0` → `cleanup:'off'`; notices ("Scheduled cleanup now happens gradually inside sessions" / "Cleaning up people you followed yourself is now its own setting, and it's off") |
| `pruneLastRunAt` | dropped (bulk schedule retired) | — |
| `pruneScanMinSeconds`, `pruneScanMaxSeconds` | `tempo.walk.page` override **only when slower** than 1/3 s | factor = mean/2 s, clamped to [1, 3]; a faster v1 value is dropped with a notice (it would otherwise speed up acquisition, census and head walks, which all read `walk.page`) |
| `dailyVolumeVariancePct`, `restDayChancePct`, `sessionsPerDayMin/Max`, `hourlyVelocityCap`, `weaveEnabled`, `maxUnfollowFractionPerSession` | from intent | † (`weaveEnabled` is implied by `cleanup`) |
| `gapMedianSeconds`, `gapFloorSeconds` | `sessions.gapTypical` / `sessions.gapMinimum` (effective scale) | †; a non-derived v1 value maps to an override of the recommended effective value × (v1 / V1_DERIVED), **only when that ratio > 1**; a faster value is dropped with a notice |
| `persona` | — | dropped (a named persona already wrote its ordinals into `pattern`) |
| `pattern.{activityLevel, consistency, rhythm, dayShape, weeklyShape, caution, patience}` | `intent.*` | identity (`activityLevel` → `activity`); `pattern.cleanup` feeds the `pruneScheduleDays` row (`deep` → `steady`) |
| `tourCompletedAt` | `app.tourCompletedAt` | copy; never reset |
| (new) | `intent.mutuals` `'rotate'`; `intent.daysOff` `[]`; `protection.keepVerified` `true` (notice); `prefs.boost` `{hours: 12, acceptRequests: true}`; `app.tourVersionSeen` `null` | — |

**Migration laws:** protection is monotone (`protectedV1(s) ⇒ protectedV2(s)` for every subject, using the one shared
`normalizeHandle`/`foldText` from `src/shared/unfollow-protection.ts`); no list shrinks; behaviour preserved on retained
keys; idempotent; a default v1 file and a default file of every persona (including cautious) yield zero overrides; a
refusal never discards v1 state.

**Rollout compatibility.** Until the Settings UI stream lands, a transitional adapter keeps today's renderer working:
`getSettings` returns `toV1Settings(view)` (typed as the frozen v1 `Settings`; fields the engine no longer has are
filled from the frozen v1 defaults for display, and writes of them are dropped with a log); `updateSettings(partial)`
becomes `opsFromV1Partial` (keyed list ops: the lost-update race on lists ends at once); on `not-saved`/`refused` the
adapter's handler throws and its fallback **rethrows** (the one transitional exception to typed fallbacks), so the old
renderer shows "Not saved" honestly (`useSettingsDraft.ts:137-145`). The adapter and its three channels are deleted in
the Settings UI stream's last commit. `checkSeed` keeps its old result shape on the wire until that same commit (the
handler runs on a `SeedCheckResult` core and maps it down); the commit re-types the channel to `SeedCheckResult`.

---

## 7. Protection on every unfollow path (item 6)

Source: T2 FINAL §8 (predicate, two layers, `kept`, fail-closed), merged with T5's verify-at-act and parks (§9.7–9.9).
ADR 0214. **This reverses the 2026-08-31 mutuals-only decision [owner]**; the owner session must update memory
`unified-transport-and-bio-keep-list`. The lists stop being "prune" settings.

### 7.1 Semantics [owner + lead]

- A protected account is **never unfollowed automatically**, whether or not it follows back, on every path:

  | Path | What it is |
  |---|---|
  | P1 | churn no-follow-back reclaim (`advanceTimers` loop 1) |
  | P2 | hold-expired rotation (loop 2) |
  | P3 | churn execution (`executeUnfollow`) |
  | P4 | recovery-healer requeue (covered through P3 + loop 3) |
  | P5 / P6 | cleanup bulk run (manual "Run now"; the scheduled run is retired) |
  | P7 | the woven cleanup feed |
  | P9 | manual `unfollowOne` (no UI today): typed refusal `protected`; an override needs an explicit confirm naming the rule (owner Q33) |
  | P10 | the prune-run mode rule (`rules-prune.ts:39-44`): `decidePruneCandidate` receives the protection verdict from `PruneFacts.protection` (replacing `PruneFacts.whitelist`, `facts.ts:151-157`), so the declared prune-run mode can never re-introduce whitelist-only semantics |

- **Fail safe** [lead]: if bio keywords are configured and this observation carries no bio (or `keepVerified` is on and
  no verified flag), the unfollow does not happen. The record must **not** block the queue: it moves to a non-blocking
  `kept` state and is re-evaluated on a plan-derived schedule (§7.4).
- Sources and the starting account stay protected (today's click check `mutation-policy.ts:89` and census exclusion
  `prune-engine.ts:997-1010`), now as a **consuming** verdict (reason `source`), not a looping deferral.

### 7.2 Rules

| Rule | Data | Matched from | Default |
|---|---|---|---|
| People | `ProtectedAccount { pk, username, linkedAt, formerUsernames, addedAt, source, valid }` | linked (pk and username confirmed together): **pk only**; unlinked: pk if set, else lowercase username | empty |
| Bio keywords | `KeepWord { text, addedAt }` + `wordMatch: 'anywhere' \| 'whole-word'` | `foldText(bio)` = NFKD → strip combining marks → lowercase (only ever *adds* matches over today's lowercase substring) | empty, `anywhere` |
| Verified accounts | `keepVerified: boolean` | `isVerified` (list rows and profiles) | **on** (Epo's scorer never follows verified accounts, `scorer.ts:142`, so a verified account in the following list was followed by the user) |

"Keep people who follow you back" is the lifecycle choice `mutuals: 'keep'` (§6.4), which turns P2 off entirely; it is
not a predicate rule. Rejected rules: own-follows (redundant with cleanup off), large accounts (needs a visit per
candidate), recently interacted (no data), former usernames (protects a stranger who takes an old handle).

### 7.3 The predicate (`src/shared/unfollow-protection.ts`, pure)

Replaces `shared/prune-whitelist.ts`, `engine/prune-whitelist.ts`, `engine/prune-bio-filter.ts`, the bio branch at
`mutation-policy.ts:92` and the whitelist branch of `decidePruneCandidate`. **It lands in Phase F** (F2b: types, the
predicate, `compileProtection`, `foldText`, `normalizeHandle`, the truth-table and L-PROT tests) [arch r2], because the
settings migration (its list normalization and the monotone-protection law), the settings service (`protection()`
compiles the index from the v2 document) and the click verdicts all need it before the unfollow-decisions stream
wires it; one implementation of `normalizeHandle`/`foldText` is what makes the migration law meaningful. The old
semantics are **not** preserved behind the new interface: from the settings-core merge on, `protection()` serves the
new predicate (bio words protect everyone, not only follow-backs, `mutation-policy.ts:89-92`), and paths that still
consult the old helpers keep their old behaviour until the unfollow-decisions stream rewires them.

```ts
export interface ProtectionIndex { readonly rev: number; readonly state: 'ready' | 'needs-review' | 'unavailable';
  readonly pks: ReadonlySet<string>; readonly usernames: ReadonlySet<string> /* unlinked only */;
  readonly words: readonly string[] /* folded, non-blank, deduped */; readonly wordMatch: 'anywhere' | 'whole-word'; readonly keepVerified: boolean }
export interface ProtectionSubject { readonly pk: string; readonly username: string | null;
  readonly bio: string | undefined /* '' = observed empty; undefined = absent in THIS evidence */;
  readonly isVerified: boolean | undefined }
export type ProtectedBy = 'account' | 'verified' | 'bio-word' | 'source';
export type ProtectionVerdict =
  | { kind: 'clear' } | { kind: 'protected'; by: ProtectedBy; match: string }
  | { kind: 'unknown'; missing: 'bio' | 'verified' } | { kind: 'paused'; state: 'needs-review' | 'unavailable' };
/** Precedence: paused → protected (account, verified, bio-word) → unknown → clear. 'unknown' only when a CONFIGURED rule
 *  lacks its fact. Never reads follow-back state. Monotone: adding an entry/word/rule never turns protected/unknown into clear. */
export function protectionVerdict(s: ProtectionSubject, idx: ProtectionIndex): ProtectionVerdict;
export function compileProtection(p: ProtectionSettings, state: ProtectionState, rev: number): ProtectionIndex;
export function foldText(s: string): string;            // s.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase()
export function normalizeHandle(raw: string): { handle: string; valid: boolean };   // trim, strip '@', lowercase; /^[a-z0-9._]{1,30}$/
```

`whole-word` uses `(?<![\p{L}\p{N}])…(?![\p{L}\p{N}])` with the `u` flag. Blank words never protect. A bio arriving as
`null` is treated as **absent** (fail safe). The scrubbed 2026-11-02 corpus contained no empty/null biography
example. A canonical body captured on 2026-11-04 supplies the observed `biography: ''` case in the new dated corpus,
so `EMPTY_BIO` records that form (ADR 0806). This establishes the empty-string case only; null and omitted biographies
remain unread. The run stopped because its target was private, so this field evidence does not qualify L1.
`biography` and `is_verified` join `EXPECTED_KEYS['profile-graphql']` (§10.3), so if Instagram omits either
the profiles area shows `paused` with a reason in the compatibility panel and the sidebar, instead of every unfollow
silently becoming `kept('unreadable-*')`.

### 7.4 Two layers on every path

The **selection** layer works from stored facts and makes no visits (a stored bio that matches protects; that is fail
safe even if stale). The **click** layer is authoritative and judges the **fresh observation's own fields**
(`seen.obs.fields.bio`, `seen.obs.fields.isVerified`), never the folded store row: the fold keeps a previous bio when a
body lacks `biography` (`store/folds/account.ts:93-95`), which would hide exactly the drift the rule exists to catch.

| Path | Selection time (`storedSubject(store, pk)`) | Click time (`freshSubject(seen.obs)`, inside click review §9.7) |
|---|---|---|
| P1 / P2 | checked before any evidence logic: `protected` → `kept(by)`; `paused` → skip, no queue; `unknown`/`clear` → normal timers. With `mutuals:'keep'`, loop 2 does not run | — |
| P3 + P4 | loop 3 over `unfollow_queued` moves any protected record (healer requeues included) to `kept`; `nextDue` only *filters* (paused → no unfollow); `executeUnfollow` re-checks | `protected` / `unknown` / `paused` → `ActionReviewedError` with a protection verdict (§9.7 order step 5) — evaluated before the target check and before `followsUs` |
| P5 / P6 cleanup run | `decidePruneCandidate` receives `protection: ProtectionVerdict`: `protected` → skip `'protected'` (consumed, no actionable slot spent); `paused` → the run stops with `protection-paused` | `protected` / `unknown` → skip + mark visited; the index advances; **never** the `PRUNE_PARK` retry (post-visit verdicts only; a pre-visit deferral never consumes, §9.7) |
| P7 woven feed | protected rows consumed like whitelisted rows today; `paused` → `null` | same as P5 |
| P9 manual | typed refusal `protected` | same |
| P10 prune-run mode rule | `PruneFacts.protection` (a verdict over stored facts), never the raw whitelist | same as P5 |

A protection verdict **consumes** the work (it is not an `ActionDeferredError`, which retries the same work). Passive
follow-back detection still stamps `followedBackAt` on kept records, so stats stay true.

### 7.5 The `kept` state

- `FollowState` gains `'kept'` (non-terminal); `FOLLOW_STATES` appends it, so zero-filled funnels, `queue:list` guards
  and analytics pick it up (`store/types.ts:51-66`, `repos/analytics.ts:107`). The census keeps excluding it (still an
  Epo-followed active record, `follow-records.ts:15`).
- Columns (migration 14, §16): `kept_reason` (`'account'|'verified'|'bio-word'|'source'|'unreadable-bio'|
  'unreadable-verified'`), `kept_match`, `kept_at`, and the shared `recheck_at` and `check_failures` (one column, one
  meaning: "earliest next Instagram read" / "consecutive unreadable or unreachable observations"; T2's `#n` suffix is
  dropped in favour of `check_failures` [arch]).
- **Entry** from `pending_followback | followed_back | unfollow_queued` on a selection-time `protected` or a click-time
  `protected`/`unknown`.
- `ProtectionReconciler.reapply(reason)` (one store transaction, no Instagram traffic) runs on every settings change
  touching protection (`'rules'`), once per plan-day (`'day-roll'`, from `PlanDayClock.onRoll`; local midnight until
  the plan-backed clock is swapped in, then the plan-day edge — no stream-local daily job), and once at graph open
  (catches a day that rolled while closed, PRINCIPLES §3).
  - **Exit 1** (rule change or a stored fact changed): newly clear records return to `followed_back` (if a follow-back
    was observed) or `pending_followback`; `reconciledAt` is cleared (harmless under verify-at-act).
  - **Exit 2** (unreadable re-check): at the first pass at or after `recheck_at`, the record returns to
    `unfollow_queued`; the next click re-reads the profile (§9.7: the click *is* the read). Interval
    `recheckDelay(n) = planDay × 2^min(n−1, KEEP_RECHECK_DOUBLINGS (3))` → 1/2/4/8 plan-days; at most one visit per
    unreadable record per window. Epo never unfollows while a configured fact is unknown [owner Q17 default].
  - Advanced offers "Re-check unreadable profiles" (sets `recheck_at = now` for all; still plan-paced).
- Projections: the People "In progress" lanes gain **Kept**; graph nodes in `kept` render in the followed family with
  a shield glyph; `settingsFacts.protection.kept = {total, unreadable}`; a sustained rise in `unreadable` surfaces in
  the sidebar as attention ("N unfollows paused: Epo couldn't read their profiles to check your protection") and is a
  drift signal for §10.
- Epo still **follows** protected accounts normally (owner Q18 default); copy makes the consequence visible ("Accounts
  Epo follows that match your keywords are kept too, even if they don't follow back. Kept so far: 12").

### 7.6 Fail closed

| `protectionState` | Set when | Effect |
|---|---|---|
| `ready` | normal | — |
| `needs-review` | restored from `.bak`; re-migrated from v1 after v2 failed; files missing while a DB exists; migration dropped a non-string list item; migration refused | **No automatic unfollow on any path** (verdict `paused`); follows continue. Banner "Check your protection list before Epo unfollows anyone." [Review protection] → [My protection list is right] (op `acknowledge-protection`) |
| `unavailable` | nothing readable at all | same pause; banner "Epo couldn't read your settings and found no saved copy, so it won't unfollow anyone until you check Protection." |

`EpoStatus.unfollowsPaused: 'protection-needs-review' | 'protection-unavailable' | null` drives a sidebar attention
line. While paused, the plan mix treats unfollow work as unavailable (§5.7), so nothing spins.

### 7.7 Linking pks and tracking renames (zero Instagram traffic)

At add: `normalizeHandle` then `store.pkByUsername`; a known pk is stored **linked**. `ProtectionLinker` (main module on
the throttled `store.onMutation`) links unlinked entries the store now maps, and for linked entries follows renames
(`username ← new`, old appended to `formerUsernames`), persisting through `SettingsService.apply(ops, 'system')` only
on change. At click time an unlinked username match confirms pk and username together and links it. Migrated
all-digit entries match pk *or* username exactly as today (monotone law).

### 7.8 Protection UI (one section, identical in Easy and Advanced apart from extras)

> **Protection** — Epo never unfollows anyone protected here — not in its daily cycle, not when pruning, not
> during Boost — whether or not they follow you back.

- **People**: "Add @username" with typeahead over accounts you follow (store-only `suggestAccounts`); [Paste a list];
  rows with monogram, current @username, badges ("You follow · Follows you", "Renamed from @old", "Not seen yet —
  check the spelling", "Not among accounts you follow" only after a verified-complete census, "Not a valid username");
  remove → toast with **Undo**; **no "remove all"**.
- **Bio keywords**: chips "**{word}** · {n} people" (live counts over stored bios of accounts you follow); hint
  "Matches anywhere in the bio, ignoring capitals, accents and fancy fonts. Epo re-reads the bio right before every
  unfollow. If it can't read a bio, it keeps the account and checks again later."
- **Verified accounts** toggle (on). **Also always kept:** "Your starting account and the accounts Epo explores
  through."
- **Summary** (live facts): "Protecting **214** of the **1,830** accounts Epo has seen you follow · Kept so far:
  **12** · Bios not read yet: **96** (checked before any unfollow)." Unknown values show "—" with a reason, never 0.
- **Advanced extras**: keyword matching anywhere / whole words; a paged **Currently kept** table (`keptList`); [Re-check
  unreadable profiles]; the protection state with the review action.
- **Prune page** (the `prune` stage, T2 §8.9): the whitelist card becomes a read-only tile with a deep link to
  Settings → Protection; the schedule card, daily-limit stepper and scan-pacing steppers are removed ("Today's cleanup
  allowance: **N**" read-only, from the plan); candidates come annotated from main (`protectedBy`, `bioUnread`) with
  "Show protected (N)"; actions "Unfollow these gradually" (opens the cleanup confirm) and "Run now"; an account too
  large to check in full shows why (§5.8.3) instead of a partial list. "Whitelist" and "prune" leave all user-facing
  wording.

---

## 8. Explore Boost (item 7)

Source: T1 §3.7 (plan modifier), T2 §9 (preferences, contract), T3 §4.3.7 (control), T5 §3.14 (light sweeps), U09 §6.
ADR 0904.

### 8.1 What Boost is [owner + lead]

For the next N hours (default 12, chips 2/4/8/12/24 in Settings, bounds 1–24 h, `SETTINGS_POLICY.BOOST`), Epo spends
the day's remaining actions on finding and following new people. Unfollows (lifecycle, woven, cleanup), census and
non-essential relationship checks wait. **Boost never raises a ceiling** [lead]: it reallocates the kept remainder `R`
(§5.7: Σ budgets of the kept sessions not yet ended, minus their usage — prorated and skipped volume never comes back)
and **may lift the plan-day's automatic volume up to `automaticDayMax(P0)` — today's largest automatic day, never
above it** (owner Q5, answered with the bounded alternative, §18.3). Every lifted action is a follow placed in a session
inside the window; `M`, `H`, the gap floor, the tempo and the D6 totals never move. It can be ended any time (no
confirm; ending is the safe direction).

**What Boost really changes** [arch r2, honest by construction; Q5 answer]: (1) **now** — if Epo is meant to be running
and no session is open, a session starts immediately instead of at the next planned start; (2) **the mix** — the
unfollow share still left today (`U_remaining`) moves to follows; (3) **the lift** — the window's sessions may add
`lift = max(0, automaticDayMax(P0)·prorate − V)` follows, so the plan-day's automatic total reaches at most today's
maximum automatic day (≈ +5–10 follows on a typical Balanced day; prorated on transition days; `follows ≤ P0` at plan
and run time); (4) **reads** — exploration gets the larger budget, the followers-head walk waits. A drawn light or rest
day is lifted too (an explicit Boost overrides the drawn rest); the user's own days off and quiet hours are not (Boost
waits). Over a week Boost adds at most the lifts it granted; the deferred unfollows are paid back by the backlog yield
(laws L13b, L14b).

**Never deferred** [lead]: the safety prefix; journal settlement of in-flight mutations; click-time verification and
`MutationWatch`; the recovery ladder; velocity and hard ceilings; `advanceTimers` (store-only; records still become
"up for review" and wait); the own-profile header read at each session start (it feeds the outside-action charge
against `M`, so a 12 h Boost never hides phone actions from the ceiling).

### 8.2 State, writer, clock rules [arch: one home]

- `plan_state.boost: BoostWindow { v:1, startedAt, endsAt, durationMs, endedAt|null, endReason }` in the per-account
  store meta; the single writer is `PlanService`; the window write and the re-plan happen in one `setPlanState`.
  Rejected homes: Settings (global, reset wipes it), Chronos (no production consumer), a separate meta key (two writers
  of one decision).
- **Wall time**: closed, offline and holding time all count ("for the next 12 hours"). Rules in `ensure`:
  `now < startedAt − CLOCK_TOLERANCE_MS` ⇒ end with reason `clock`; `endsAt > startedAt + durationMs` ⇒ clamp;
  `now ≥ endsAt` ⇒ end `expired`. A launch after expiry re-plans first. A timezone change does not affect epoch ms.
- **Account switch**: the window lives in that account's DB; switching accounts neither ends nor transfers it. Clear
  data wipes it.
- **Boost and run intent** [arch r2]. Stopping Epo does not end Boost; ending Boost does not stop Epo. Session
  insertion keys on **run intent** (`desired = running`), never on the engine's momentary state. Pressing Boost while
  stopped offers **"Start Epo and Boost"** (`alsoStart`), defined as one ordered command: (1) advance run intent through
  `RuntimeCoordinator` (ADR 0210 epochs); (2) write the window and re-plan in one `setPlanState` — the insertion rule now
  sees `desired = running` and inserts the act-now session; (3) start the engine, queued behind the startup lease like
  any Start [owner Q4 default]. Natural implementations that write the window first and start later would insert
  nothing and silently wait for the next planned session; the order is a tested contract.
- **A quit stops work, not the clock.** A deliberate quit sets run intent to `stopped` (`foundation-wiring.ts:1080-1084`;
  the owner's "always start idle"), so after a reopen an active Boost keeps burning wall time while Epo is stopped.
  `BoostView.state = 'paused'` makes that visible ("Boost is on until 9:40 PM, but Epo is stopped — press Start to use
  it"); pressing Start resumes the Boost mix at once. Whether an active Boost should instead resume work on reopen (a
  scoped exception to "always start idle") or freeze its clock while stopped is owner Q37 (default: keep the wall
  clock, start idle, show `paused`).

### 8.3 Reallocation at `boost-start` (window `[t0, t1)`, `t0 ∈ [S, E)`)

```
R = Σ over kept sessions not yet ended (b'_s − used_s)     prorated/skipped excluded; NEVER V − used (unchanged by Boost)
if intent.desired = running ∧ no session open ∧ t0 inside the day's central λ_eff mass (2.5 %–97.5 % quantiles)
   ∧ not quiet hours ∧ not a day off:
    insert a session at t0; re-lay future sessions over [t0, E) by λ_eff strata; budgets re-apportioned to Σ = R
lift = max(0, ⌊automaticDayMax(P0)·prorate⌋ − V)     Q5 answer; per plan-day the window overlaps; prorate as §4.4
    the lift is apportioned only to sessions with startAt ∈ [t0, t1) (and the open one), capped per session by what
    H and the gap floor let that session place; unplaceable lift is dropped, never carried to another day
sessions with startAt ∈ [t0, t1) (and the open one): mix 'boost'; U_s = 0; F_s = b_s − A_s bounded by P0 − follows done/planned
    reads: explore_s grows within the non-verify room; reconcile_s = journal reserve only; checks_s = one LIGHT check at
    session start (own header + drawer, accepts if prefs.boost.acceptRequests); census never hosted; head walk deferred
sessions after t1: normal mix; demand carries the deferred unfollows; u_max and the backlog yield apply (§5.7)
invariants (laws L13, L13b): Σ b_s(remainder) = R + lift exactly (lift only inside the window); the plan-day's
    automatic total ≤ automaticDayMax(P0)·prorate; M, H, gap floor, D6 totals and tempo unchanged; follows ≤ P0;
    the same overlay after every ReplanCause (§5.6)
```

- **Waiting state**: if `t0` falls in quiet hours or on a day off, or today's volume is used up, Boost is `waiting`
  with `effectiveFrom` = the next eligible session; on a light or used-up day it shapes tomorrow's sessions until `t1`.
- **Backlog guard** (SC fix, r2): Boost is refused with `backlog` while the lifecycle backlog exceeds
  `SETTINGS_POLICY.BOOST.MAX_BACKLOG_DAYS (3) × room` — i.e. while the unfollows deferred by earlier Boosts would not
  clear within three non-Boost plan-days at `u_max` ("Too many unfollows are still waiting from earlier Boosts. Boost
  is available again in about 2 days."). Back-to-back Boosts therefore cannot grow the following count without bound.
- **`boost-end`** (expiry or user): re-plan the remainder with normal mixes; session times kept. The first post-Boost
  sweep reads exactly the accumulated delta (frontiers, §9). Toast "Boost ended. Unfollows that waited will be spread
  over the next sessions."

Replay uses already-planned volume when computing lift; a skipped or ended session is never extended by the
overlay. Lowering a target may trim unspent allocations, recorded in optional persisted `volume.forfeited`
(older plans: zero), and later replans cannot refund them. Actual ledger usage is preserved even if a newly
lowered target is below it; in that case no additional automatic work is admitted. `volume.planned` is the sum
of session budgets, with actual already-used volume the only possible exception to a newly lowered ceiling.

### 8.4 Behaviour per rule and source

| Rule / source | Under Boost |
|---|---|
| safety prefix, journal, click verification, `MutationWatch`, recovery ladder, ceilings | never deferred |
| `pacing` (`PlanFacts`) | `mix: 'boost'`, `admits.unfollow = false` |
| `action` source (`plan-mix`) | follows only; `selectPruneCandidate` not called (no skip-row consumption) |
| `followback` (`FrontierSweep`) | light: the own header (H) at session start (kept: it feeds the ceiling) + notifications + accepts (when the pref is on); the followers head (L) and the following check (G) deferred; frontiers keep |
| launch catch-up during Boost | H and N run (header is free; follow-backs and accepts are growth); L deferred |
| census slot | never placed in Boost sessions |
| manual cleanup "Run now" / scan | refused with `'boost-active'`; the UI offers "End Boost to run cleanup?" |
| `refill` / queue | the larger explore budget |

### 8.5 Commands, view, preview

```ts
// src/shared/boost.ts
export interface BoostView {
  readonly state: 'off' | 'on' | 'waiting' | 'paused';      // paused: the window is open but run intent is stopped
  readonly startedAt: number | null; readonly endsAt: number | null; readonly effectiveFrom: number | null;
  readonly followsDuring: number | null;
  readonly lastEnded: { readonly at: number; readonly reason: 'user' | 'expired' | 'clock' } | null;
}
export interface BoostPreview { readonly hours: number; readonly endsAt: number; readonly effectiveFrom: number;
  readonly startsSessionNow: boolean;                        // the act-now effect
  readonly extraFollowsToday: number /* ≥ 0 = U_remaining moved + lift placed (Q5), inside effective ceilings */;
  readonly unfollowsWaiting: number;
  readonly why: 'ready' | 'nothing-to-shift' | 'light-day' | 'quiet-hours' | 'day-off' | 'limit-reached-today'
    | 'backlog' | 'engine-stopped' }
export type BoostCommandResult =
  | { readonly kind: 'started' | 'ended'; readonly boost: BoostView }
  | { readonly kind: 'refused'; readonly boost: BoostView;
      readonly reason: 'signed-out' | 'runtime-blocked' | 'no-seed' | 'already-on' | 'not-on' | 'bad-duration'
        | 'nothing-to-shift' | 'backlog' | 'internal' };
// invokes: startBoost(hours: number, opts: { alsoStart: boolean }) · endBoost() · previewBoost(hours: number)
// state:   EpoStatus.boost?: BoostView | null (rides the status push; the plan strip reads it for its band)
```

`why: 'nothing-to-shift'` ⇔ `U_remaining = 0` **and** `lift = 0` (the plan-day already sits at `automaticDayMax`)
**and** no session would be inserted (one is already open): Boost would change nothing, so **Start Boost is disabled**
with "Today is already at Epo's fullest day, and Epo is already working." When only the act-now effect remains, `why`
stays `ready` and the preview says exactly that: "Boost starts working now instead of at 6:05 PM. Today is already at
Epo's fullest day, so follows stay about 23." The normal preview reads "Until 9:40 PM · about +9 follows today, within
your usual limits · 6 unfollows will wait". `light-day` (Q5 answer) no longer defers: a drawn light day is lifted like
any other day, and the preview shows its numbers. Hours are clamped to
`SETTINGS_POLICY.BOOST` [1, 24]; the sidebar always sends `prefs.boost.hours` (the length is chosen only in Settings →
Boost). `previewBoost` runs `PlanService.previewBoost(hours)` (pure: `applyBoost` on a copy). Refusals are typed and
shown in plain words in the Now zone's reason line, never as a silent no-op.

### 8.6 UI

Settings → Boost holds the preferences, including the only length picker (§6.4). The **one Boost control lives in the
sidebar's Today zone** (§12.2) and starts in one tap: Unavailable (disabled, with the reason: "Sign in to use Boost" ·
"Choose a starting account first" · "Epo needs your attention first" · the `nothing-to-shift` and `backlog` lines) →
Ready (a `⚡ Boost for 12 h` button; under it the preview line "Until **9:40 PM** · about **+18 follows** today, within
your usual limits · **6** unfollows will wait" and a small "Change length in Settings" link; while stopped the button
reads **Start Epo and Boost**) → On (a band "⚡ Boost on · ends 9:40 PM · 7 h 12 m left [End Boost]", one tap to end,
a deadline animation over `endsAt`, no 1 Hz re-render) → Waiting ("⚡ Boost starts at 6:00 AM (quiet hours)" + End
Boost) → Paused ("⚡ Boost on until 9:40 PM — Epo is stopped. Press Start to use it." + End Boost). The Now zone's
`⚡ Boost` pill is an **indicator only** (no click target), so there is exactly one place to press. The plan strip
shows a `--live` band from `startedAt` to `endsAt`; the feed records `boost` started/ended rows from the window's real
times.

---

## 9. Reopen reconciliation: read only what changed, decide at the act (item 8)

Source: T5 FINAL (spine L1 frontiers; grafts from L2), adopted by §14 C9 over T1's freshness pre-reads. ADR 0213
(engine) and ADR 0704 (store).

### 9.1 The model

| Question | Cheapest sufficient source | Cost | Authority |
|---|---|---|---|
| How many followers / following now? | the own profile header (free with the launch landing; else one own-profile visit at a session's first check) | 0 at launch; ≤ 1 visit per session | exact magnitude (Instagram's count, ghosts included) |
| Who followed since *t*, and when? | the notifications drawer since a server-time watermark (dated); the followers head down to the frontier (interval-dated) | 1 drawer pass; 0–2 composed pages typically | positive identity |
| Who left? | a complete census (0.98 header coverage) or the click-time visit for one managed record | census only (the plan's slot); 1 visit at the decision | **absence verdicts wait for the census**; meanwhile a signed, honest count |
| What did Epo do? | the journal (`effect_intents`) and ledgers | 0 | exact; an uncertain intent is settled by one visit after Start |
| What did the owner do outside Epo? | first the following-header residual (increases only, §9.10); when it is non-zero, the **following check** (step G): the ordered following list answers the whole list in one response plus the plain end probe (`versions/2026-08-12.ts:424-437`, `literals.ts:54-56`) | 0 until a residual appears; then 2 composed requests in a session (never at launch, owner Q38) | exact per account once G ran: managed records the owner unfollowed become `external`, accounts the owner followed are recorded as outside follows; until then the People lanes mark outside changes "not yet verified" |

### 9.2 Frontiers (persisted in `meta.reopen_state`; one writer: `FrontierSweep`)

`stale(t)` ⇔ `t` is null, later than `now + CLOCK_TOLERANCE_MS`, or older than `check.spacing` at the tempo in force.
There is no other threshold.

| Id | Source | Frontier | Read | Stop rule | Runs when | Verdict power |
|---|---|---|---|---|---|---|
| H | own header | `own_counts` rows | the landing at launch (free); else one own-profile visit | one body | launch: no header since `launchAt`; session: `stale(lastHeader.at)`; never mid-session checks | magnitude |
| N | notifications drawer | `feed = {atMs, keysAtMs, readAt, filteredAt, gap}` (atMs = server time) | bell → first body → Follows chip when ready → post-chip body → scroll only if not reached | merged bodies reach `atMs` | `stale(feed.readAt)` | dated gains, follow-backs, accept-intent settlement |
| R | incoming requests | `requests` edges + `requests = {observedAt, count, complete, verifiedDayKey}` | the drawer body's sibling root (presence); the requests panel only to accept, or once per plan-day to verify when auto-accept is off | — | with N | presence from the sibling; absence only from a complete panel |
| L | own followers head | `head = {walkedAt, rowsPerPage, order, contiguous}` | composed list pages from the head (ADR 0307 Decision 2's sanctioned read) | the first run of `frontierRun()` (= 2) pre-frontier rows, at most `FRONTIER_PAGES_MAX` pages | unexplained gains `R⁺ > 0`, a feed gap, or no frontier | gains above the frontier, interval-dated; **never** an absence |
| G | own following list (r2) | `following = {checkedAt, count, complete}` | the ordered whole-list response + the plain end probe (`SURFACE.followingWalkPages` = 2 composed requests; the web client's own "date followed" sort) | the walk table's whole-list rule (§10.4) | session mode only, at most once per plan-day, when the following residual since the last check is non-zero and no census read the following list that day | a verified-complete read: removed `own → pk` edges on managed records → `external` (an outside unfollow); new `own → pk` edges → outside follows, excluded from Epo's tallies; the exact count replaces the estimate in the ceiling charge |
| J | journal | `effect_intents.attempts`, `next_attempt_at` | one profile visit per due intent, **after Start** | — | an unsettled, unparked intent | Epo's own write outcome |
| T | managed timers | `follow_records` (+ review columns) | **none**: `advanceTimers` at graph build and every tick | — | always (store-only) | due for review; the click decides |

### 9.3 The sweep: steps and modes

Steps (order is the contract): `profile (H) → notifications (+requests) (N/R) → followers-head (L) → following (G) →
consistency (store-only)`. Modes: **launch** (passive, before Start), **session** (first sweep of an open plan session),
**check** (later checks at `check.spacing`). **Light** = Boost active.

| Step | launch | session | check | light (Boost) |
|---|---|---|---|---|
| H | consume an own-header observation made since `launchAt` (the landing); else land via the injected `land()` port, then at most one own-profile visit (`use: 'catch-up'`) | one own-profile visit iff `stale(lastHeader.at)` (`use: 'check'`) | never | launch: as launch; session: **runs** (feeds the ceiling) |
| N | iff stale; **no accepts, no panel** | iff stale; accepts and panel per §9.4 | iff stale; accepts per §9.4 | runs (accepts only if the pref is on) |
| L | iff (header this sweep ∧ `R⁺ > 0`) ∨ `feed.gap` ∨ no frontier | same | only if this sweep's N recorded a gap | deferred (frontier kept) |
| G | **never** (the lead's launch list; owner Q38) | iff the following residual since `following.checkedAt` is non-zero ∧ no census read the following list this plan-day ∧ the census term's following share is unspent (`use: 'check'`) | never | deferred |
| consistency | always | always | always | always |

`planSweep` is pure and decides one step at a time (L's inputs exist only after H and N wrote their facts). Each step's
frontier is persisted **after** its facts commit, so a crash re-reads at most one step's span. Every write is
idempotent. Stop aborts through the signal; completed steps keep their frontiers. The **consistency** step (also at
graph build) moves a managed `pending_followback` (or a no-follow-back `unfollow_queued` with no follow-back evidence)
whose `pk → own` edge is active with a gain row `hi ≥ followedAt` to `followed_back` with its interval and a hold from
`max(hi, followedAt)`. A `kept` record only gets its follow-back stamped.

### 9.4 The notifications step (watermark algorithm)

1. **Admission**: `readBudget.consume('notification', use)`; a refusal skips N only.
2. **Open**: bell → await the first feed body (bounded by `RIM.NOTIFICATIONS_WAIT_MS`, a D4 deadline).
3. **Follows chip when ready**: after `ui.step-pause`, press `clickNotificationsFollowsFilter()` again until it reports
   pressed, each attempt after one more `ui.step-pause`, within the same D4 deadline (root cause of U11 F3: the chip
   is located once with no wait, `follow-notifications.ts:233`). No `actor.ts` change.
4. **Post-chip body**: any feed body arriving after the press is the filtered body; wait for one (same deadline); if
   none, continue and record `filtered:false` (logged; persistent `false` is a drift signal).
5. **Per body, as it parses (facts stream)**: classify against the watermark; apply every fresh event at once.
   Fresh = `atMs > w.atMs`, or `atMs = w.atMs` with a key not in `keysAtMs`. Events at or below the watermark write
   nothing (ends one `observations` row per event per pass). `atMs > now + CLOCK_TOLERANCE_MS` ⇒ undated. A fresh
   dated event writes `observe(username)` and an exact `[atMs, atMs]` change row, transitions a managed record with the
   exact date, and settles an uncertain `accept-request` intent `external` (zero reads). Sibling requesters (one row at
   a time, via the parse topic's strict sibling reader) write an active `requests` edge.
6. **Scroll only if the watermark was not reached**, at most `RIM.NOTIFICATIONS_SCROLL_ROUNDS` (runaway bound), each
   after `scroll.wait.drawer`; stop the moment it is reached or a round adds nothing; still unreached →
   `gap = {fromAtMs: w.atMs, toAtMs: oldest}`.
7. **Requests panel** (session/check only, **never at launch**): open iff an accept pass is allowed
   (`autoAccept ∧ acceptsAllowed > 0 ∧ (siblingCount > 0 ∨ sibling unavailable)`; several accepts per pass, `gap.accept`
   spacing, one deadline at pass end) or a verification read is due (`¬autoAccept ∧ activeRequestEdges > 0 ∧
   requests.verifiedDayKey ≠ today`, at most once per plan-day). A strictly parsed panel with
   `has_next_page === false` is **complete**: requesters absent from it lose their `requests` edge — the only absence
   verdict on requests.
8. **Close** the drawer (`drawer.close-settle`, then the X at the exposed aim point).
9. **Advance** the watermark only after the events are written. A failure ends **N only**: the watermark is untouched,
   only `readAt` is stamped when the drawer was opened, so a broken drawer is retried at the next planned check — never
   in a loop (fixes the pending-requests drawer loop, U08 F3/F4).

### 9.5 The followers-head step (frontier run, page bound, dating)

- Frontier time `t_f = head.walkedAt ?? lastCompleteFollowerCensusAt ?? null` when `reopen_state` exists. **On the
  upgrade launch** (no `reopen_state` yet) `t_f = null` → outcome `initialized`: one page establishes the frontier
  [arch r2]. (The census fallback there would count every follower first seen since that census as a gain — the
  backfill dates them `first_seen_at` — and read tens of pages before Start, tripping L4's stop rule.) A row "was a
  follower at `t_f`" iff its `pk → own` edge is active and its latest gain row has `hi ≤ t_f` (or it has no change row
  and `first_seen_at ≤ t_f`). No anchor list is stored; a re-follower at the top never fakes the frontier.
- `G` = active own followers whose latest gain row has `hi > t_f`; `R⁺ = max(0, residual after t_f)` (§9.10);
  `maxPages = min(pagesAvailable, ⌈(G + R⁺)/max(rpp, MIN_ROWS_PER_PAGE)⌉ + 2, BOUNDS_REENTRY.FRONTIER_PAGES_MAX (5))`
  (corrects both proposals, which bounded by unexplained rows alone; past the bound the walk records `gap` and the
  identities wait for the census — magnitudes stay exact through the header).
- The walk uses the existing walker with `isKnown = wasFollowerAt(·, t_f)` (pre-frontier, so a backlog of
  feed-identified rows does not trip the known-density stop), `readUse`, per-row `onObservation`, and `stopAfterPage`
  (stops after the page where the run is found). Unknown rows are written at once with the **conservative** interval
  `[lastCompleteCensus ?? baseline, observedAt]`.
- **Dating waits for the frontier** (PRINCIPLES §1 applied to dating): once found, gain rows above it are narrowed by
  list position between exact-dated neighbours — only if the order self-check (≥ 50 concordant pairs at ≥ 0.98, zero
  extra requests) says newest-first; otherwise no narrowing. Rows below the frontier keep the conservative interval.
  **Head walks never remove an edge.**
- Outcomes: `reached-frontier` (contiguous), `gap` (identities between frontiers wait for a census; magnitudes stay exact
  through the header), `initialized`, or a typed failure with facts kept.

### 9.6 The launch catch-up and the work after Start [lead: passive, bounded, read-only]

**Launch** (startup step 3, right after the reveal; the landing and identity confirmation already ran behind the
splash, §12.8; under the `'startup'` tab lease):
- **Admission** `catchUpAdmission()`: identity confirmed, online, sentinel `ok`, the recovery ladder not holding, and no
  persisted block of kind `identity`, `rate` or `unknown`. An **operational** block (`chain-exhausted`,
  `seed-unresolved`) does not stop it: reads are not account activity in ADR 0210's sense (owner Q19 default; amends
  ADR 0210 for passive reads only).
- **Traffic**: the landing (already part of boot), one drawer pass with no accepts and no panel, 0–`FRONTIER_PAGES_MAX`
  composed followers pages (exactly one on the upgrade launch), at most one own-profile visit if the landing produced no
  header. **No third-party profile visits, no following read** (step G is session-only; owner Q38). Runs during quiet
  hours and on days off too: the user opened the app [arch; copy says so].
- **Budget**: `catchUp = {profiles: 1, notifications: 1, pages: min(FRONTIER_PAGES_MAX, headPageAllowance(…))}` from the
  frontier term; never above D6 or its trailing backstop. Ambient tempo.
- **Output**: `status.catchUp` (per step, pushed on every transition); the `AwaySummary` persisted in
  `reopen_state.lastCatchUp`; a feed `caught-up` row. Typical cost: the landing + 1 drawer pass + 0–2 pages (≈ 20–60 s).

**After Start** — the growth program, with no reconcile phase:
```
safety (aborted, sentinel-auth, recovery-hold, sentinel-blocked) → pacing → journal → target → followback (the sweep)
 → rotate → refill → action → chain → idle
```
- `journal` (was `reconcile`, before `pacing`; now after it, inside sessions only) runs `settle-journal`: one intent per
  step, one visit (`use: 'reconcile'`) at the session's tempo.
- `followback` keeps its id (moves to `lifecycle-rules.ts`); `cadence.sweepDue = plan.checkDue(reopen.lastSweepEndedAt())`
  — anchored on the **sweep's end**, not read debits (a check whose steps were all fresh still counts as done);
  `sweep-followback` runs `FrontierSweep.run('session' | 'check')`, light when `PlanFacts.checkLight`.
- Nothing absence-related ever blocks growth: follows of unrelated candidates proceed while one account's journal entry
  waits.
- **Standalone writes** (manual unfollow, cleanup Run): `prepareMutation()` (its own module,
  `src/main/services/prepare-mutation.ts`, split out of `mutation-policy.ts:126-139` in Phase F) settles due intents
  (usually 0–1) and never runs a follow-back check; a write to an account with an unsettled intent is refused with the
  typed reason `journal`. `reconciliation-incomplete` disappears.

### 9.7 Verify-at-act: every unfollow decision is verified exactly once, at the click [lead decision, refined — arch]

The lead's "heavier per-record verification runs as plan-paced work after Start" holds: it runs after Start,
plan-paced, inside sessions, from the verify reserve — **exactly once per executed decision, at the click**. Evidence:
the click-time visit already arbitrates every reciprocal case (`mutation-policy.ts:67-101`), and the pre-read's only
consumers are the watcher's `needsEvidence` and churn's `fresh()` (`followback-watcher.ts:108-121`,
`churn-scheduler.ts:148-152,164,174-178,218,336`). Effect: one visit per unfollow instead of two; U08 F1, F3, F5, F13
disappear because no batch exists. **Fallback** if this is ever rejected: T1's plan-day freshness (`freshSince(view)`),
everything else unchanged.

**Deleted:** the watcher's evidence demand, cutoffs, cohort reads, census fallback and pending-requests deferral;
`reconcile-followback-cohort.ts`, `rim/managed-relationships.ts`, `reconciliation-runner.ts`; churn's `fresh()` and its
gates; `RELATIONSHIP_FRESH_MS`, `ChurnConfig.relationshipFreshMs`, `FOLLOWBACK_DEFAULTS`, `FollowbackCensus`,
`FollowbackRelationships`.

**`advanceTimers`** (store-only, at graph build and every tick): `pending_followback` past the wait → `unfollow_queued`
(`no-followback`) unless retained, protected (→ `kept`), a requester (§9.9) or an active `pk → own` edge exists (the
consistency step makes it `followed_back`); `followed_back` past `holdUntil` → `unfollow_queued` (`hold-expired`) unless
retained, protected, or `mutuals: 'keep'`.

**The click** (`prepareProfile(username, expectedPk, 'unfollow')`, in `src/main/services/click-review.ts`) — one order
for protection (§7), verify-at-act (T5), the surface gate (§10) and the plan (§5):

| Order | Check | Verdict |
|---|---|---|
| 0a | `MutationCadence.preflight(kind, writer, now, {pk})` — session, kind budget, ceiling, hourly, deadline, **journal for this account** | `deferred(reason, until)` (**no read spent**) |
| 0b | `SurfaceGate.paused('unfollows')` | `deferred('surface-paused', nextSessionAt)` (**no read spent**) |
| 0c | `readBudget.consume('profile', 'verify')` | `deferred('read-budget', resumeAt)` |
| 1 | visit `gone` (evidence-backed absent, §10.5) | `unavailable(absent)` |
| 2 | visit `unanswered` / `tab` | `unavailable(unreadable)` |
| 3 | visit `walled` | the recovery ladder (unchanged) |
| 4 | page pk ≠ expected pk | `unavailable(renamed)` |
| 5 | protection on the **fresh** fields (after the edge write) | `protected(by, match)` / `protection-unknown(missing)` / `protection-paused` |
| 6 | retained source / starting account | `protected('source')` |
| 7 | the **fresh** `viewer.incomingRequest === true` **or** an active `requests` edge `pk → own` (a fresh `true` also writes the `requests` edge) | `request-pending` |
| 8 | `following = false ∧ requested = false` | `already-gone` |
| 9 | `followsUs === null` | `unavailable(unreadable)` |
| 10 | `followsUs = false` | `proceed` (stamp `reconciledAt`) |
| 11 | `followsUs = true` and no follow-back evidence | `reheld` |
| 12 | `followsUs = true` and not due | `not-due` |
| 13 | otherwise | `proceed` |

Then, on `proceed` [arch r2, exact order]: `dwell.before-press` (look-before-act) → **the dispatch closure** (§11 F1:
`MutationCadence.armAtDispatch` re-checks admission, draws and **persists** the next deadline, and the journal marks the
intent `dispatched` — exactly once per action) → the presses (header, then each confirm layer, §11). A refusal at the
dispatch closure produces **zero** presses (test). Verdicts other than `proceed` throw
**`ActionReviewedError(verdict)`** (not an `ActionDeferredError`: a review **consumes** the work);
`rim/churn-actions.ts` maps it to `{status:'reviewed', verdict}` and churn applies `applyClickVerdict`:

| Verdict | Record | Intent |
|---|---|---|
| `proceed` | — (dispatch) | dispatched → settled |
| `reheld` | `followed_back`, `followbackObservedAt = t`, `followbackAfter` = best lower bound, `holdUntil = t + hold` | `cancelled` (never dispatched) |
| `not-due` | back to `followed_back` with its hold | `cancelled` |
| `request-pending` | unchanged (the live predicate keeps it out of selection) | `cancelled` |
| `already-gone` | `external` | `cancelled` |
| `unavailable(e)` | park (§9.9) | `cancelled` |
| `protected` / `protection-unknown` | `kept(by)` / `kept('unreadable-'+missing)` with `recheck_at` | `cancelled` |
| `protection-paused` | untouched (selection blocks re-selection while paused) | `cancelled` |
| `deferred(reason, until)` | untouched | `cancelled`; the plan parks exactly until `until` |

```ts
// src/shared/click-verdict.ts (pure; adapter, rim and engine share it)
export type ClickVerdict =
  | { kind: 'proceed' } | { kind: 'reheld' } | { kind: 'not-due' } | { kind: 'request-pending' } | { kind: 'already-gone' }
  | { kind: 'unavailable'; evidence: 'absent' | 'renamed' | 'unreadable' }
  | { kind: 'protected'; by: ProtectedBy; match: string } | { kind: 'protection-unknown'; missing: 'bio' | 'verified' }
  | { kind: 'protection-paused'; state: 'needs-review' | 'unavailable' }
  | { kind: 'deferred'; reason: string; until: number | null };
// src/adapter/errors.ts: class ActionReviewedError extends Error { constructor(readonly verdict: ClickVerdict) }  — NOT a subclass of ActionDeferredError
```

Cleanup paths (run and woven feed) **consume the candidate only on a post-visit verdict** (steps 1–13): skip, mark
visited, advance; never `PRUNE_PARK` [arch r2]. **Pre-visit deferrals** (steps 0a–0c: `deadline`, `hourly-cap`,
`ceiling`, `day-done`, `read-budget`, `session-closed`, `surface-paused`, `protection-paused`, `journal`) **never mark
a candidate visited**: the run serves `until` for `deadline` and `hourly-cap` (an exact park, then the same candidate),
passes over a `journal`-blocked candidate without marking it (it stays for a later pass), and **ends** with that typed
reason for `day-done`, `ceiling`, `read-budget`, `session-closed`, `surface-paused` and `protection-paused`; the woven
feed simply yields to follows. (Read literally, the previous text
let one hourly-cap refusal sweep the rest of a census as visited without a single visit.) Run test: a deadline and an
hourly-cap refusal mid-run leave every unvisited candidate unvisited. **Reviews that dispatch nothing are bounded per
session**: no unfollow review is offered while `nonDispatchReviewsSince(open.startAt) ≥ open.plannedUnfollows` (derived
from `effect_intents`; no new state); follows continue; visits stay spaced by the activity clock (prevents the 2026-10
"burst of visits" class).

### 9.8 The journal: a per-account gate and a complete settlement table [arch-adopted; amends ADR 0212]

- `journalBlocks(pk)` ⇔ an intent for `pk` is `dispatched` or `uncertain`. Checked at selection (`nextDue` skips such
  records — no head-of-line), at `preflight` with the subject (before the visit), and at dispatch (excluding the
  caller's own intent id). Writes to other accounts proceed (quota is already reserved by unknown intents,
  `effect-intents.ts:97-105`; intents are deduplicated per account/action/channel). The global block
  (`mutation-policy.ts:62`) is deleted.
- **Due**: `state ∈ {dispatched, uncertain} ∧ (next_attempt_at IS NULL ∨ next_attempt_at ≤ now)`. At graph build,
  `prepared` intents created before `launchAt` settle `cancelled` with no read (interrupted before dispatch).
- **Settlement** (one intent per `settle-journal` step; pure `settlementFor(intent, observation)`;
  `src/rim/journal-settlement.ts` replaces `effect-reconciliation.ts`):

| Intent | Observed | Intent result | Record / edges |
|---|---|---|---|
| follow | following or requested | `external` (no ledger credit) | **`pending_followback`, `followedAt = dispatchedAt`** (today it leaks as `external`) |
| follow | neither | `cancelled` | back to `queued` via retry-or-abandon |
| unfollow | following or requested | `cancelled` | **stays `unfollow_queued`**, `reconciledAt = t` (**U06 F6**: today a stranded request becomes terminal `external`) |
| unfollow | neither | `external` | `unfollowed`; `own → pk` removed |
| accept-request | `followsUs` | `external` | `requests` removed, `follows` active, gain row `[dispatchedAt, t]` |
| accept-request | not `followsUs` | `cancelled` | unchanged |
| accept-request | channel evidence, zero reads (fresh follow event / head-walk row after dispatch; or still listed) | `external` / `cancelled` | as above |
| any | visit `gone` / renamed | `attempts + 1`, `next_attempt_at = parkUntil('unreachable', k)`; terminal `expired` at `k ≥ goneConfirmations()` | record park `unreachable` |
| any | `unanswered`, `tab`, flags absent | `attempts + 1`, `parkUntil('unreadable', k)`; terminal `expired` at `k > retryLimit()` | record park `unreadable` |
| any | `walled` | no attempt counted; the recovery ladder | — |
| any | read budget refused | `next_attempt_at = resumeAt`; no attempt counted | — |

`expired` is a new, honest `EffectResult` ("outcome never observed"): ledger `none`, counted by `additionalCountSince`
like `external`/`cancelled` (quota stays reserved for its dispatch day).

### 9.9 Parks, terminals, requesters (no head-of-line, no repeated visits)

`parkUntil(kind, k, slots)` (kernel, `src/kernel/derive-parks.ts`) derives every re-evaluation from the plan:

| Kind | k-th re-evaluation | Terminal |
|---|---|---|
| `unreachable` (absent, renamed) | the start of plan-day `today + k` (always a new plan-day) | `k ≥ goneConfirmations()` (= `driftConfirmThreshold()` = 2): record `external` "no longer available"; never unfollowed, never read again |
| `unreadable` | k = 1: `view.nextSessionAt` (never the same session); k ≥ 2: start of plan-day `today + (k − 1)` | `k > retryLimit()` (3): record `abandoned` (healable); intent `expired` |
| `kept` (protection) | §7.5 `recheckDelay` | §7.5 |

Columns `park_reason`, `check_failures`, `recheck_at` (shared with `kept`). `nextDue`, the cleanup candidate offer and
the plan's `lifecycleDueByDayEnd` exclude records with `recheck_at > now`. A renamed account recovers on its own when
its new username arrives passively.

**Requesters are a live predicate, not a state.** `hasActiveRequest(pk)` ⇔ an active `requests` edge `pk → own`.
`advanceTimers` never queues a requester, `nextDue` never selects one, the click returns `request-pending`; nothing is
written. When the request ends (accepted → follower edge opens and the consistency step records the follow-back;
declined → a complete panel removes the edge) the normal timers resume. Never unfollow someone who has asked to follow
the owner's private account while the request is open (owner Q24 default).

### 9.10 Counts and tallies (exact, dated by event time) [ADR 0704]

- `follower_changes` holds one row per **transition** of an own-follower edge: `+1` (none/removed → active) or `−1`
  (active → removed) with a dating interval `[lo, hi]` (`lo = hi` only when the source carried the time). A
  never-active edge writes nothing (removes today's phantom `+1/−1` pairs). Written in the edge's own transaction.
- `own_counts` holds every own-header observation `(at, followers, following)`; header windows `W_i = (t_{i−1}, t_i]`.
- A **component** is a maximal run of consecutive windows linked by multi-window changes; `residual(C) = (F_end −
  F_start) − Σ d_c` (computed at read time, never stored, so later identification shrinks it automatically).
- **Placed in plan-day `[S, E)`**: every change with `S ≤ lo ∧ hi < E`, plus the residual of every component inside it.
  **Unplaced**: everything else, shown once in "While you were away"; on the calendar chart it arrives on the day
  containing `hi`, annotated. **Law L3 (conservation)**: placed + unplaced = `F_last − F_first`.

| Tally | Rule | Shown |
|---|---|---|
| Followers (headline) | newest `own_counts` row + `seenSince` (changes with `lo ≥ header.at`) | "1,284 followers · checked 9:10 AM · +3 since" |
| Following | newest `own_counts` row, unadjusted | "1,102 following · checked 9:10 AM" |
| Net today | the placed figure for today's plan-day | live; event-dated [owner Q34 default] |
| Unattributed today | residuals placed in today | tooltip "Instagram's count moved by N more than Epo could match to people." |
| While you were away | `AwaySummary` over the sweep window | persisted per sweep |
| Outside following actions | per header window **fully inside the plan-day**: `max(0, ΔG − epoNet − resolvedEpoRequests)` — increases only [arch r2]. Epo's outstanding follow requests (to private accounts) are tracked until they resolve, so a later acceptance is never charged; decreases (an Instagram purge of deactivated accounts, the owner's own unfollows) are never charged; a multi-day header window is unplaced and never charged to today. Once the following check (G) ran, its exact count of outside follows replaces the estimate | counts against the **ceiling** only, never kind budgets; copy says "about" until G ran [owner Q7 default] |
| Conversion (UI and engine) | **one** classifier `followbackOutcome()` (`src/shared/followback-outcome.ts`), folded in TypeScript for both (no SQL twin) | `success/(success + failure)`; undated follow-backs observed before the horizon count as successes (fixes U08 F12) |

### 9.11 Probation and staleness derive from the plan

- `probationOwed(lastMutationAt, sessionStartAt, windowOf)`: a session is a probation session iff
  `sessionStartAt − lastMutationAt ≥ one plan-day length (24 h)` **or** at least one complete plan-day window lies
  strictly between the window of the account's last mutation (any writer) and the session's start — the stricter of the
  two [arch r2]: the window rule alone would give no probation to a 25–45 h absence spanning two adjacent plan-days,
  while today any absence ≥ 24 h owes it (`reentry.ts:6-12,149-151`). Pure, no state, DST-safe. It runs at
  `probationHourlyCap` for its whole length. A served-nothing session leaves the next one in probation too. Plus the
  one-time upgrade probation flag (§5.13; set for any install with a non-empty ledger, regardless of `pacing_state`).
- **Deleted**: `REENTRY_POLICY`, `CENSUS_REASONS`, `requiresCensus`, the `getTimezoneOffset()` comparison (a DST or
  timezone change costs zero reads; law L4), presence holds (`holdUntil`/`endHold`/`noteProgress`/`noteAction`).
  `lifecycle_state` v1 is read **once** at the first build without `reopen_state`
  (`lastSweep.endedAt := max(v1.lastActiveAt, carried sweepLastRunAt)`), then cleared; a corrupt v1 logs an error and
  seeds nothing (a first-run sweep: no fabricated gains).
- Clock jumps: any stored time later than `now + CLOCK_TOLERANCE_MS` reads as stale; a backward jump re-reads at the
  next check and re-plans (`clock` cause); no census, no probation from a clock change.

### 9.12 Failure modes and their root-cause fixes

| Failure today | Fix |
|---|---|
| An unreadable managed record wedges reconciliation; the engine halts after 5 failures | no batches; `unavailable` parks on a plan schedule and ends in `external`/`abandoned`; the halt is deleted (law L5) |
| An uncertain intent on an unreadable account blocks every write | per-account gate; intent parks; terminal `expired` (law L6) |
| DST / timezone change forces a full census and probation | no clock logic; frontiers are server times or list positions (law L4) |
| A drawer failure skips every targeted read and stalls growth | N failures end N only; nothing gates on N |
| The pending-requests loop re-opens the drawer every 15–60 s | requesters are a live predicate; the drawer opens only at planned checks |
| A return spends the whole profile allowance at any hour | no batches; journal and sweeps run inside sessions; launch traffic bounded by `catchUp` |
| Stale counts; net today misdated; a re-follow erases a past loss | header headline; dated append-only change log; placement by interval |
| Requests accepted on the phone found late | they appear at the list head: the residual triggers L, which dates them |
| Conversion undercount; UI and engine disagree | one classifier |
| Protected mutuals re-read daily | no pre-reads at all |
| Standalone writes refused with `reconciliation-incomplete` | journal-only `prepareMutation` |
| One accept per drawer pass | §5.7 `acceptsAllowed`, one deadline per pass |
| A large account can never complete a census (200-page bound at ≈ 20 rows/page) | header-relative census pages (§5.8) [owner Q23 default] |
| Offset cursors shift on a live list during a census | a census is one uninterrupted walk sized to complete; 0.98 coverage still gates absence |
| The landing produced no header (aborted at every launch on 11-02) | the seed-check race is gone (§13); H falls back to one own-profile visit; else "not checked yet" |
| `PRINCIPLES.md:100` says timers catch up at build; they do not (since `9aa9119`) | `advanceTimers` at graph build again; the doc becomes true |

### 9.13 Interfaces (condensed; Appendix E holds the full set)

```ts
// src/kernel/derive-reentry.ts (plain-number inputs)
export declare function headWalkPages(n: { identifiedSinceFrontier: number; unexplainedGains: number; rowsPerPage: number | null; pagesAvailable: number }): number;
export declare function headPageAllowance(d: { gainsHint: number; rowsPerPage: number | null }): number;
export declare function measuredRowsPerPage(walk: { rows: number; fullPages: number }, prior: number | null): number | null;
export declare function frontierRun(): number;            // = driftConfirmThreshold() (2)
export declare function orderVerdict(pairs: number, ordered: number, prior: 'newest-first' | 'unverified'): 'newest-first' | 'unverified';
// src/kernel/derive-parks.ts
export declare function parkUntil(kind: 'unreachable' | 'unreadable', k: number, slots: { nextSessionAt: number | null; planDayStartAfter(k: number): number }): number;
export declare function parkTerminal(kind: 'unreachable' | 'unreadable', k: number): boolean;
export declare function goneConfirmations(): number;      // = driftConfirmThreshold() (2)
// src/kernel/plan/probation.ts
export declare function probationOwed(lastMutationAt: number | null, sessionStartAt: number, windowOf: (t: number) => { startsAt: number; endsAt: number }): boolean;
// src/kernel/reentry-policy.ts — created in Phase F (F2a); guard line per entry
export const BOUNDS_REENTRY = {
  /** A walk averaging fewer rows per page than this is a parse or server fault, never a census to size by. */ MIN_ROWS_PER_PAGE: 10,
  /** About a week of gains at measured page sizes; a longer gap stops with `gap` and waits for the census. */ FRONTIER_PAGES_MAX: 5,
} as const;
// src/kernel/derive-reentry.ts (derived, not a new number)
export declare const WEEKLY_CYCLE: number;   // = HUMAN_CIRCADIAN.dayOfWeek.length (7): revisit and freshness windows in plan-days

// src/engine/frontier-sweep.ts
export type SweepMode = 'launch' | 'session' | 'check';
export type SweepStep = 'profile' | 'notifications' | 'followers-head' | 'following' | 'consistency';
// src/rim/following-check.ts: checkFollowing(d, a): Promise<FollowingCheckResult>   (step G; verified-complete or typed failure)
export declare class FrontierSweep { run(mode: SweepMode, signal: AbortSignal): Promise<SweepResult>; view(): CatchUpView; lastSweepEndedAt(): number | null }
// src/rim/feed-watermark.ts (pure): eventKey, classifyBody, reached, advanceWatermark
// src/rim/followers-head.ts: walkFollowersHead(d, a): Promise<HeadWalkResult>
// src/engine/journal.ts (pure): journalBlocks, journalDue, settlementFor
// src/main/modules/catch-up.ts: blockKind(reason), catchUpAdmission(s), catchUpStep(sweep, admit): StartupStep

// src/shared/reopen-view.ts (renderer-safe)
export interface CatchUpView { state: 'idle' | 'running' | 'done' | 'skipped'; mode: SweepMode | null; skipped: CatchUpSkip | null;
  isReturn: boolean; since: number | null; startedAt: number | null; finishedAt: number | null;
  steps: readonly { id: 'profile' | 'notifications' | 'followers-head'; step: StepState }[]; summary: AwaySummary | null }
export interface AwaySummary { sweepId: number; from: number; to: number; isReturn: boolean;
  followers: { before: number | null; after: number | null }; following: { before: number | null; after: number | null; outsideEpo: number | null };
  newFollowers: number; followBacks: number; lostIdentified: number; unattributed: number;
  requestsWaiting: { count: number; atLeast: boolean } | null; gaps: { feed: boolean; head: boolean }; backfilled: number | null; journalPending: number }
export interface OwnCountsView { followers: { count: number; at: number; seenSince: { gained: number; lost: number } } | null; following: { count: number; at: number } | null }
export interface TodayCounts { startsAt: number; endsAt: number; net: number; gained: number; lost: number; unattributed: number; followBacks: number; outside: number }
export interface JournalView { pending: number; parked: number; nextAttemptAt: number | null }
export interface RequestsView { count: number; complete: boolean; observedAt: number | null }
```

Copy (T3 renders): "Checking what changed since Epo last looked…" · steps "Your profile numbers" · "Notifications since
9:00 PM" · "Newest followers" · "While Epo was closed (5 days): +19 followers · 4 followed you back · 3 follow requests
waiting" · "Up to date since 9:00 PM — nothing new." · "Your following count changed by about +6 outside Epo. It counts
toward today's safety limit." · People lanes until step G runs: "Changed outside Epo · not yet verified" · after G:
"Checked your following list: you followed 4 and unfollowed 2 accounts outside Epo." · "1 action from last time is waiting for confirmation. Epo checks it before touching
that account again." · "Up for review · 31" · "Couldn't open @name's profile — Epo will look again tomorrow." ·
"@name asked to follow you. Epo won't unfollow them while the request is open." · "Updated your follower history with
{n} follows Epo hadn't recorded." (first launch after the update; deterministic backfill keeps charts identical at
migration, law L8).

---

## 10. Parse resilience (item 4)

Source: T4 FINAL (spine L1 structural recovery; grafts from L2). ADR 0806; amendments to 0303, 0307, 0801, 0802, 0803.

### 10.1 The rule

**Recovery may add facts; it never subtracts them.** A destructive claim needs all three: the read is canonical or
normalized (C0/C1); it is not partial; every key the claim depends on is present. Destructive claims: "we do not
follow" / `followsUs:false`; end of list / walk complete; "gone"; pending set complete; own header counts used as
coverage evidence; mutation `ok`. Positive facts may also come from a recovered location (C2).

### 10.2 Tiers and admission

| Tier | Meaning |
|---|---|
| **C0 canonical** | the endpoint definition's first declared container and declared key names |
| **C1 normalized** | a declared non-canonical step fired: alternate container, alias key, retype (count digit-string → number; cursor safe-int → string), framing (guard / NDJSON / multipart), root-field route |
| **C2 recovered** | located by a bounded signature search under invariants and an anchor or arm, or routed by a learned operation name |

```ts
export type SinkClass = 'destructive' | 'guarded' | 'additive';
export function admits(sink: SinkClass, m: { tier: Tier; partial: boolean }): boolean {
  switch (sink) { case 'destructive': return m.tier !== 'recovered' && !m.partial;
                  case 'guarded': return m.tier !== 'recovered'; case 'additive': return true; }
}
```

| Output | Class | Also requires | At C2 / partial |
|---|---|---|---|
| `weFollow:false` | destructive | `following` **and** `outgoing_request` present and `false` | withheld |
| `ProfileSeen.viewer` (`following`, `requested`, `followsUs`, `incomingRequest`) | destructive | each key present and boolean | all `null` |
| `weFollow:true` (can drop a queued candidate) | guarded | key present and `true` | withheld |
| list `end` / walk `complete` | destructive | the walk table (§10.4); `quarantined = 0` for absence verdicts | lists are never recovered |
| `absent` ("gone") | destructive | container present and `null`, no GraphQL errors, `final !== false` | never |
| `pendingComplete` | destructive | continuation `end`, `rowIssues = 0` | `false` |
| own header counts (coverage evidence) | destructive | the pair is valid | dropped |
| other accounts' counts, bio, flags, username | additive | the count-pair rule | kept (anchored) |
| follow events; requester rows; feed pending preview | additive | I7; I8 (marker required at C2) | kept |
| mutation `ok` | destructive | — | candidates may only yield walls |

### 10.3 One parser, flipped per endpoint, with a reverse shadow

- The zod surface document drives every endpoint after this overhaul. Each flip is one commit, in order:
  `profile-graphql` (+ dead `profile-info`), `activity-feed`, `friend-requests`, `show-many` + `friendship-show`,
  `followers-list` + `following-list`. Gates per flip: corpus replay over both corpora (every real body reads
  `canonical` with 0 field issues); the differential test (legacy vs document field by field on every real body;
  intended differences asserted only on synthetic drift bodies); the laws; `npm run check`.
- **Reverse shadow, one release.** The legacy extractors (moved in Phase F to `src/adapter/versions/2026-08-12.extractors.ts`)
  run only as comparators in `src/adapter/reader-shadow.ts`, comparing **every** projected field; a disagreement outside
  the intended-difference list persists a `shadow-disagreed` drift signature.
- **Deletion gate** (T4 S8, a separate commit after live L1 + L4 evidence): delete the extractors, `notifications.ts`,
  the eight `extract*` members, `reader-shadow.ts`, `src/surface/shadow.ts`, `EndpointDef.mode`.
- Root-level `z.union`s are deleted; `normalize()` resolves a definition's container list (canonical first) and
  validates the chosen branch with a non-union envelope so issue paths survive. **A declared alternate is the
  root-cause fix path**: a developer encodes a newly observed wrapper as one line plus an evidence string, and it reads
  at C1.

**The C1 step set (closed; each has a law):** `framing` (`decode(frame(b, f)) ≡ b`); `alternate-container` (projection
equals the canonical one); `alias-key` (used only when the canonical key is absent and every present alias agrees: row
id from `pk_id`/`id`/`strong_id__`; event actor from `inline_follow.user_info.pk` or `users[0].pk`); `retype` (never
across kinds: a boolean is never coerced from a string); `root-field-route` (`x-root-field-name` header; facts identical
to the op-routed read). `null` on an optional field is "absent" and canonical; it is never read as `false`.

**Field readers and invariants** (`src/surface/read/fields.ts`, parameterized by `versions/*`; zod validates structure
only; scalars return `{value} | {absent} | {null} | {issue}`, no `.catch()`):

| # | Invariant | Refuses |
|---|---|---|
| I1 | ids only from allow-listed keys; decimal string `^[1-9]\d{0,19}$` or a positive safe integer; every present allow-listed key agrees; conflict quarantines the row | rounded unsafe numbers; mixed objects |
| I2 | foreign ids (`fbid_v2`, `fbid`, `interop_messaging_user_fbid`) never vote | substituting `fbid_v2` for `pk` |
| I3 | C2 user row = I1 id **and** a valid username | story pks, `data.viewer.user`, `supervision_info.id` |
| I4 | anchored profile (C2): I3 + the anchor username (+ pk when known) + both count keys valid; no same-handle object outside declared foreign containers with a different id | embedded copies of the visited user |
| I5 | counts never searched; read only at declared keys as non-negative safe integers (or digit strings, C1); `followers`/`following` emitted **as a pair**, `mutuals` only alongside; a partial pair emits no stat (`counts-partial`) | `following_count` read as `following`; `media_count` as followers |
| I6 | relationship booleans from declared keys only, present and boolean; withheld at C2/partial | the `is_following ≈ following` class |
| I7 | follow events: `story_type ∈ {101}` or the text marker; actor from `args.profile_id` (C0) else the agreeing aliases; a novel `story_type` is `enum-novel` (warn when zero follows recognised) | grouped or other story types read as follows |
| I8 | C2 requester rows require `incoming_request === true` on the node | the feed preview or suggestions read as the requests panel |
| I9 | epoch seconds in [2010-01-01, now + 1 day] → ms; else `time-range` and `atMs: null` | unit drift |
| I10 | `friendship_status: null` means self only when `viewerPk == record pk`; else `unexpected-null` and withheld | another account's missing relationship read as self |

Rows-unreadable: a page whose readable rows fall below `SURFACE_BOUNDS.rowMajority` (0.9) fails and the walk stops;
below that share, unreadable rows are quarantined and counted. `EXPECTED_KEYS[endpoint]` (decision-bearing paths present
in 100 % of the corpus) raise `expected-absent` on first absence (closes the `.nullish()` blind spot).
`EXPECTED_KEYS['profile-graphql']` includes `biography` and `is_verified` [arch r2]: every click verdict depends on them
(§7.3), so their absence must surface as a paused profiles area with a reason, never as a growing pile of
`kept('unreadable-*')` records.

### 10.4 The destructive hazards first (parser-agnostic slice)

- **Presence-gated relationships** (U07 S1/S2/F1/P1): `weFollow:true` iff `following === true` or `outgoing_request
  === true`; `weFollow:false` only when both are present and `false`; `followsUs` from `followed_by` if present. A
  branded `ObservedRelation` (`src/shared/observed-relation.ts`) is minted **only** in `src/surface/read/relationship.ts`
  (grep test); `RelationshipReconciler.ingest` accepts only that type, so `reconcileOwnFollow(pk, false)` is unreachable
  from an absent key. Cost on real data: zero facts lost (both keys present on every real body). New
  `ProfileViewer.incomingRequest` (presence-gated) for §9.9.
- **List continuation** (`continuationOf(page, decl, {final})`, `src/surface/read/continuation.ts`), rules in order:
  `final === false` → `drift{incomplete-stream}`; a non-empty string or safe-integer cursor → `next{cursor, form}`
  (`offset` if `/^\d{1,9}$/`, else `opaque`); no cursor and any declared more-flag (`has_more`, `big_list`,
  `has_next_page`) `=== true` → `drift{more-without-cursor}`; no cursor, flags present and all `false` →
  `end{flags-false}`; no cursor and no flags → `end{no-flags}` + `expected-absent`. `vetoKey` names the first
  unexplained cursor-like root key (consumed only where no probe can verify).
- **The walk decision** (`decideStep()`, `src/rim/list-walk-end.ts`, extracted in Phase F with today's behaviour, then
  changed): `lastForm` is sticky (any opaque cursor ⇒ opaque); declared form `followers: paged`, `following:
  whole-list`.

  | Page continuation | Form / state | Decision |
  |---|---|---|
  | `drift{reason}` | any | **stop** `shape-mismatch` (rows already streamed) |
  | any non-drift | `whole-list`, not probing | **probe** once in plain form at `listEndProbeCursor(rows)` |
  | `next` | `paged`, not probing | continue with the server's cursor |
  | `end` | `paged`, `lastForm ∈ {none, offset}` | **probe** `listEndProbeCursor(rows)` |
  | `end{flags-false}` | `paged`, opaque, no veto | **complete** (`server-flags`); no synthesized probe in an opaque space |
  | `end{flags-false}` | opaque, veto | **stop** `cursor-veto` |
  | `end{no-flags}` | opaque | **stop** `no-continuation-evidence` |
  | probe page, `newRows = 0` | probing | **complete** (`probe`) |
  | probe page, `next`, `newRows > 0` | probing, paged | continue from the **server's** cursor + `end-claim-false` drift |
  | probe page, `end` or whole-list, `newRows > 0` | probing | **stop** `end-claim-false`; never a second synthesized offset |
  | probe rejected with the past-the-limit 400 | probing | complete (`probe-rejected`) |

  Every stop maps to the existing `reason:'shape-mismatch'` + `stopDetail`, so downstream code is unchanged. **Quarantine**:
  `WalkResult.quarantined` counts unreadable rows; every absence consumer refuses when `quarantined > 0` (prune's
  `assertFetchComplete` → `row-issues`; `censusAuthority(…, quarantined)`; the follow-back census).
- **Pending requests**: the lenient `parsePendingRequests` is deleted; the drawer read returns `pendingComplete =
  read.ok ∧ tier ≠ recovered ∧ ¬partial ∧ rowIssues = 0 ∧ continuation.kind = 'end'` (with `has_next_page:true` the set
  is incomplete even at C0); new reasons `requests-walled`, `requests-unreadable`. The feed's pending preview
  (`data.xdt_api__v1__friendships__pending.users`, 4–5 rows) is read at C0 only, row by row, as presence — **never** a
  complete set.
- **Counts and coverage**: pair atomicity (I5); own counts only from C0/C1 non-partial reads; `refreshOwnStats`
  **returns the header** (`OwnStatsRefresh = {ok:true; header} | {ok:false; …}`) and prune keeps it for the scan;
  `coverageVerdict(scraped, known, quarantined)` (pure, `engine/census-authority.ts`) replaces `assertScanCoverage`:
  `known === null` → **fail closed** (`header-unknown`); `known < CENSUS_POLICY.coverageFloor` (50) → pass; `scraped <
  known × scanCoverageMin` (0.85) → `short`; `quarantined > 0` → `row-issues`; else ok. A visit `ok` without a valid
  count pair counts in the enricher's failure streak (ends the re-visit loop).
- **Evidence-backed "gone"** (fixes U10 F5): `absent` requires the declared container present and `null`, **no** GraphQL
  errors, and `final !== false`; `{data:{user:null}, errors:[…]}` is a wall or error, never absent. Visit outcome
  precedence: a wall body attributed to the visit → `walled{via:'body'}`; a drifted body not recovered →
  `unanswered{drift}`; DOM unavailable text with no wall/drift body → `gone{evidence:'page-text'}`; deadline →
  `unanswered`. Only `profile-absent` evidence may turn the seed field red (§13).

### 10.5 Transport

- **One decoder** `src/surface/transport/decode.ts`: strip a declared JSON guard (`for (;;);`) at offset 0; NDJSON /
  incremental merge (`{path, data}` deep-merged, `{path, items}` appended, `errors` concatenated, any other payload
  `bad-frame`); multipart (`--<boundary>`); `extensions.is_final === false` ⇒ `final:false` ⇒ **partial**. Composed
  reads use the same decoder; the in-page script returns `{ok, status, contentType, finalUrl, text}` for any 2xx with a
  parseable mime (fixes the json-only gate); `abortMs` becomes a parameter (`TAB.FETCH_ABORT_MS`); request bytes
  unchanged. One decode per observed response (today two).
- **GraphQL envelope** (`transport/graphql.ts`): error text = `message`/`summary`/`description` over **all** entries;
  a refusal signature → wall (`rate-limited` / `auth`); errors with no signature and no data → wall `server-error`
  (ambiguity resolves toward waiting; a persistent streak still surfaces as `unreadable`); errors with data →
  `partial`.
- **One observed gate** (`read/gate.ts`): 429/5xx → rate-limited wall; 401/403 → auth wall; HTML body → wall; 404 →
  `http-absent`; other non-2xx or unparseable mime → `not-data`; else `data`. A wall is never drift.
- **Routing** (`read/route.ts`, replaces both `matchEndpoint` copies): REST by URL; GraphQL by `x-fb-friendly-name`
  (then the form field, only with the optional Q4 capture); the **profile route matches any GraphQL path** (the path pin
  at `literals.ts:102` goes); then `x-root-field-name` against declared `rootFields` (C1); then a `consistent` learned
  op (C2); else null (deadline candidates may still recover it).
- **Mutations**: `decodeBody` in `MutationWatch.classify`; all error texts; GraphQL `errors[]` with no signature →
  new verdict `'error'`. An observed mutation response carrying `errors[]` (any signature) **is Instagram evidence**
  [arch r2]: it is never classified `unverified` (§11.1 F7); the DOM and the block probe decide its *class*
  (`rate-limited` / `blocked` / `drift-suspect`), and in every class it **counts as a refusal toward the recovery ladder**
  (`BLOCKED_STREAK_ENTRY`, `blockedStreakThreshold()` in a cleanup run) — ambiguity resolves toward waiting, exactly as on
  the read side; the record itself is never burned (no `fail` on the candidate) on an exchange-level error (ADR 0803
  amendment). The presence rule for `not-following` (a renamed `outgoing_request` cannot turn a failed cancel into
  `ok`; live L5 verifies the key); **candidate walls**: unmatched relationship-family mutation POSTs are kept and, on
  timeout, may yield a wall — never a success.

### 10.6 Structural recovery (three roles) and the surface gate

| Role | Endpoint | Trigger | Witness | Output (C2) |
|---|---|---|---|---|
| `profile-user` | `profile-graphql` | canonical container missing, or routed by a learned op / candidate | the armed visit's anchor (username, + pk when known) | observation fields; viewer **all null**; own counts dropped |
| `username-field` | `profile-graphql` | record found at C0/C1 but `username` absent | exactly one top-level string field equals the anchor username | read is C2 (viewer withheld) |
| `feed-stories` | `activity-feed` | container missing | a drawer pass is armed | follow events only |
| `request-rows` | `friend-requests` | container missing | the requests panel is armed | requester rows; `pendingComplete:false` |
| `source-rows` (r2) | `followers-list`, **acquisition walks only** | canonical rows container missing on a source's followers page | the walk's armed source pk; each row satisfies I1–I3 (allow-listed id + valid username); R2 decoys (suggested-user containers) skipped; R5 row majority | user rows into the **candidate pool only** (additive); the page's continuation is **never** recovered, so the walk stops after it |

Own-list walks (census, followers head, following check), `show-many`, `friendship-show` and mutations are **never**
recovered; a C2 `source-rows` read is accepted only by the acquisition walk, whose rows feed nothing but the candidate
pool — every candidate is re-read at C0 by its enrichment visit and again by the click before any follow, so a
recovered row can never cause a wrong action, only a wasted visit [arch r2, owner item 4]. `locate()` is bounded,
deterministic and
pure (R1 budget `searchMaxNodes` 20 000 / depth 12 / bytes 4 MB; R2 declared decoy containers skipped; R3 witness
required; R4 exactly one distinct pattern or `ambiguous`; R5 row majority, **an empty array never matches**; R6 hints
first; R7 identity continuity via an injected `IdentityOracle`). **Learned hints** persist in `surface_drift` (per
account; `open → consistent` after `driftConfirmThreshold()` distinct witnessed subjects with 0 contradictions;
`contradicted` on one contradiction; `resolved` on a surface-id change or clean canonical reads). A consistent hint
buys hint-first lookup and immediate learned-op routing — **never** promotion to C1 and never a destructive verdict
[owner Q25 default: pause unfollows until an Epo update confirms the change]. **Deadline candidates**: while a context is
armed, references (not bodies) to unrouted GraphQL responses of the matching family are buffered (≤ 8) and read only
when the wait is about to end `unanswered` (zero cost while healthy).

**SurfaceGate** (`paused(activity: 'unfollows' | 'relationship-reads' | 'cleanup' | 'follow-back-decisions' |
'exploration')`; the type and the never-paused default `NEVER_PAUSED` land in Phase F): unfollows and relationship reads
pause while the `profiles` area is `paused` (profiles read at C2, or an open `expected-absent` signature on a
relationship key). **Exploration** pauses [arch r2] as soon as the `lists` area has seen `driftConfirmThreshold()`
drifted source pages (a continuation-drift class, `rows-unreadable`, `expected-absent` on a list key, or a C2
`source-rows` read): **no further composed acquisition requests** — at most two drifted pages are ever requested after a
change, so Epo never keeps composing requests against a list format it no longer understands (A5) — while follows of
already-queued, enriched candidates continue. A drifted list never feeds the recovery ladder: the user sees the calm
`adapting` line or the `paused` attention line ("Instagram changed how follower lists look. Epo keeps following the
people it already found and pauses finding new ones until an update confirms the change."), never "Taking a break" as if
rate-limited (owner Q39). Every gate is checked **before** any read is spent (§9.7 step 0b; the acquisition slice's
first page); the plan mix treats the paused work as unavailable meanwhile (§5.7), so nothing spins. State is
persisted-derived; it opens when reads return to canonical for `driftConfirmThreshold()` reads.

### 10.7 Drift surfacing

- **Classes**: `normalized` (info), `recovered` (warn; area `adapting`; profiles pause unfollows), `unrouted` (warn,
  with op names seen), `expected-absent`/`unexpected-null` (warn; `paused`), continuation classes (warn; `paused(cleanup)`
  for lists, and `paused(exploration)` once `driftConfirmThreshold()` source pages drifted), `rows-unreadable`/`row-issue`, `mismatch`/`ambiguous`/`transport` (warn with the **decoded** body's keys;
  `unreadable` after the streak), `graphql-error`/`graphql-partial`/`incomplete-stream` (info), `wall` (info; `limited`),
  `novel-key`/`enum-novel` (info, once per path; checked against a pinned `NOVELTY_BASELINE`), `shadow-disagreed` (warn;
  gates deletion). Repeats are counted, not logged (one info line per signature per plan-day).
- **Sink** injected (`ReadEnv {doc, sink, hints, identity?}`; `src/surface` stays pure). `MemorySink` default (tests,
  probe, livetest); the production sink (`src/main/services/surface-health-sink.ts`) buffers counters per (plan-day,
  endpoint), flushes on the push-throttle trailing edge, plan-day roll and teardown, and writes a signature
  immediately on first sighting (warn + sample).
- **Persistence** (migration 16, §16): `surface_drift` (signature PK, surface id, endpoint, class, path pattern —
  never a value —, detail JSON of types/op names/counts, first/last seen, seen, sample, hint pattern, witnesses,
  contradictions, witness keys, state, clean reads) and `surface_health` (per plan-day × surface × endpoint counters).
  Retention at open and plan-day roll (`healthRetentionDays` 30, `driftRetentionDays` 90, `maxSignaturesPerEndpoint`
  200). `meta.surface_meter` persists the latency reservoir (`meterReservoir` 128); corrupt → cold meter + warn, never 0.
- **Samples** (owner Q25 default): on a signature's first sighting, up to `samplesPerDay` (12): scrub with the allow-list
  scrubber, run the structural leak rules, store ≤ `sampleMaxBytes` (16 KiB), drop any sample that still matches a
  rule. Local only; copied only by **Copy report** ("Report copied. It contains no usernames, names or account IDs.").
- **Area states** (pure `src/surface/health-view.ts`): areas `profiles | notifications | follow-requests | lists |
  relationship-checks | follow-actions`; states worst-first `unreadable | paused | adapting | limited | ok | unseen`.
- **Status and UI**: `EpoStatus.surface?: SurfaceSummary` rides the status push; one invoke `surface:report` (no
  arguments, no guard) pulled on panel mount and whenever `status.surface.revision` changes. Settings › Advanced ›
  **Instagram compatibility** panel; an Easy one-liner; a calm sidebar line for `adapting`, attention styling for
  `paused` / `unreadable` (owner Q25 default).

### 10.8 Corpus and laws (zero requests)

- Scrubber extensions (still an allow-list): `count` and `time` PII classes (counts keep 2 significant digits above
  100; times shifted); id aliases as pseudonyms. The 2026-08-12 **bodies** are re-scrubbed (their id aliases read
  `"string"`, breaking alias agreement); DOM snapshots stay byte-identical (contract tests mount them by name). The real
  2026-11-02 bodies (outside the repo, read in place, read-only) are ingested through the production router into
  `tests/fixtures/surface/2026-11-02/**`; the leak test must pass before commit [owner Q26 default].
- Laws (fast-check, fixed seeds, bounded): "correct parse or typed failure, never a wrong fact" and "small delivery
  changes still parse" over both corpora × mutation operators (key rename, wrapper, retype, framing, partial, errors);
  L-WALK over the decision table; L-RECOVER-C2 (never destructive); L-ANCHOR; L-DECOY.
- The U07 scenario regression table is a test (`tests/surface/u07-scenarios.test.ts` + rim/engine/adapter suites).

### 10.9 Bounds (new tier-1 modules)

```ts
// src/kernel/surface-policy.ts — guardrails; none is an IG-facing timing
export const SURFACE_BOUNDS = { searchMaxNodes: 20_000, searchMaxDepth: 12, searchMaxBytes: 4_000_000, rowMajority: 0.9,
  identityConflictMax: 0.05, fallbackCandidates: 8, sampleRows: 8, noveltyMaxDepth: 6, maxSignaturesPerEndpoint: 200,
  sampleMaxBytes: 16_384, samplesPerDay: 12, healthRetentionDays: 30, driftRetentionDays: 90, meterReservoir: 128,
  unmatchedPostsKept: 12, logHeadChars: 80, envelopeHeadChars: 256, requestBodyMaxBytes: 65_536,
  scrubCountDigits: 2, scrubCountFloor: 100 } as const;   // one guard line per entry (Appendix D lists every guard line)
// src/kernel/census-policy.ts
export const CENSUS_POLICY = { coverageFloor: 50, scanCoverageMin: 0.85,   // moved from prune-engine.ts:1163-1164
  maxWalkPages: 1_000 } as const;   // 5 × LIST_WALK_MAX_PAGES: a census longer than five runaway bounds is never one uninterrupted walk (§5.8.3)
// Every streak / consistency / auto-resolve count reuses driftConfirmThreshold() — no new number.
```

---

## 11. The unfollow confirm fix (item 5)

Source: U06 (root cause established; live incident 2026-11-02 18:30:48, Variant R). ADR 0308.

| Variant | Instagram flow | Defect today |
|---|---|---|
| **P** private account, header **Following** | header → menu sheet (`Unfollow` row) → **second dialog** "If you change your mind, you'll have to request to follow @x again." `[Unfollow] [Cancel]` | presses the menu row, never looks again; waits 12 s for a mutation only the unpressed dialog would fire, polls 8 s, returns "post-click state not confirmed"; the dialog stays on screen |
| **R** header **Requested** | header → confirm dialog | `dispatch()` runs at the header press (`actor.ts:566`) **and again** at the confirm press (`:592`); the second admission sees the first press's own `dispatched` intent and throws `ActionDeferredError('relationship reconciliation required')`; the confirm is never pressed |

Both end `blocked/tab-unhealthy/unverifiedClick` with an `uncertain` intent; the dialog stays open through parks; a
prune run halts `blocked-repeatedly`; reconciliation then marks the record terminal `external` (never unfollowed).

### 11.1 The fix (F1–F7)

- **F1 — one admission per action** (`src/adapter/action-admission.ts`): the dispatch closure runs `beforeMutation` +
  `onDispatch` **at most once**, before the header press (the first press that might fire the mutation) and after the
  look-before-act dwell; later calls (later layers of the same action) run only `check()` (abort, same profile URL).
  This follows ADR 0212 (journal mark once, before the first press that might fire the mutation) and removes the same
  hazard at `actor.ts:254`. From PR S2 on, `beforeMutation` is `MutationCadence.armAtDispatch` (re-check + persisted
  deadline); a refusal there throws before any press (§9.7).
- **F2 — the unfollow is a bounded sequence of confirm layers that ends on evidence** (new
  `src/adapter/unfollow-flow.ts`; `actor.ts` is at its ceiling):
  ```
  after the header press (needsConfirm):
    lastSig = null
    for layer in 0 ..< SURFACE.maxConfirmLayers (2; a surface fact in versions/*):
      step = waitFor(op, probeStep, s => s.kind !== 'pending')        // existing ADAPTER.POLL_* (D4) bounds
        probeStep: if watch.peek() !== null                → 'evidence' (mutation landed or was refused)
                   c = locate('unfollow-confirm')           // topmost-first, on-top, reports {layer, sig}
                   if c.found && c.sig !== lastSig && rectUsable(c.rect) → 'confirm'
                   if header ∈ {follow, follow-back}        → 'evidence' (inline / optimistic flip)
                   → 'pending'
      if step === null or step.kind === 'evidence' → break
      await tempo.wait('ui.step-pause')                               // a reading pause before moving to the located layer [r2]
      pressed = settleAndPress(guarded /* idempotent dispatch (F1) */, c, locate, rectUsable); lastSig = pressed?.sig ?? lastSig
      watch.markPress()
    then: the existing decide() / arbitrate(), unchanged
  ```
  Public: header → menu row → mutation in ≈ 1 s → exits on evidence (≤ one extra 250 ms poll). Private: header → menu
  row → dialog (new `sig`) → settled press → mutation. Requested: header (dispatch) → dialog → settled press, or an inline
  mutation exits at the first peek. The `sig` rule stops re-pressing a menu that is still fading out. Waits between
  layers are the D4 poll bounds, then the plan's `ui.step-pause` (a reading pause, owner item 1 "waits between
  individual mouse movements inside an action"; disabled under the reference tempo until PR S2, so CF's merge changes
  only the layer handling), then the tempo's `motion.hover-settle` inside `settleAndPress` — no new static timing.
- **F3 — confirm locate** (`src/adapter/page/confirm.ts`; rebuild the bundle): walk dialog scopes in **reverse document
  order** (portals append, newest on top), `document` last (a cfg flag drops it for later layers); require the
  candidate to be **on top** (`elementFromPoint(centre)` inside it — `visible()` alone accepts a fading menu); report
  `layer: 'dialog'` when the hit's nearest `[role=dialog]` also contains a visible control matching `companionRx`
  (= `confirmCancelText`), else `'menu'`; report `sig` = dialog index from the end + count of role-marked controls +
  normalized text. **No press fallback** [arch r2]: when the text pass misses on a later layer, the flow **never
  presses**. Epo only runs on an English interface (a non-English one already fails at the header), so a miss means an
  *unexpected* dialog — "Restrict @x?" after a mis-pressed row, a Block confirm, a "Try again later" notice — and pressing
  its first button could be destructive on a valuable account. The flow exits through F5 (Cancel matched by
  `companionRx`, else the Close X), records a `confirm-unrecognized` drift signature and triggers the passive capture,
  so the literal is fixed at the root. A structural two-button match is computed for the capture's report only and is
  never pressed. Zero Instagram literals in page code; `companionRx` and flags arrive through the descriptor
  (`ControlSchema` is `.loose()`).
- **F4 — one `MutationWatch` across the presses**: keep the single watch armed before the header press (do not re-arm;
  a re-subscribe could miss a response). Add non-blocking `peek()` and `markPress()` (latency baseline from the final
  press, so the `mutation-arrival` meter stops including hydration and menu animation) to `ResponseWatch`. Count
  `MUTATION_BLINDNESS` only when **no confirm layer is still on screen** (today a UI stall becomes a false "mutation
  table matches nothing" error after 2 stalls).
- **F5 — leave the tab clean on any exit that did not land**: if the flow ends with a layer visible (no mutation,
  header unchanged), press the dialog's **Cancel** (new control `unfollow-dialog-cancel`, dialog scopes only) or the
  menu's **Close X** (the existing `drawer-close` descriptor matches `svg[aria-label=Close]`) via `settleAndPress`
  (CDP is the only press path); a failure to close is a warn, never silent.
- **F6 — an unverified unfollow that did not land stays managed**: the journal settlement row "unfollow observed
  following/requested → intent `cancelled`, record stays `unfollow_queued`" (§9.8). **F6 must land before the
  production engine runs again** (the live store has one such stuck intent from 18:30).
- **F7 — one stall is not a wall; a streak is** [arch r2]. `mutation-outcome.ts` maps failed+dispatched with **no
  Instagram evidence** (no mutation response observed, no refusal text, header unchanged) to a distinct cause
  `unverified`, which parks (`park.blocked`, pace-up) and does not by itself record `noteOutcome('rate-limited')`
  (today any non-local-policy block does, `engine.ts:709`). An observed response with `errors[]` is evidence and is never
  `unverified` (§10.5). **The breaker:** today `normalizeMutationOutcome` turns failed+dispatched into `blocked`
  (`mutation-outcome.ts:4-7`), so it never reaches the failed-streak breaker either; without a replacement a persistent
  silent refusal (a control disabled client-side, an unknown error routed to the DOM) would cost a visit, presses, a
  Cancel and a park per candidate all day. So: `unverifiedStreak(kind) ≥ driftConfirmThreshold()` (2) makes that kind's
  work **unavailable in the plan mix** (follows continue when it is unfollows) with the typed attention
  `actions-unconfirmed` ("Epo couldn't confirm its last 2 unfollows, so unfollows wait until the next session."), and
  from then on every further `unverified` outcome counts toward `BLOCKED_STREAK_ENTRY` (3) and, in a cleanup run, toward
  `blockedStreakThreshold()`; the next session allows one attempt, and a third unverified enters the ladder. Any
  confirmed outcome of that kind resets the streak.
- **Passive capture hook**: when the layer loop meets layer ≥ 1 or ends with a layer visible, save the topmost dialog's
  `outerHTML` through the existing scrub pass plus the watch's `unmatchedPosts`, to the local diagnostics area (never
  committed, never uploaded). The next real, already-due private unfollow is both the live test and the capture (§22
  L5). No probe ever presses Unfollow.
- The follow path shares the layer loop with **zero** layers expected, so an unexpected dialog on a follow is noticed
  and logged.

### 11.2 Tests (no live data needed)

1. Page (jsdom, real captures): mount `dialog-02.html` (menu) then append `dialog-01.html` (dialog); the second-layer
   locate returns the dialog's `<button>Unfollow</button>` with `layer:'dialog'` and a new `sig`, never the menu row.
2. Actor Variant P: `clicks == [HEADER, MENU_ROW_SETTLED, DIALOG_SETTLED]`, `beforeMutation` ×1, `onDispatch` ×1.
3. Actor Variant R: a `beforeMutation` that **rejects on its second call** (the real `createMutationPolicy` contract);
   expect ok and one admission — the regression test for the incident.
4. Public: mutation on the menu press; two clicks; no layer-2 wait beyond one poll.
5. Stall: dialog visible but never pressable → Cancel pressed, blindness unchanged, honest error.
6. Settlement F6: uncertain unfollow + visit showing following/requested → record `unfollow_queued`, intent `cancelled`.
7. Existing single-confirm tests (`tests/adapter/health.test.ts`, `actor-settled-press.test.ts`) keep passing; their
   fakes answer `peek()` and `sig`.
8. Dispatch order: a `beforeMutation` that refuses → **zero** presses; the dwell precedes the closure.
9. Unexpected dialog: a later layer whose text pass misses (a two-button "Restrict" fixture) → no press, Cancel/Close,
   a `confirm-unrecognized` signature and a capture request.
10. Breaker: two `unverified` unfollows → unfollow work unavailable with `actions-unconfirmed`, follows continue; the
    third (next session) enters the ladder; an `errors[]` mutation response counts as a refusal, never `unverified`.
11. Pacing inside the action (Variant P and R with a recording tempo, `enabled` true): the wait sequence contains one
    `ui.step-pause` per located layer, before its travel.

---

## 12. Live sidebar, Settings stage, visual refresh, launch (items 2, 9)

Source: T3 FINAL (spine L1 ambient monitor; grafts from L2 narrative and L3 outcomes). ADR 1010 (console, stage space,
store-first boot), ADR 0405 (type ladder, palette, Inter, motion vocabulary), ADR 1011 (the Settings stage).

### 12.1 Principles of the column

One live instrument column, **no navigation and no management** [owner]. One-second read (the top 300 px answer "what
is Epo doing, is it OK, what happens next and when"). Every number is true or absent (no digit from a not-built
projection: law L-ZERO). Every Instagram-observed number carries its age. The plan is the clock (every "next" is a
plan or engine deadline, shown as a time and a countdown). Motion means change. Plain words, no raw keys.

### 12.2 Zones (460 px wide, 24 px side padding, 412 px content; fixed heights, reserved slots, no reflow)

```
┌ 460 ─────────────────────────────────────────────┐
│ (e) Epo                          @yourname   ●   │  44  Masthead (same height as the stage bar)
│ ╭──────────────────────────────────────────────╮ │
│ │ ╭──────╮  Working          [⚡ Boost][Practice]│ │
│ │ │  ↯   │  Following @jane.doe                 │ │ 216  Now — the single raised surface
│ │ ╰──────╯  Next step in 1:12 · Why?            │ │
│ │ [ ❚❚  Pause                      ] [  Stop  ]│ │
│ │ (reason line, reserved)                      │ │
│ ╰──────────────────────────────────────────────╯ │
│ Today's plan                         [⚡ Boost]  │
│ ▕░▓▓░░░░▓▓▓▓│░░▓▓░░░▓░░░▏  9 AM  12 PM  3 PM     │ 172  Today
│ 23 of 40 follows · 6 of 12 unfollows             │
│ This session until about 3:10 PM                 │
│ +12        ▁▂▄▃▅▆█   followers today · 7 days    │ 168  Results
│ 1,284 followers · checked 3:12 PM                │
│ 5 follow-backs today · 38 waiting                │
│ Recent activity                        ↑ 2 new   │ rest Recent activity (the only scroller)
│ ⊕ Followed 3 people · @jane, @kai +1       2m    │
│ ── Since you left · Mon 11:20 PM ─────────────── │
│ Epo 3.4.1                          Diagnostics   │  36  Footer
└──────────────────────────────────────────────────┘
```

- **Masthead**: the locked "e" (24 px; breathing ring while tone `live`, brass while `hold`), "Epo" 17 px/600,
  `@username` from `EpoStatus.account` and an 8 px connection dot. The "Growth engine" tagline goes.
- **Now**: ring 88 px (stroke 6; 72 px compact) with one meaning per posture (indeterminate arc while an op is in
  flight; **depletes** from `lastActionAt` to `nextActionAt` between actions; depletes toward `posture.countdown.to`
  while resting/pacing/retrying; static track + glyph when idle); posture word 32 px/600 (≤ 15 chars by contract) with
  reserved pill slots (`⚡ Boost` — an **indicator only**, not a button; **Practice**); now line 17 px (`liveOpText(op)`
  or the posture sentence); next line
  13 px tabular ("Next step in 1:12" / "Next session at 2:40 PM") ending in **Why?** (a sidebar-clamped popover with a
  checklist); a reserved 3 px progress hairline for ops with a known total; row 2 = **one posture-derived primary
  button** (44 px) + **Stop** (or Start when the primary is an attention action); row 3 = the reason line (typed
  refusals of the user's own commands, attention follow-ups; replaces the raw-key toasts).
- **Today**: "Today's plan" + the **Boost control** (§8.6: one tap with the saved length; the only Boost button); the
  session strip from `status.plan.sessions`, cropped to
  `[floorHour(min(first start, now)), ceilHour(max(last end, now))]` (done = silver fill with inner proportion; partial
  = outline; now = `--live` fill growing with done/planned; next/later = outline; skipped = hatched "Skipped — Epo
  wasn't running"; before-open = dotted; Boost = a 3 px `--live` underline band); a 2 px now marker moved by **one**
  WAAPI animation; axis labels via `Intl.DateTimeFormat`; summary "23 of 40 follows · 6 of 12 unfollows"; next line
  ("This session until about 3:10 PM" / "Next session at 2:40 PM" / "Today's plan is done · next session tomorrow at
  9:04 AM" / "Today's sessions had already passed when Epo opened · next session tomorrow at 9:04 AM" / "Light day —
  about 5 actions." / "Light day — no actions planned today." / "Day off — Epo does no automatic work today." only when
  `plan.day.dayOff`). No plan yet → one sentence, never a strip of zeros.
- **Results**: hero `±N` (48 px/650, true minus sign) = `status.today.net` (plan-day bounded; `--ok` when > 0,
  `--muted` otherwise — losses during cleanup must not alarm); a 7-plan-day spark (hidden until plan-day bucketing
  exists); followers line from `status.own` with its age ("· checking now…" while the catch-up runs; "Epo shows your
  follower count after it opens your profile." when never observed); follow-backs line.
- **Recent activity** (the only scroller): typed, store-derived feed (`FeedView`, §12.9), 48 px rows (28 px tone disc +
  glyph, 14 px sentence, 12 px relative time from the minute clock), day groups by plan-day ("Today", "Yesterday",
  weekday, date), a "Since you left · Mon 11:20 PM" divider, grouped rows expand on click (max 20; "+N more"),
  `overflow-anchor: none` with an "↑ N new" pill when scrolled away; empty "Nothing yet today. Activity shows up here as
  Epo works."; `aria-live="off"`; each `@handle` opens the person on the People page.
- **Footer**: version or "Update ready · Restart" / "Update available · View"; **Diagnostics** opens Settings ›
  Advanced › Diagnostics.
- **Get started** replaces Today + Results on a first run (`!loggedIn || seed none || lastActionAt === null`):
  "✓ Sign in to Instagram" · "○ Choose a starting account [Choose →]" · "○ Press Start", each checking off live.
- **Short windows**: ≥ 800 px content height as drawn; 680–799 px → Masthead and Now fixed, the rest one scroller;
  < 680 px → plus a compact Now (176 px). One media query; no sheet.

### 12.3 Posture — one vocabulary, one pure function (`src/shared/posture.ts`)

`derivePosture(input, now)` replaces four disagreeing renderer reconstructions (`engine-view.ts:27-41`,
`runtime-copy.ts:8-36`, `live-status-copy.ts:61-182`). The renderer calls it in one cached `computed`; main calls the
same function for the window title and Dock badge. Precedence (first match wins; the order is a tested law):

| # | Kind | Condition | Headline | Tone | Primary |
|---|---|---|---|---|---|
| 1 | `starting-up` | `boot.phase === 'starting'` | — | — | — |
| 2 | `data-unavailable` | `boot.data === 'unavailable'` | Can't open your data | alert | diagnostics |
| 3 | `signed-out` | identity signed-out or `!loggedIn` | Signed out | idle | sign-in |
| 4 | `needs-attention` | `runtime.blockedReason` or `state === 'halted'` | Needs attention | alert | the attention action (+ Start) |
| 5 | `sleeping` | runtime suspended | Sleeping | calm | pause if intent running |
| 6 | `reconnecting` | runtime reconciling/recovering | Reconnecting | hold | pause |
| 7 | `offline` | `online === false` and work intended | Offline | hold | pause |
| 8 | `cleaning-up` | prune scanning/running/paused | Cleaning up / Clean-up paused | live / hold | pause-cleanup / resume-cleanup |
| 9 | `catching-up` | a startup step runs, or `catchUp.state === 'running'` | Catching up | live | starting (if a Start is queued) / pause / start (queues) |
| 10 | `starting` | queued/pending Start, or running first step before any action, deadline, recovery or planned wait is known | Starting | live | starting (disabled) |
| 11 | `paused` | paused, or desired paused and idle | Paused | hold | resume (calls `startEngine` when idle) |
| 12 | `needs-seed` | idle and no seed | Let's get set up | idle | set-up |
| 13 | `stopped` | idle | Stopped | idle | start |
| 13a | `working` | running and a live op in flight | Working | live | pause |
| 14 | `taking-a-break` | recovery holding | Taking a break | hold | pause |
| 15 | `day-off` | running and `plan.day.dayOff` (a day the **user** set off; never inferred from `planned === 0`) | Day off | calm | pause |
| 16 | `done-for-today` | park `daily-ceiling` or `plan.totals.remaining === 0` — including a late first open (`lateStart ∧ planned === 0`: next line "Today's sessions had already passed when Epo opened") and a zero-volume light day (`light ∧ planned === 0`: "Light day — no actions planned today") | Done for today | calm | pause |
| 17 | `pacing` | park `velocity` / `read-budget` | Pacing | calm | pause |
| 18 | `retrying` | park `enrich-backoff` | Retrying soon | hold | pause |
| 19 | `resting` | park `session`, or no open plan session | Resting | calm | pause |
| 20 | `working` | running (default) | Working | live | pause |

Boost and Practice are **overlays** (pills), not kinds. During a prune the buttons control the prune ("Pause
pruning", "Stop pruning"; the unified transport). **Stop has no confirm**; an Undo toast offers to resume (Stop is
not destructive: Start resumes today's plan) [owner Q29 default].

**Attention** (`src/shared/attention.ts`): `classifyBlock(raw)` maps every persisted runtime-block literal and every
`haltReasonKey(ALL_HALT_REASONS)` to a typed `Attention {key, raw, action, blocksSchedules}`; an unknown key gets
neutral copy plus "Code: {raw}" (the raw key is never the sentence). Actions: `start`, `show-live`, `choose-seed`,
`check-update`, `open-prune`, `diagnostics`, `restart-app`, `wait`. Every attention adds "Scheduled work waits until
you press Start." A test greps every `blockRuntime('…')`, `stopForIncident('…')`, `.block('…')` literal under
`src/main/**` and asserts each classifies to a known key.

### 12.4 The stage bar and main plumbing

| Key (`StageMode`) | Label | Icon | Shortcut |
|---|---|---|---|
| `tab` (internal key kept) | **Live** | `instagram` | ⌘1 |
| `people` (new) | **People** | `users` | ⌘2 |
| `graph` | **Graph** | `circle-nodes` | ⌘3 |
| `prune` (internal key kept) | **Prune** (owner Q28 answer, §18.3: the owner's own word) | `user-minus` | ⌘4 |
| `settings` (new) | **Settings** | `sliders` | ⌘5 and **⌘,** |

- Tabs 36 px tall, 14 px labels, equal width `clamp(100px, (stageWidth − 32px)/5, 132px)`. Right-side context on Live:
  "Epo is using this page" / "Epo uses this page again in 1:12" / "You can browse freely". A 6 px `--live` dot on the
  Live tab breathes while Epo uses the page and you are elsewhere.
- **Traps closed**: `StageMode` gets one canonical source `src/shared/stage-mode.ts` (`STAGE_MODES`, `isStageMode`);
  the `setStage` handler validates with `isStageMode` and **logs** an unknown mode (today `ipc.ts:132-136` silently
  ignores it, which would leave the native IG view drawn over a new page); `showTab`/`hideTab` are deleted; `login()`
  no longer shows the tab (the renderer's Sign in sets `stage = 'tab'` first); `TooltipHost` and a new `PopoverHost`
  render at shell level (today `App.tsx:166` traps tooltips inside `.console` with `overflow:hidden`); accelerators come
  from a real application menu so ⌘1–⌘5 and ⌘, work while Instagram has focus; dashboard zoom is removed
  (`setVisualZoomLevelLimits(1, 1)`, no zoom roles; CSS px always equals DIP); concealment stays re-stacking, never
  `setVisible(false)`.
- **Stage hosting** (`src/renderer/app/StageHost.tsx`) [arch r2, "a fully preloaded app"]: **Graph mounts eagerly
  behind the splash** (today it stays mounted, `GraphStage.tsx:3-5`, so its layout and camera are ready before the
  intro); **People** and **Prune** mount on first activation but render instantly from data fetched at shell level
  behind the splash (chain list, growth series, queue lanes, the last census — fetches, not mount effects); **Settings
  mounts lazily** (the second guard for item 10: nothing on it can run mount effects at boot; its `settingsView` and
  `settingsFacts` are preloaded through their pushes). Every page paints opaque `var(--bg)`, resets scroll on open and
  runs `staggerSections`. `.prune-page`/`.prune-col` become generic `.stage-page`/`.stage-col` (the pinned
  container-ramp selector string changes in the token commit).
- **Overlays over native views**: on the Live stage the IG view covers `x ≥ 460, y ≥ 44`; bubbles and popovers anchored
  in the sidebar are clamped to the sidebar rect (`place(anchor, size, bounds)`); if they cannot fit, tooltips are
  suppressed (the `aria-label` carries the text) and popovers open upward/inline. Modals keep `covered = true`.
- **`StageController`** (`src/main/window/stage-controller.ts`, the only entry point): validates, serializes (latest
  request wins), and enters Live through the **veil curtain**: `veil.curtain('opaque')` (two rAFs, bounded by
  `BOOT.CURTAIN_PAINT_MAX_MS`) → `shell.setStage('tab', false)` (tab re-stacked above the dashboard, under the veil) →
  `veil.curtain('clear')` (fade over `BOOT.CURTAIN_FADE_MS`) → `curtain('off')`; unpainted in time → a plain cut. Leaving
  Live is instant. It also sets the **window title** (`Epo — Working`, `Epo — Resting until 2:40 PM`, `Epo — Needs
  attention`) and the macOS Dock badge `!` only for `needs-attention`/`data-unavailable` (owner Q29 default).
- **Application menu** (`src/main/window/app-menu.ts`): App (About, Settings… ⌘,, Hide, Quit) · Edit (role editMenu)
  · View (Live ⌘1 … Settings ⌘5, each sends `PUSH.stageRequest`; Reload and DevTools only unpackaged) · Window.

### 12.5 People (Targets + Queues become one stage page)

"Your followers over time" (measured net growth only; the static projection band and `charts/growth-model.ts`,
`growth-overlay.ts` are deleted — their constants violate item 1, owner Q30 default) above two `.stage-col` columns:
**Where Epo finds people** (now exploring, steps, funnel, "Enough people for about N days") and **In progress** (lanes
Up next · Waiting · Following back · Leaving soon · Kept; a record changed outside Epo shows "Changed outside Epo ·
not yet verified" until the following check ran, §9.2). Re-hosted and reworded: `ChainBreadcrumb`, `ChainNode`,
`TargetFunnelCard`, `PoolRunwayCard`, `ConversionCard`, `QueuePipeline`, `QueueRowItem` ("Hop N" → "Step N", "Pool
observed" → "People found", "Runway N d" → "Enough for about N days", "Queued/Awaiting/Held/Due" → "Up next/Waiting/
Following back/Leaving soon", `r=0.97` removed, user-retired sources → "Set aside when you restarted" via a new
`'retired'` target status). Fetching is active-gated; `useChainList` runs once at shell level.

### 12.6 Visual refresh (identity kept, density fixed) [ADR 0405]

- **Type** (semantic ladder, `design/scale.ts`, generated): `--fs-micro` 11 · `--fs-caption` 12 · `--fs-small` 13 ·
  `--fs-label` 14 · `--fs-body` **15** · `--fs-lead` 17 · `--fs-title` 20 · `--fs-heading` 26 · `--fs-state` 32 ·
  `--fs-hero` 48. Rule: text rungs `15 + [−4, −3, −2, −1, 0, +2]`; display rungs `2·round(16·1.25ⁿ/2)` for
  n ∈ {1, 2, 3, 5}. The fluid `cqi` roles are deleted. Uppercase only on badges ≤ 3 characters.
- **Spacing** extends `4 × [0.5, 1, 2, 3, 4, 5, 6, 8, 10]` (adds 32 `--sp-7` and 40 `--sp-8`; existing rungs keep their
  values). **Controls** `32 + 4n` = 32 / 36 / 40 / 44 (`--h-ticker` deleted). **Radii** 8 / 10 / 14. Sidebar padding
  24 px; zones separated by hairlines, not boxed. Hit targets ≥ 32 px; stage tabs 36; primary 44.
- **Palette** (measured WCAG 2 against every surface): `--faint #8e8e97` (4.63–5.98:1; today `#66666e` fails
  everywhere), `--muted #a8a8b0`, `--danger #d27878`; the rest unchanged; state aliases `--st-live/-calm/-hold/-alert/
  -good/-idle` (colour is state; Boost uses `--live` + a one-shot sheen, never a new hue) [owner Q28 default; reopens
  exactly three "approved" values].
- **Geometry** stays **460 × 44** [owner Q28 default]: `src/kernel/shell-geometry.ts` `SHELL_GEOMETRY` is the one home
  (`shell.ts` imports it; a test parses `shell.css` and asserts equality; three wrong-file comments are fixed).
- **Typeface**: bundle **Inter Variable** (Latin subset ≈ 110 KB, OFL) under `src/renderer/fonts/`; `styles/fonts.css`
  first in the cascade; esbuild renderer loader gains `'.woff2': 'file'`; CSP `font-src 'self'` already allows it;
  `document.fonts.ready` is a readiness criterion [owner Q28 default].
- **The mark**: `src/shared/brand-mark.ts` is the single geometry source (`ui/EpoMark.tsx` renders it; the splash in
  `index.html` and the favicon data URI carry copies pinned by a test). The mark's shape is never edited.
- **From cards to instruments**: one raised surface in the column (Now); everything else sits on the column background
  separated by hairlines.

### 12.7 Motion that explains change [ADR 0405]

| Gesture | Meaning | Mechanics | Reduced motion |
|---|---|---|---|
| settle | a value changed | `NumberTicker` reels (`--dur-4` 480 ms); fills via `scaleX` | instant swap |
| deplete | time running down toward a known deadline | **one** WAAPI animation per deadline identity (`stroke-dashoffset` or `scaleX`), `duration = to − now`, linear; re-armed only when the deadline identity changes | static fraction refreshed by the minute clock |
| arrive | something new appeared | 280–320 ms translateY(−8 → 0) + opacity; FLIP siblings; highlight fades over 1.2 s | instant |
| breathe | a live process is running (two uses only) | 2.6 s / 2.2 s opacity loops on pseudo-elements | static |
| nudge | needs attention | two ±3 px shakes, once per transition | border colour only |
| file-into | the action just done is now history | FLIP from the now-line rect to the new top feed row, then a check stroke | the row appears |

Tokens `--dur-1` 120 · `--dur-2` 200 · `--dur-3` 320 · `--dur-4` 480 · `--dur-5` 900 ms, `--breath` 2.6 s, `--ease`,
`--ease-out`, `--ease-in-out`; mirrored in `src/renderer/design/motion-scale.ts` as `DUR = PERCEPTION_MS × 1.2 × [1,
5/3, 8/3, 4, 7.5]` (a test asserts CSS = TS and `PERCEPTION_MS === EMPIRICAL.DISPLAY.perceptionMs`). Counts **never
roll at boot** (`NumberTicker` arms one frame after mount; a "+N" chip floats only on an increase after first paint).
No-jank rules: animate only transform/opacity/stroke-dashoffset/clip-path; fixed zone heights; tabular numerals; zones
`contain: layout paint`; **one renderer clock** (`nowSignal` with ref-counted second/minute subscriptions, ticking per
second only while a visible `m:ss` exists); every WAAPI call goes through `play()`, which resolves at once in jsdom or
under reduced motion (animations never gate logic). `reducedMotionSignal` follows the media query live. At most two
infinite loops, both compositor-only; the `box-shadow` pulse is replaced. Verify with `node scripts/background-probe.mjs`
(the dashboard pacing guard ≤ 150 callbacks/s must hold).

### 12.8 Launch: load behind a splash, then an intro into a fully preloaded app

**Timeline (returning, signed-in user):**

| t | Main (`src/main/launch.ts`) | Renderer | User sees |
|---|---|---|---|
| 0 | `createAppShell({…, startHidden: true, deferDashboardLoad: true})`: hidden window and dashboard background `#0d0d0f`, zoom limits 1–1, IG tab attached with `goto(IG_HOME_URL)` (kept as `igFirstLoad`), veil attached; `stage.cover()` | — | Dock bounce |
| ~2 ms | log sink → `LogRing`; `new Foundation(…)` (SettingsService reads its document synchronously, **R1**); tour pending → `setTourHold(true)`; `await composeApp(host)`; **`registerEpoIpc`**; then **`shell.loadDashboard()`**; `boot.start()` | — | — |
| ~5–20 ms | **R2** cookie → signed-in/out; **R3** `session.openFromStore()` (store open + migrations + `buildGraph(pk, undefined)` with the own username from the store's own `accounts` row; projections bind; opening push); `boot.markReady()` pushes status with `boot.phase: 'ready'`; the **`'startup'` lease is claimed now** and steps 1–2 begin as soon as the IG home load settles | the inline splash is laid out | — |
| ~150–400 ms | dashboard `did-finish-load` → **`shell.reveal()`** (`maximize()` when the saved state is maximized, else `show()`; then `focus()`); fallback `BOOT.SHOW_FALLBACK_MS` | `<App/>` renders **under** the splash; pulls status, pruneStatus, settingsView, settingsFacts, feedView, activityNow, updateStatus, chainList, growthSeries, the queue lanes; the Graph stage mounts | the splash: the mark on graphite with a shimmer hairline |
| ~1.5–4 s | **behind the splash**: the home load settles (`igFirstLoad`), then step 1 `open-own-profile` (today's landing: press the nav profile link, wait for the URL; the own header is observed for free) and step 2 `confirm-account` | — | the splash (caption after `CAPTION_DELAY_MS`) |
| ready | `boot.ig = 'ready'` (or `'placeholder'` past `BOOT.IG_READY_DEADLINE_MS`, offline, signed out, or the tour held) | **R4 ∧ R5** hold and the splash's minimum dwell passed → **intro** | the intro into a preloaded app |
| +600 ms | `StageController.set('tab', false)` → curtain reveal onto the **own profile**, already landed | otherwise the Live placeholder ("Opening Instagram…" / offline copy) | Instagram fades in, settled |
| +900 ms | `bootRevealed()` → `boot.phase = 'live'` → the rest of the **startup sequence** (catch-up, resume-run) under the same lease | `#boot` removed; first-launch tour may open | "Catching up", then "Stopped" (or "Working" after a crash resume) |

**Before the reveal Instagram sees only what a launch already sends today**: the home-page load and the own-profile
landing (`landOnOwnProfile`, which today runs right after launch; it now runs behind the splash). **Boot adds zero
Instagram traffic**; no drawer, no list read and no third-party visit happens before the reveal. The window is already
shown at `did-finish-load` with the splash covering it and the IG view re-stacked below the dashboard, so the landing
press goes through the same CDP input path Epo uses for all background work (every survival layer untouched) [arch r2,
owner item 9: "load everything in the background behind a loading animation, then an intro into a fully preloaded app"].
The catch-up's drawer pass stays **after** the reveal: 20–60 s behind a splash would not be a launch (§25 note 2).

**Readiness (normative):** R1 settings loaded (main, synchronous) · R2 identity decided (one cookie read) · R3 store
open + projections bound + opening push with `basis:'built'` (or `not-applicable` signed out, or `unavailable` with a
typed `dataProblem`: `future-version` | `unreadable` | `locked`), bounded by `BOOT.DATA_DEADLINE_MS` (past it the
renderer reveals with final-size skeletons and "Loading your numbers…") · R4 renderer: `boot.phase ∈ {ready, live}` and
(`basis === 'built'` or signed out or data unavailable) and `pruneSignal`, `settingsViewSignal`, `settingsFactsSignal`,
`feedSignal`, `chainListSignal`, the growth series and the queue lanes non-null and `document.fonts.ready` and
`MIN_SPLASH_MS` elapsed · **R5** the IG first navigation settled **and** steps 1–2 done when their `when()` holds (signed
in, runtime ready, tour not held) — or `BOOT.IG_READY_DEADLINE_MS` passed, or offline, in which case the reveal proceeds
onto the Live placeholder. The reveal is bounded by `boot.revealBy = startedAt + max(DATA_DEADLINE_MS,
IG_READY_DEADLINE_MS)`. **Readiness rides `EpoStatus.boot`** (atomic with the first built data; no `epo:boot` channel)
[arch: T3 C6]. Whether a longer splash on a slow network is acceptable is owner Q40 (default: yes, bounded by the
deadline).

**Splash** (`index.html`): a sibling `<div id="boot" role="status">` before `#app`, inline `<style>` only (CSP allows
inline styles, forbids inline scripts): full-window `#0d0d0f`, the mark (72 px), a 120 × 2 px shimmer, an empty caption
line driven by `BootGate` ("Opening your data…" after `CAPTION_DELAY_MS`; "Still loading — this can take a moment." after
`SLOW_COPY_MS`). Gallery mode removes `#boot` at once. **Intro** (`src/renderer/boot/intro.ts`, ≈ 900 ms, WAAPI
`fill:'both'`): the splash mark FLIPs into the masthead mark (0–480 ms); the backdrop fades (80–480); masthead and
stage bar rise (120–440); Now/Today/Results/Activity stagger 60 ms; ring arc, plan blocks and spark bars draw in to
their **current** fractions (numerals appear at their true values; nothing counts up); hand-off at 480; Live reveal at
≈ 600; `bootRevealed()` at ≈ 900. Reduced motion: a `--dur-2` cross-fade, a cut instead of the curtain.

**Paths:** slow store (skeletons at `revealBy`, values fade in, no count-up); store open failed (posture "Can't open
your data" with per-problem copy, never stale or zero numbers); signed out (lands on `signed-out`; Live shows
Instagram's login page); offline (local boot identical; the IG load fails fast → placeholder "Instagram can't load while
you're offline. Epo reloads it when you're back online." + [Try again]; main retries the home load once per online
transition); first launch (intro then tour; the store opens under the tour hold, steps wait for its release); no own
username in the store (degraded graph; `confirm-account` resolves it behind the splash and rebuilds while idle);
renderer reload (`boot.phase === 'live'` at mount → no intro; main does not re-run startup); `bootRevealed` never
called (main proceeds at `BOOT.SETTLE_DEADLINE_MS`, so crash auto-resume never depends on the intro); account switch
(teardown → `basis:'not-built'` skeletons → `needs-attention`); slow Instagram (the reveal at `IG_READY_DEADLINE_MS`
lands on the placeholder; steps 1–2 finish under the lease after the reveal).

**The startup sequence** (claim `TabLease` owner **`'startup'`** at R3; steps in order; each skipped when its `when()`
is false; each owns its bounds; a failure is logged and the next runs; steps 1–2 run **behind the splash**, steps 3–4
after `BootSequencer.revealed()` or the settle deadline):

| # | Step | `when()` | What it does | Owner |
|---|---|---|---|---|
| 1 | `open-own-profile` | signed in, runtime ready, tour not held | today's landing, moved unchanged (`landOnOwnProfile`): press the nav profile link, wait for the URL; the `ProfileObserver` writes the own header as a free side effect | boot |
| 2 | `confirm-account` | signed in | `usernameFromProfileUrl(tab.currentUrl())`, else identity strategies 1–2 (passive evaluates); equal → confirmed; different/new → rebuild while idle; inconclusive → unchanged (own-list work stays un-wired on a degraded graph) | boot |
| — | (reveal) | — | R4 ∧ R5 → intro → `bootRevealed()` | — |
| 3 | `catch-up` | §9.6 admission | `FrontierSweep.run('launch')` | reopen |
| 4 | `resume-run` | `runtime.wantsRun()` (a crash left intent `running`) | today's `restoreRuntimeIntent()`, moved unchanged | boot |
| — | release | always | release the lease; `afterStartup()` calls `seedCheck.onTabFree()` (the scheduled-prune watcher no longer exists) | — |

User commands during the sequence: `startEngine` awaits `boot.whenStartupDone()` (posture "Catching up · Epo starts
right after this check"); it is **never** refused with `manual-running` (fixes U10 §6.1). `startBoost(…, {alsoStart:
true})` queues the same way. Manual one-offs and prune scan/run get the typed refusal `'starting'` ("One moment — Epo is
finishing starting up."). Stop calls `boot.cancelStartup()` (the running step's signal aborts; the rest are skipped).
`login()` reuses steps 1–2 under the same lease. The engine **still starts idle** [lead]; only a crash resume starts it
(after the reveal and the checks, ≈ 1–3 s later; owner Q29 default).

**Identity is store-first; the session never navigates.** `GraphSession.openFromStore()` replaces the tab-driven
`buildResolved` path (no veil, no tab work); `buildGraph` uses `given ?? store.getAccount(ownPk)?.username`; the
degraded-username retry leaves `ensureBuilt` (`session.ts:139-148`), so **no IPC read can navigate the tab** any more;
`GraphSession.rebuildWith(username)` (engine running/paused → defer and log) is called only by `confirm-account`. The
tour hold no longer blocks the store open. Safety: no username-dependent tab work (own-list walks, `refreshOwnStats`,
the landing's arrival check) runs before `confirm-account` — Start is queued behind the lease, prune and manual
operations get `'starting'`, and a degraded graph has no own-list sources wired. Instagram does not redirect old
handles, so the ordering is the guard.

**The narrow `shell.ts` change** (additive options, defaults = today; amends ADR 1007's scope line):
`AppShellOptions.startHidden?`, `deferDashboardLoad?`; `AppShell.reveal()`, `loadDashboard()`, `igFirstLoad:
Promise<'ready' | 'failed'>`; background `#0d0d0f`; `dash.setBackgroundColor('#0d0d0f')`;
`dash.webContents.setVisualZoomLevelLimits(1, 1)`; `maximize()` deferred to `reveal()` when hidden; geometry from
`SHELL_GEOMETRY`. Untouched: stacking order, `TabPlacement`, `backgroundThrottling`, the tab's frame-rate switch, the
veil's attach order, `DashboardRecovery` semantics. A new `never-shown-boot` background-probe scenario (zero Instagram
traffic) checks it.

### 12.9 Contracts (condensed; Appendix C holds the full set)

```ts
// src/shared/boot.ts
export type StartupStepName = 'open-own-profile' | 'confirm-account' | 'catch-up' | 'resume-run';
export interface BootView { phase: 'starting' | 'ready' | 'live'; identity: 'pending' | 'signed-in' | 'signed-out';
  data: 'pending' | 'open' | 'not-applicable' | 'unavailable'; dataProblem: 'future-version' | 'unreadable' | 'locked' | null;
  tab: 'loading' | 'settled' | 'failed'; ig: 'pending' | 'ready' | 'placeholder';   // R5 (r2): landed behind the splash, or the placeholder
  startedAt: number; revealBy: number;
  startup: { step: StartupStepName | null; startQueued: boolean; done: boolean } }
// src/shared/live-op.ts — the typed activity that replaces free-text labels at the seven reporter call sites
export type LiveOp = { op: 'follow' | 'unfollow' | 'accept-request'; username: string }
  | { op: 'open-list'; list: 'followers' | 'following'; of: string }
  | { op: 'browse-list' | 'read-list'; list: 'followers' | 'following'; of: string | null; done: number; total: number | null }
  | { op: 'visit-profiles'; done: number; total: number }
  | { op: 'visit-profile'; username: string; purpose: 'check-back' | 'verify' | 'settle' | 'seed' }
  | { op: 'check-notifications' } | { op: 'open-own-profile' } | { op: 'confirm-account' };
export interface ActivityInfo { kind: 'api' | 'page'; op: LiveOp }
export declare function liveOpText(op: LiveOp): string;            // one sentence for the sidebar AND the veil (SB owns the wording)
export declare function toVeilInfo(info: ActivityInfo): VeilInfo;  // Phase F: an identity test pins today's seven veil strings;
                                                                   // from SB on the veil shows liveOpText too (L-COPY), so both surfaces say the same
                                                                   // plain sentence, including the new visit purposes (check-back · verify · settle · seed)
export interface LiveTab { activity: { info: ActivityInfo; since: number } | null; busy: boolean; holds: readonly string[] }
// src/shared/feed.ts — derived from existing tables + durable owners; NO history table
export type FeedItem = { id: string; at: number } & (
  | { kind: 'followed'; people: Person[]; via: 'plan' | 'boost' | 'you'; practice: boolean }
  | { kind: 'unfollowed'; people: Person[]; why: 'no-follow-back' | 'after-follow-back' | 'clean-up' | 'you' | 'other'; practice: boolean }
  | { kind: 'followed-back'; person: Person; afterMs: number | null; dated: boolean }
  | { kind: 'new-followers'; people: Person[]; dated: boolean } | { kind: 'lost-followers'; count: number }
  | { kind: 'request-accepted'; people: Person[] }
  | { kind: 'not-done'; action: 'follow' | 'unfollow' | 'accept'; person: Person; why: 'refused' | 'unavailable' | 'unconfirmed' | 'error' }
  | { kind: 'kept'; person: Person; reason: string }
  | { kind: 'boost'; edge: 'started' | 'ended'; endsAt: number | null; why: 'user' | 'expired' | 'clock' | null }
  | { kind: 'slowed-down'; until: number | null } | { kind: 'resumed'; after: 'restart' }
  | { kind: 'caught-up'; summary: AwaySummaryLite });
export interface FeedView { items: readonly FeedItem[]; awayFrom: number | null; windowStart: number; shapedAt: number }
```

Feed rules (`shapeFeed`, pure, main): groups consecutive same-kind follows/unfollows/new followers within
`LIVE.GROUP_WINDOW_MS` (= the session boundary; group id = the **oldest** member's id, stable as the group grows); new
followers exclude pks with a managed follow-back record or an accept intent; ≤ `LIVE.FEED_LIMIT` (60) items within
`LIVE.FEED_WINDOW_MS` (7 days). **Session started/ended rows are never emitted** (the plan holds planned times, not
actual starts — that moment would be fabricated). The feed rides a `feed` projection row with `dedupe` (push only when
the shaped JSON changed). The activity push holds a `null` for `BOOT.ACTIVITY_NULL_HOLD_MS` (2 × perception), so the now
line never blinks between steps. The raw log moves to Settings › Advanced › Diagnostics, backed by a main-side
`LogRing` (500) and streamed only while the panel is mounted (owner Q30 default).

```ts
// src/kernel/boot-policy.ts (main-side boot guardrails; derived where possible)
export const BOOT = { SHOW_FALLBACK_MS: 1_500, DATA_DEADLINE_MS: 4_000, SETTLE_DEADLINE_MS: 8_000,
  /** r2: the typical launch — p95 home hydration plus two median navigations — lands behind the splash; slower → placeholder. */
  IG_READY_DEADLINE_MS: LATENCY.hydration.p95 + 2 * LATENCY.nav.p50 /* 4 200 + 2 400 = 6 600 */,
  CURTAIN_PAINT_MAX_MS: Math.ceil(6 * FRAME_MS) /* 101 */, CURTAIN_FADE_MS: 3 * PERCEPTION_MS /* 300 */,
  ACTIVITY_NULL_HOLD_MS: 2 * PERCEPTION_MS /* 200 */ } as const;
  // laws: SHOW_FALLBACK < DATA_DEADLINE < IG_READY_DEADLINE < SETTLE_DEADLINE; derived values equal their formulas
// src/kernel/live-policy.ts
export const LIVE = { FEED_LIMIT: 60, FEED_WINDOW_MS: 7 * MS_PER_DAY, GROUP_WINDOW_MS: SESSION_BOUNDARY_MS, GROUP_PEOPLE_MAX: 20 } as const;
export const DIAGNOSTICS = { LOG_RING: 500 } as const;
// src/kernel/shell-geometry.ts
export const SHELL_GEOMETRY = { SIDEBAR_WIDTH_PX: 460, STAGE_BAR_HEIGHT_PX: 44 } as const;
// src/renderer/design/motion-scale.ts (renderer presentation; §3 deviation 1)
export const PERCEPTION_MS = 100;   // pinned to EMPIRICAL.DISPLAY.perceptionMs by a test
export const DUR = { 1: 120, 2: 200, 3: 320, 4: 480, 5: 900 } as const; export const BREATH_MS = 2600;
export const BOOT_UI = { MIN_SPLASH_MS: 600, CAPTION_DELAY_MS: 1200, SLOW_COPY_MS: 2500 } as const;   // 6P, 12P, 25P
```

---

## 13. No stale state on reopen (item 10)

**Principle:** the store is the last-known snapshot; every Instagram-observed number carries its age;
`basis: 'built' | 'not-built'` makes fabricated zeros impossible. No separate snapshot file (a second source of truth,
stale by construction).

**The owner's symptom** ("the target profile is not available anymore") is the seed card's catch-all copy "Couldn't
verify @x — account not found, or its followers aren't visible." (`useSeedCheck.ts:29-30`), shown for **any**
non-verdict. Confirmed mechanism (the 2026-11-02 18:28:48 relaunch): an always-mounted hidden Settings view fires a live
seed check on mount at every launch (`ViewStage.tsx:31-43`, `useSeedCheck.ts:93-101`) while `restoreRuntimeIntent()`
auto-starts the engine; `checkSeed` refuses with `busyDriverReason() = 'engine-running'`, typed `exists:false`; the
renderer says "not found"; nothing re-checks. Four defects, each fixed at its root:

| Defect | Fix | Where |
|---|---|---|
| D1 a live visit on mount from an always-mounted hidden view | Settings is a lazily mounted stage (no launch visit at all); the seed field never checks on mount | §12.4 StageHost; §6.4 seed field |
| D2/D3 refusals typed as facts; catch-all copy | a typed `SeedCheckResult` union with exhaustive copy; `queued` and `unreadable` are never red | below |
| D4 never re-validated; no single tab owner | one queued handle in main (latest wins), run when the tab owner grants a slot (`onTabFree()`, also called at startup-lease release); the `'startup'` lease | §12.8 |
| D5 a DOM-text `gone` persists "unavailable" | evidence-backed `gone` (§10.4); `page-text` evidence is amber, never "doesn't exist" | §10.4 |
| D6/D7 silent refusal; unmetered read | every non-verdict logged; a real visit consumes a profile read permit | below |

**Seed status is a store projection** (`seedStatus(store, handle, queue)` in `src/main/modules/seed-check.ts`, served in
`settingsFacts.seed`): `none` · `loading` (store not open; never a verdict) · `checking` / `queued(why)` · `unseen` (no pk
known) · `seen` (current username, `statsObservedAt`, followers, private, `followersVisible` = our own follow edge for a
private seed) · `gone` (only from this session's evidence-backed check). A live check runs **only on explicit intent**
(committing a different handle, or [Check now]); a handle the store observed within the profile-fresh window (one
weekly cycle of plan-days, §5.16) returns `ok` with `fromStore: true` and no visit.

```ts
export type SeedQueueReason = 'engine' | 'prune' | 'manual' | 'runtime-blocked' | 'offline' | 'signed-out' | 'read-budget' | 'starting';
export type SeedCheckResult =
  | { kind: 'ok'; pk: string; isPrivate: boolean; followersVisible: boolean; followers: number | null; observedAt: number; fromStore: boolean }
  | { kind: 'not-found'; evidence: 'profile-absent' | 'page-text'; observedAt: number }
  | { kind: 'queued'; why: SeedQueueReason }
  | { kind: 'unreadable'; why: 'walled' | 'signed-out' | 'challenge' | 'no-answer' | 'aborted' | 'drift' | 'error' }
  | { kind: 'invalid-handle' };
```

Copy (only `not-found/profile-absent` turns the field red): "✓ @x · 12.4k followers · public · checked 3 h ago" · "@x is
private. Epo can only see its followers if you follow it." (amber) · "Epo hasn't checked @x yet. It checks before
following anyone from it. [Check now]" · "Epo is busy right now. It will check @x as soon as it's free. Your starting
account is saved." · "You're offline. Epo will check @x when you're back online." · "Instagram says @x doesn't exist.
Check the spelling." · "Instagram shows @x as unavailable. Check the spelling, or try again later. [Check again]" ·
"Couldn't check @x just now. Your starting account is unchanged. [Try again]". Changing the starting account while a
chain is active offers "Start over from @new" (= `restartFromSeed`, through the settings service) or "Save for later".
Start without a seed opens Settings → Who to follow with the field focused.

**Every other stale site** (U10 §7, U05 §6.4):

| Stale display | Fix |
|---|---|
| zeros before the build ("0 / 0", "No target yet", "Closed") | store-first open + `basis` + R4 + final-size skeletons; law L-ZERO |
| sign-in flash: `blockRuntime` pushes `notBuiltStatus(false)` (`foundation-wiring.ts:1072-1075`) | push the real status (cookie-derived `loggedIn`) |
| `lastActionAt` in memory | `engine.lastActionAt ?? store.lastSettledMutationAt()` (latest `effect_intents.settled_at` with result ok/simulated) |
| Targets detail ≠ the target the engine resumes | `peekResumeTarget(store, frontier)` (pure, `src/engine/resume-target.ts`), shared by the pipeline and `status.resumeTarget`; the renderer mirror is deleted |
| halt copy masked by the runtime block; "Paused" beside a Start button after a crash | one posture function + typed attention; Resume calls `startEngine` when idle |
| a persisted block silently freezes schedules | "Scheduled work waits until you press Start." |
| `seed-unresolved` on transient failures becomes a persisted block | halt only on evidence-backed `gone` |
| frozen relative times; `scanReady` never re-pushed at expiry | the minute clock; `Projections` arms **one** timer at the earliest `expiresAt()` any source declares (the prune source declares the census freshness end) |
| "You are up to date." without a check; the replay races the subscription | `UpdateStatus.state` gains `'unchecked'` (initial) and `'unavailable'` (no feed/offline) + `checkedAt`; an `updateStatus` invoke pulled at mount; the `did-finish-load` replay is deleted |
| derived settings persisted as values; no settings push; a failed first read never retried | §6 (derived at read time; `epo:settings`; keep-alive pull with error state) |
| "Restart from seed" paints retired sources as exhausted | `Target['status']` gains `'retired'`; "Set aside when you restarted" |
| IG stage shows the seed's profile after reopen | no launch seed visit; `open-own-profile` runs uncontested under the lease |
| "Start refused: manual-running", then the engine starts anyway | startup lease + queued Start |
| the veil says "Working" at every launch for an unrequested visit | no seed visit; honest startup chips ("Opening your profile", "Checking your notifications") |
| the log has no history or pull | `LogRing` + `logTail` |

---

## 14. Cross-topic contradictions, resolved

Each row names the conflict, the decision and the evidence. All are **[arch]** unless marked.

| # | Conflict | Decision | Why |
|---|---|---|---|
| C1 | ADR numbers: T1 and T2 both claim 0607; T2 and T5 both claim 0213; T2 and T3 both claim 1010 | 0607 DayPlan/tempo (T1); **0608** settings envelope + settings-policy tier (T2); 0213 frontiers/verify-at-act/journal (T5); **0214** protection + `kept` (T2); 1010 live console/stage space/store-first boot (T3); **1011** Settings stage (T2); 0105 Settings v2 document (T2); 0308 confirm layers (U06); 0405 visual refresh + motion (T3); 0704 change log + own counts (T5); 0806 one parser (T4); 0904 Boost | one number per decision; series by area (CLAUDE.md) |
| C2 | Where Boost state lives: T1 `plan_state.boost`; T2 "meta or Chronos (T7)"; U09 offers Chronos or meta | **`plan_state.boost`**, written only by `PlanService` | the window write and the re-plan are one atomic `setPlanState`; Chronos has no production consumer; a second key would be a second writer of one decision |
| C3 | Boost commands: T1 `startBoost(): PlanProjection`; T2 `startBoost(hours, {alsoStart}) → BoostCommandResult` + `previewBoost` | **T2's contract** (typed refusals, per-Boost hours, preview); `endReason` unified as `'user' \| 'expired' \| 'clock'` (T2's `'account-switch'` dropped: a per-account window is not ended by switching) | typed refusals are required by T3's reason line; `alsoStart` needs the runtime epoch |
| C4 | Boost projection: `PlanProjection.boost` (T1) and `EpoStatus.boost: BoostView` (T2/T3) | **one**: `EpoStatus.boost?: BoostView`; `PlanProjection` drops `boost`; strip sessions carry `mix: 'boost'` | one definition per fact |
| C5 | Plan-day boundary vs quiet hours: T1's boundary is the λ trough; T2 adds quiet hours and days off as plan masks T1 never modelled | boundary = argmin of the **masked** weekday λ, ties to the centre of the longest minimal run; `PlanIntent` gains `quietHours`, `daysOff`; sessions placed on λ_eff; a day off = `V = 0`, binding `day-off` | quiet hours must be a hard mask (T2: "Epo does nothing on Instagram during quiet hours"); the trough rule alone would place sessions inside a custom window |
| C6 | Settings previews: T1 `previewPlan(patch)` invoke; T2 `previewSettings(ops)` + `PlanPreviewPort` | **no `previewPlan` channel**; `PlanService` implements `PlanPreviewPort`; the renderer reads `SettingsView.options/typical` (precomputed per revision) and calls `previewSettings(ops)` for what-ifs; today's live plan comes from `status.plan` | the renderer cannot import the kernel (error) and T2's ops are the one write vocabulary; one preview path |
| C7 | Settings push: T2 owns `epo:settings` + `settingsFacts`; T3 L2 also claimed it | **T2 owns** both; T3's boot gate (R4) consumes `settingsViewSignal` | T2 is the single writer |
| C8 | Readiness channel: `epo:boot` push + pull (T3 L1/L3) vs riding status | **`EpoStatus.boot`** (atomic with the first built data); one invoke `bootRevealed` | no cross-channel ordering assumption |
| C9 | Per-record verification: T1 keeps plan-day freshness pre-reads (`freshSince`), `RECONCILE.BATCH_MAX/HALT_FAILURES`, `reentryPhase()`, `AdmitRefusal 'reconcile'`; T2 Exit 2 assumes a watcher pre-read; T4 gates `managed-relationships.read()`; T5 deletes all pre-reads (verify-at-act) | **verify-at-act** (T5): the click is the one read; no batches; no halt; `lastMutationBefore(t)` replaces `reentryPhase()`; refusal `'journal'` replaces `'reconcile'`; `evidenceDueByDayEnd` dropped; the SurfaceGate check lives in click review step 0b | the click already arbitrates every case (`mutation-policy.ts:67-101`); the pre-read's only consumers are deleted; halves profile visits; removes the wedge class. Refines the [lead] decision; fallback named in §9.7 |
| C10 | Census sizing: T1 `Σ_side min(LIST_WALK_MAX_PAGES, …)`; T5 header-relative followers pages + 2 following pages | **T5** (§5.8): followers `⌈n·1.1/rpp⌉ + 2`, following `SURFACE.followingWalkPages`; 200 stays the bound for acquisition and an unknown header | the 200 cap makes a full census impossible above ≈ 4 000 followers at today's measured page size; following is one whole-list response + one probe; the term grows only with the account (A4) |
| C11 | Check cadence anchor: T1 = newest `check` read debit; T5 = the sweep's end | **`checkDue(reopen.lastSweepEndedAt())`** | a check whose steps were all fresh reads nothing and would stay due forever |
| C12 | Review columns: T2 `kept_reason/match/at/recheck_at` + `#n` suffix; T5 `followback_after/park_reason/check_failures/recheck_at` + intent columns | **one migration 14** with all seven `follow_records` columns + `effect_intents.attempts/next_attempt_at`; `recheck_at` and `check_failures` shared; the `#n` suffix dropped | one column, one meaning; one id |
| C13 | Bookkeeping keys: T2 adds meta `cadence_state`, `prune_last_run_at` | **neither**: the sweep's last run is `reopen_state.lastSweep` (T5); the bulk prune schedule is retired (C14). The v1 `sweepLastRunAt` is carried once to seed `reopen_state` | two homes for one fact would drift |
| C14 | The scheduled bulk prune: T1 Q12 "retire, T6 decides"; T2 moves cleanup into sessions and removes the schedule card | **retired**: the 30-min watcher, `pruneScheduleDays`, `pruneLastRunAt`, `SCHEDULER.AUTO_PRUNE_CHECK_MS`, `NOISE.PRUNE_LAUNCH_JITTER_MAX_MS`, `PRUNE.SCAN_FRESH_MS` (census freshness = the plan's census rule). Cleanup = woven `U_prune` inside sessions + manual "Run now" [owner Q10 default] | one cleanup cadence (the plan); a second pacer would violate A1/A2 |
| C15 | Legacy pacing on migration: T2 "Your pace was kept" vs T1 "map to clockwork + trickle" | **T1's mapping** applied once in the cut-over commit (consistency `clockwork`, rhythm `trickle`), notice per §5.17 | an even rhythm is expressible as clockwork; "kept" was only true while the pacer existed |
| C16 | T2's `INTERIM` values (`pruneDailyLimit` 50, `pruneScheduleDays` 7, `followbackSweepHours` 1) vs T1 deletions | the interim recommendations exist only until the plan port registers (`capabilities.plan`); after that `unfollow.cleanupPerDay`, `unfollow.censusEveryDays`, `checks.everyHours` recommend the plan's values and act as **lowering/override** inputs to `PlanIntent` | no lying UI between waves |
| C17 | Tempo overrides: T2 promises `tempo.*` rows with an undefined `TEMPO_OVERRIDE_MAX_FACTOR` | `SETTINGS_POLICY.TEMPO_OVERRIDE_MAX_FACTOR = 3` (guard: keeps the longest in-step silence under the step watchdog, law L11); lower bound = **1** (r2: overrides only lengthen; the brisk side is the plan's own pace draw); `gap.action` and `check.spacing` are not tempo rows (they are `sessions.gap*` and `checks.everyHours`) | an override is a reference factor, never a drawn value (owner item 1); ADR 0608's envelope rule bounds the risky side by the briskest value the kernel draws |
| C18 | `maxRetries`: T2 `RECOMMENDED.maxRetries 3`; T1 `retryLimit()` from `RETRY_CONFIDENCE` | **`retryLimit()`** recommends `unfollow.attempts`; `RECOMMENDED.maxRetries` is not declared | one derivation |
| C19 | Errors at the click: T2 `ActionProtectedError(verdict)`; T5 `ActionReviewedError(ClickVerdict)` | **one** `ActionReviewedError(ClickVerdict)` whose union includes `protected`, `protection-unknown`, `protection-paused` | one consuming error type; one outcome mapping in `churn-actions.ts` |
| C20 | The drawer capture: T4 S0 `drawer-capture.ts` (gate, strict requests); T5 S0 `feed-capture.ts` (watermark, chip, per-body) — the same closure | one file `src/rim/feed-capture.ts`, owned by the reopen stream; the parse stream provides a pure `readDrawerBody()` (`src/adapter/drawer-read.ts`) that the capture calls | one owner per hot file; the read pipeline stays T4's |
| C21 | Probation: T1 "absence spanned a whole plan-day"; T5 `probationOwed` pure function | **`probationOwed`** (kernel `plan/probation.ts`, owned with the plan core) + the one-time upgrade flag | pure, DST-safe; no state |
| C22 | Status field placement: T1 on `EngineStatus` via the engine projection; T3/T4/T5 fields on `EpoStatus` | one shared `StatusFields` interface (`src/shared/status-fields.ts`): `basis` (required) + optional `boot, account, plan, boost, catchUp, own, today, journal, requests, surface, unfollowsPaused, actionsUnconfirmed, resumeTarget`; composed in main by `status-compose.ts` from the **current graph's** `BuiltGraph.statusContributors` (each wiring module *returns* its contributors; `graph-builder.ts` aggregates them once per build — no global `register()`, so a rebuild or account switch never duplicates one) plus the graph-independent `boot`, `account`, `basis` contributors; `EngineStatus` keeps its fields (`pacing` and `reentry` deprecated-optional until the Phase I removal sweep) | `foundation-wiring.ts` is at its ceiling; each stream adds contributors in its own wiring module, conflict-free |
| C23 | Launch catch-up during quiet hours / days off | it runs (the user opened Epo; the web client loads the profile anyway); automatic work never runs then; copy: "Epo does no automatic work during quiet hours. Opening Epo still refreshes your numbers." | consistent with T2's "anything you start yourself still runs" |
| C24 | Store bounds and the boundary rule: retention/span literals belong in the kernel (A3) but `store → kernel` adds a `store-allow-list` warning | **every** store repo (old and new: surface drift, feed reads, growth, census, reopen state) receives kernel values through `KnowledgeStore` options (`StorePolicy`, assembled by main from `STORE_POLICY`, `SURFACE_BOUNDS`, `LIVE`, `BOUNDS_REENTRY`, `CLOCK_TOLERANCE_MS`, `driftConfirmThreshold()`) or method arguments (the plan-day window from `PlanDayClock`), never by import; tests via `tests/kit/store.ts` | no warning growth; one declaration |
| C25 | Session mode: T1 `SessionMode = 'normal' \| 'boost' \| 'probation'` cannot express a probation Boost session | two orthogonal fields: `mix: 'normal' \| 'boost'`, `probation: boolean` | both can hold at once |
| C26 | `src/shared/stage-mode.ts`: T2 adds `'settings'`; T3 adds `'people'` and `'settings'` | `STAGE_MODES = ['tab', 'people', 'graph', 'prune', 'settings']` (Phase F) | — |
| C27 | `followbackRule` placement and `rules.ts` budget (303/303) | moved to `lifecycle-rules.ts` in Phase F (−9 lines), owned by the unfollow-decisions stream afterwards | frees room for the `journal` rule |
| C28 | `mutation-policy.ts` is edited by four topics | split in Phase F: `mutation-admission.ts` (plan/cadence), `click-review.ts` (verdict order), `own-stats.ts` (refresh returning the header), `prepare-mutation.ts` (standalone-write settlement; r2), `mutation-policy.ts` (thin composition) | exclusive ownership per concern |

---

## 15. Contracts: IPC, pushes, projections, guards, status fields

All channel strings appear exactly once, in the per-topic contract files spread into `src/ipc/contract.ts`; `epo:*` push
strings stay in `contract.ts` (`push-channels.test.ts`). Phase F lands **every row below** with typed stub handlers that
return their typed fallback; streams replace their stubs.

### 15.1 Invoke channels

| Method | Channel | req → res | Guard | Typed fallback | Owner stream |
|---|---|---|---|---|---|
| `settingsView` | `settings:view` | `[]` → `SettingsView` | — | `service.view()` | settings-core |
| `applySettings` | `settings:apply` | `[ops: SettingsOp[]]` → `SettingsSaveResult` | `SETTINGS_OPS` | `{kind:'refused', reason:'internal', …}` | settings-core |
| `previewSettings` | `settings:preview` | `[ops]` → `SettingsPreviewResult` | `SETTINGS_OPS` | `{kind:'unavailable'}` | settings-core |
| `settingsBasis` | `settings:basis` | `[]` → `BasisResult` | — | `{kind:'unavailable'}` | settings-core |
| `settingsFacts` | `settings:facts` | `[]` → `SettingsFacts` | — | `notBuiltFacts('error')` | settings-core |
| `suggestAccounts` | `accounts:suggest` | `[query, scope]` → `SuggestResult` | `QUERY` (≤ 31), `SCOPE` | `{kind:'unavailable'}` | settings-core |
| `keptList` | `protection:kept` | `[page]` → `KeptPageResult` | `PAGE` (int 0..10 000) | `{kind:'unavailable'}` | settings-core |
| `checkSeed` (re-typed in SU's last commit) | `seed:check` | `[handle]` → today's result shape until SU's last commit (the handler runs on a `SeedCheckResult` core and maps it down), then `SeedCheckResult` | **`SEED`** (new) | `{kind:'unreadable', why:'error'}` (old shape: today's fallback) | settings-core; re-typed by settings-ui |
| `pruneCandidates` (re-typed) | `prune:candidates` | `[]` → `PruneCandidateView[]` (+ `protectedBy`, `bioUnread`) | — | `[]` | unfollow-decisions |
| `getSettings` / `updateSettings` / `resetSettings` | unchanged | **transitional** v1 adapter (§6.10) | `updateSettings` keeps `SETTINGS_PATCH` | `getSettings` → `toV1Settings(view)`; the others **rethrow** | settings-core; deleted by settings-ui |
| `startBoost` | `boost:start` | `[hours, opts: {alsoStart: boolean}]` → `BoostCommandResult` | `HOURS` (finite), `BOOST_OPTS` | `{kind:'refused', reason:'internal', boost}` | plan-core |
| `endBoost` | `boost:end` | `[]` → `BoostCommandResult` | — | same | plan-core |
| `previewBoost` | `boost:preview` | `[hours]` → `BoostPreview \| null` | `HOURS` | `null` | plan-core |
| `bootRevealed` | `boot:revealed` | `[]` → `void` | — | `undefined` | boot (BL) |
| `activityNow` | `activity:now` | `[]` → `LiveTab` | — | `{activity:null, busy:false, holds:[]}` | live-data (LD) |
| `feedView` | `feed:get` | `[]` → `FeedView` | — | `notBuiltFeed(now)` | live-data (LD) |
| `logTail` | `log:tail` | `[]` → `LogEntry[]` | — | `[]` | live-data (LD) |
| `setLogStream` | `log:stream` | `[enabled]` → `void` | `[BOOL]` | `undefined` | live-data (LD) |
| `openLogFolder` | `log:open-folder` | `[]` → `void` | — | `undefined` | live-data (LD) |
| `updateStatus` | `update:status` | `[]` → `UpdateStatus` | — | `updater.current()` | live-data (LD) |
| `surfaceReport` | `surface:report` | `[]` → `SurfaceReport` | — | the not-built report (all areas `unseen`) | parse-health |
| `setStage` (changed) | `stage:set` | `[mode, covered]` → `void` | hand validation (`isStageMode` + warn) | `undefined` | Phase F (handler); boot (BL) (controller) |
| `login` (changed) | `foundation:login` | unchanged; no longer shows the tab; runs the identity steps | — | `status` | boot (BL) |
| `showTab`, `hideTab` | **removed** | — | — | — | Phase F |

**GUARDS** keys after the overhaul (pinned, sorted): `applySettings, chainDetail, checkSeed, keptList, previewBoost,
previewSettings, queueList, restartFromSeed, setLogStream, startBoost, suggestAccounts` (+ `updateSettings` until the
transitional adapter is deleted). Guards check **shape only** (ADR 1009); clamps stay in coercion.

### 15.2 Push channels and projections

| Push | String | Payload | Projection? |
|---|---|---|---|
| `status` (existing) | `epo:status` | `EpoStatus` (now `EngineStatus & StatusFields`) | yes (row 1) |
| `pruneStatus`, `chainList` (existing) | — | — | yes (rows 2, 3) |
| `log`, `updateStatus` (existing) | — | `log` now sent only while the Diagnostics panel streams | no |
| `settings` (new) | `epo:settings` | `SettingsView` | **no** (does not derive from the graph; sent by the service after every persisted write) |
| `settingsFacts` (new) | `epo:settings-facts` | `SettingsFacts` | **yes** (row 4; also sent on each settings change) |
| `feed` (new) | `epo:feed` | `FeedView` | **yes** (row 5, `dedupe: true`) |
| `activity` (new) | `epo:activity` | `LiveTab` | no (not graph-derived; null-held) |
| `stageRequest` (new) | `epo:stage-request` | `StageMode` | no (application menu) |

`PROJECTIONS` order (pinned): `status, pruneStatus, chainList, settingsFacts, feed`. `ProjectionSource` gains
`settingsFacts()`, `feed()`, and optional `expiresAt()`; after each push-all, one timer is re-armed at the earliest
`expiresAt` (clamped ≥ now + throttle). Before the graph exists, every source serves a zeroed **not-built** shape that
never fabricates (`basis: 'not-built'`, facts `built:false`, feed empty).

### 15.3 Status fields

```ts
// src/shared/status-fields.ts — renderer-safe; EpoStatus = EngineStatus & StatusFields (types.ts +1 import, offset)
export interface StatusFields {
  readonly basis: 'built' | 'not-built';                 // REQUIRED: never render counts from 'not-built' (law L-ZERO)
  readonly boot?: BootView;                              // boot (BL)
  readonly account?: { readonly username: string | null; readonly confirmed: boolean } | null;   // boot (BL)
  readonly plan?: PlanProjection | null;                 // plan-runtime
  readonly boost?: BoostView | null;                     // plan-core
  readonly catchUp?: CatchUpView | null;                 // reopen
  readonly own?: OwnCountsView | null;                   // reopen
  readonly today?: TodayCounts | null;                   // reopen
  readonly journal?: JournalView | null;                 // reopen
  readonly requests?: RequestsView | null;               // reopen
  readonly surface?: SurfaceSummary | null;              // parse-health
  readonly unfollowsPaused?: 'protection-needs-review' | 'protection-unavailable' | null;   // unfollow-decisions
  readonly actionsUnconfirmed?: { readonly kind: 'follow' | 'unfollow'; readonly streak: number } | null;   // plan-runtime (F7 breaker, r2)
  readonly resumeTarget?: { readonly pk: string; readonly username: string | null } | null;  // live-data (LD)
}
// EngineStatus: `pacing` and `reentry` stay as DEPRECATED OPTIONAL fields (the old renderer reads them) until the Phase I
// removal sweep after the sidebar merge; `status.plan` / the reopen fields replace them. `lastActionAt` falls back to
// store.lastSettledMutationAt() (live-data, LD); `netToday` kept = today.net until the sidebar lands.
export interface StatusContributor { readonly name: keyof StatusFields | string; contribute(graph: BuiltGraph | null, now: number): Partial<StatusFields> }
// Registration: BuiltGraph.statusContributors (returned by each wiring module, aggregated once per build in graph-builder.ts)
// + the graph-independent boot/account/basis contributors in status-compose.ts. LD's resumeTarget lives in live-wiring.ts.
```

`notBuiltStatus` sets `basis: 'not-built'` and every optional field `null` ("not known yet", never zeros). The fake
bridge's `idleStatus` gets `basis: 'built'`.

---

## 16. Data and migrations

### 16.1 Store migrations (ids allocated now; all land in Phase F through the `late-migrations` barrel)

`src/store/schema.ts` ends with `...LATE_MIGRATIONS` (Phase F split); each migration is its own module under
`src/store/schema/`. New tables' DDL is generated with `ddl(t)` from manifest definitions and pinned by
`tests/store/tables.test.ts`; ALTERs are hand-written; `assertSchema` holds the manifest to the database at open.

| Id | Name / module | SQL |
|---|---|---|
| 14 | `review-columns` / `review-columns-migration.ts` | `ALTER TABLE follow_records ADD COLUMN kept_reason TEXT;` `… kept_match TEXT;` `… kept_at INTEGER;` `… recheck_at INTEGER;` `… park_reason TEXT;` `… check_failures INTEGER NOT NULL DEFAULT 0;` `… followback_after INTEGER;` · `ALTER TABLE effect_intents ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;` `… next_attempt_at INTEGER;` |
| 15 | `growth-log` / `growth-log-migration.ts` | `CREATE TABLE own_counts (at INTEGER PRIMARY KEY, followers INTEGER NOT NULL, following INTEGER NOT NULL);` `CREATE TABLE follower_changes (id INTEGER PRIMARY KEY AUTOINCREMENT, account_pk TEXT NOT NULL, delta INTEGER NOT NULL, lo INTEGER NOT NULL, hi INTEGER NOT NULL, source TEXT NOT NULL, found_at INTEGER NOT NULL);` `CREATE INDEX idx_follower_changes_hi ON follower_changes(hi);` `CREATE INDEX idx_follower_changes_pk ON follower_changes(account_pk, hi);` |
| 16 | `surface-health` / `surface-tables.ts` + `surface-migration.ts` | `surface_drift` (signature PK, surface_id, endpoint, cls, path, detail, first_seen_at, last_seen_at, seen, sample, hint_pattern, witnesses, contradictions, witness_keys, state, clean_reads) + `idx_surface_drift_open(surface_id, state, last_seen_at)`; `surface_health` (day, surface_id, endpoint, canonical, normalized, recovered, failed, walls, row_issues, field_issues, shadow_disagreed, last_read_at, last_ok_at, last_fail_at; PK (day, surface_id, endpoint)) |
| 17 | `feed-indexes` / `feed-index-migration.ts` | `CREATE INDEX IF NOT EXISTS idx_edges_dst_status_first_seen ON edges(dst_pk, type, status, first_seen_at);` `CREATE INDEX IF NOT EXISTS idx_effect_state_settled ON effect_intents(state, settled_at);` |

Upgrade proof: `withLegacyDb(13)` → migrate → `assertSchema` passes → zero-filled funnels include `kept`. Rollback across
these migrations is the standard future-version refusal (ADR 0502). Index creation cost scales with `edges` and runs
behind the splash (a long run reveals skeletons at `revealBy`).

### 16.2 Vocabulary (TypeScript; TEXT columns, no SQL change)

`FollowState` + `'kept'` (`FOLLOW_STATES` appended); `Target['status']` + `'retired'` (an older build reads it as
inactive, harmless); `EffectResult` + `'expired'` (counted by `additionalCountSince`); `EdgeType` + `'requests'` (every
existing query filters `type = 'follows'`).

### 16.3 Meta keys

| Key | Owner | Notes |
|---|---|---|
| `plan_state` (new) | `PlanService` | `PlanStateV1 {v:1, phaseOffsetHours, plan, boost, upgradeProbation}`; validated parse (the `reentry.ts:49-68` pattern, no zod for own writes); corrupt → deterministic repair + warn (the phase is install-seeded, so repair re-derives the same current window); a valid Boost window survives repair and its overlay is re-applied |
| `pacing_state` (legacy) | read once by `PlanService` | `phaseOffsetHours` migrated, then set to null; a downgraded build finds none and starts its planner fresh |
| `reopen_state` (new) | `FrontierSweep` | `ReopenState {v:1, feed, head, requests, following, lastSweep, lastCatchUp}`; corrupt → `logger.error` + treated as absent (a first-run sweep, no fabricated gains; the head step initializes with one page) |
| `lifecycle_state` (legacy) | read once by the reopen wiring | seeds `reopen_state.lastSweep.endedAt`, then cleared; never a v1/v2 union parse |
| `follower_changes_backfilled_at` (new) | `GrowthRepo.ensureBackfilled` | set-once: deterministic TS backfill (every own-follower edge with `first_seen_at > baseline` → `+1 [first_seen_at, first_seen_at]`; removed ones also `−1`) so every chart is identical at migration (law L8) |
| `surface_meter` (new) | surface sink | `{v:1, samples}` bounded by the reservoir |
| `read_budget_state` | `ReadBudget` | stays v1; `use` is an extra optional field; accounting by plan-day plus the trailing-24 h backstop (debits are kept ≥ 24 h, as today); downgrade-safe |
| `action_delay_deadline_at` | `MutationCadence` | same meaning; a legacy-drawn deadline in flight is honoured once (≤ 9.1 min) |

### 16.4 Settings files

`epo-settings-v2.json` (+ `.bak`, `.corrupt-<epoch>.json` quarantine, the never-deleted `epo-settings-v2.created`
marker) written by `SettingsService` only; v1 `epo-settings.json` never written again; migration per §6.10.
**Downgrade**: an older build reads the untouched v1 file (lists as of migration, never empty); changes made there are
offered back as a union-only import. Deleting `epo-settings-v2.json` **no longer re-migrates silently**: with any
evidence of a previous v2 the service restores `.bak` or re-migrates with `needs-review` (§6.6); a deliberate
re-migration is the explicit "Start over from the older version's settings" action (documented in HANDOFF). An older
build restores its own defaults for the deleted keys, including the 3–7 min floor (safe direction); stated on the
release card.

### 16.5 Corpus

`tests/fixtures/surface/2026-08-12/bodies/*` re-scrubbed (DOM untouched); `tests/fixtures/surface/2026-11-02/**` new
(scrubbed through the production router; leak test green before commit). Raw captures stay outside the repo
(`docs/adapter/fixtures/` is git-ignored; the 2026-11-02 bodies live in the probe output directory and are read in place).

---

## 17. The constants disposition table (nothing left hardcoded)

Every behavioural constant in the U01 / U02 / U03 inventories, with its fate. **Legend:**
**PLAN** derived from the DayPlan or a session tempo spec · **FUND** kernel fundamental (tier 0, an input) · **DIAL**
policy dial (tier 1) · **BOUND** guardrail in a kernel tier-1 module with a guard line · **D4/D5** technical deadline,
poll or statistical threshold derived from latency seeds or ordinary rates (never plan-derived) · **GEOM** geometry,
protocol, numeric grid or unit · **OVR** named override with a reason · **SET** user intent / Advanced override (§6) ·
**UI** renderer presentation (`motion-scale.ts`, pinned to perception) · **DEL** deleted · **HARN** dev harness.
"Stream" names who lands the change (workplan codes: F, PC plan-core, PR plan-runtime, SC settings-core, SU
settings-ui, UD unfollow-decisions, RO reopen, PP parse-pipeline, PH parse-health, CF confirm, BL boot, LD live-data, TK tokens,
SH shell, SB sidebar; PR's commits are S1, S2, S2b, S2r). The enforcement is `tests/tooling/no-static-timing.test.ts`
(§20.4, all of `src` except the kernel and the renderer): after Phase I its allow-list holds only GEOM and harness
entries, each with a reason.

### 17.1 `src/kernel/fundamentals.ts` — `EMPIRICAL` (all stay FUND: inputs, never scaled)

| Constant | Value | Fate / consumer after |
|---|---|---|
| `FOLLOW_WALL_PER_HOUR.low / .typical` | 30 / 60 per h | FUND; `.typical` → D1 hourly caps; `.low` gains a law (`ENVELOPE.hourlyCap.max ≤ low`) |
| `FOLLOW_WALL_PER_DAY.low / .typical` | 100 / 150 per day | FUND; `.typical` → D1 daily plan; `.low` → `shareOfLowWall` (safety meter) |
| `UNFOLLOW_WALL_PER_HOUR.low / .typical` | 30 / 60 per h | FUND; **gains its consumer** `PlanIntent.unfollowHourlyCap` (law L3) |
| `SOFT_WALL_DURATION_H.p50 / .p90` | 3 h / 24 h | FUND; D3 ladder, cool-down, exhausted re-verify (unchanged) |
| `HUMAN_SESSION_BOUNDARY_MS` | 30 min | FUND; session separation, `check.spacing` prior and floor, `CAP_MAX`, feed group window (name kept: golden-pinned) |
| `HUMAN_GAP.medianMs / .sigma` | 95 s / 0.75 | FUND; the gap reference shape |
| `HUMAN_SESSIONS_PER_DAY.min/max` | 2..9 | FUND; rhythm windows |
| `HUMAN_DAY_VOLUME_CV` | 0.28 | FUND; volume σ |
| `HUMAN_REST_DAY_RATE` | 0.08 | FUND; rest-day probability |
| `HUMAN_BURST.alpha / .tauMs` | 0.35 / 90 s | FUND; Hawkes excitation (τ scales with the session's time-scale) |
| `HUMAN_CIRCADIAN.{bumps, overnightFloor, dayOfWeek, weekendShiftHours}` | — | FUND; λ(t), the plan-day boundary, session placement, derived quiet hours |
| `LATENCY.{hydration, mutation, nav, control, evaluate, resourceRead, fetchEnvelope, notifications, acceptRow, probe}` | p50/p95/p99 seeds | FUND; D4 deadlines (p99 × slack), polls (p50/4), **and** tempo floors (p50) — one source; `SurfaceMeter` persisted for wave-B re-estimation |
| `ORDINARY_FAIL_RATE / BLOCK_RATE / DRIFT_SIGNAL_RATE / DUPLICATE_PAGE_RATE` | 0.30 / 0.10 / 0.02 / 0.10 | FUND; D5 breakers, `retryLimit()`, census pages |
| `DISPLAY.frameMs / perceptionMs` | 16.7 / 100 ms | FUND; push throttle, canary window, `BOOT`, `motion-scale.ts` pin |

### 17.2 `src/kernel/policy.ts`

| Constant | Fate |
|---|---|
| `POLICY.SAFETY_MARGIN` 0.37, `DESYNC_WIDTH_MS` 40 min, `BURST_TOLERANCE` 3.7, `TIMEOUT_SLACK` 1.5, `CONFIDENCE` 0.9, `LADDER_START_FRACTION/GROWTH/COVERS`, `CENSUS_ABSENCE_COVERAGE` 0.98, `DRAW_CENTRAL_Z/DRAW_TAIL_Z`, `CEILING_HEADROOM` 1.3, `PLAN_BUFFER` 1.2, `GAP_CAP_FRACTION` 0.27, `BAND_HALF_WIDTH` 0.286, `PRIOR_SYSTEMIC.{cold, afterHold, signalled}` | DIAL (inputs) |
| `POLICY.BACKOFF_BAND` [0.5, 2] | **DEL** (unused; duplicates `NOISE.BACKOFF_*`) — PR (S2r) |
| `SCALES.{caution, activity, rhythm, consistency, restDay, sessionsWindow}` | DIAL (knob → plan mapping) |
| `PREFERENCES.cleanup` off/.25/.5/.7 | DIAL; used as **share of room** (`cleanupShare`); `deep` retired from the intent vocabulary (it equalled `steady` under the 0.5 bound) |
| `PREFERENCES.patience`, day shapes, `NIGHTOWL_OVERNIGHT_FLOOR`, week shapes | DIAL (vocabulary) |
| `BOUNDS.ENGINE.IDLE_MS` 30 s | BOUND (staleness bound) + the `beat.transient` prior (pace-up); idle waits become parks until known future events (PR) |
| `BOUNDS.ENGINE.ENRICH_BACKOFF_MS` 10 min | the `backoff.walled` prior (PLAN, **pace-up**: never shorter; clipped to the session window) — PR |
| `BOUNDS.PRUNE.DELAY_FACTOR` 1/3 | **DEL** (RETIRED) — PR (S2r) |
| `BOUNDS.PRUNE.PARK_MS` 30 s | the `park.blocked` prior (PLAN, pace-up) — PR |
| `BOUNDS.PRUNE.SCAN_FRESH_MS` 4 d | **DEL** → the plan's census freshness rule (§5.8.3) — PR (S2r; its consumer `prune-engine.ts:113,292` goes first) |
| `BOUNDS.PRUNE.PARK_TIMEOUT_MS` 90 s | BOUND (growth → prune hand-off) |
| `BOUNDS.CONNECTIVITY.PROBE_INTERVAL_MS` 20 s | BOUND (non-IG) |
| `BOUNDS.SCHEDULER.AUTO_PRUNE_CHECK_MS` 30 min | **DEL** (bulk schedule retired, C14) — PR (S2r) |
| `BOUNDS.SCHEDULER.USERNAME_RESOLVE_ATTEMPTS` 4 | BOUND (identity strategies; off the boot path) |
| `BOUNDS.SCHEDULER.USERNAME_REBUILD_BACKOFF_MS` 5 min | **DEL** (the degraded retry leaves `ensureBuilt`; `confirm-account` instead): BL removes the consumer, PR S2r retires the key |
| `BOUNDS.ADAPTER.{IDENTITY_ATTEMPTS, NAV_SETTLE_ROUNDS, PROFILE_LAND_ATTEMPTS}` | BOUND |
| `BOUNDS.TAB.TEARDOWN_ENGINE_WAIT_MS` 15 s | BOUND |
| `BOUNDS.RECOVERY.{TAB_EVENT_DEBOUNCE_MS, HEAL_MAX_RECORDS, HEAL_GRACE_MS}` | BOUND |
| `BOUNDS.RIM.SCROLL_WAIT_MS` 2 s | the `scroll.wait.dialog` prior (PLAN) — F |
| `BOUNDS.RIM.FETCH_ALL_MAX_ROUNDS / FETCH_ALL_NO_NEW_STOP` 400 / 5 | BOUND (runaway) |
| `BOUNDS.RIM.ACQUIRE_MAX_ROUNDS` 5 | **DEL** (dead; RETIRED) — PR (S2r) |
| `BOUNDS.RIM.ACQUIRE_NO_NEW_STOP` 2 | BOUND |
| `BOUNDS.RIM.LIST_WALK_MAX_PAGES` 200 | BOUND (runaway for acquisition and unknown header); the census uses header-relative pages (§5.8) — PC/RO |
| `BOUNDS.RIM.REQUEST_ACCEPT_CAP` 20 | BOUND (runaway); per pass = `acceptsAllowed` (PLAN) — PR |
| `BOUNDS.RIM.NOTIFICATIONS_SCROLL_ROUNDS` 2 | BOUND (runaway); depth = the watermark (§9.4) — RO |
| `BOUNDS.NOISE.BACKOFF_MIN/MAX_FACTOR` 0.5 / 2 | BOUND (retry-backoff clamp) |
| `BOUNDS.NOISE.CADENCE_MIN/MAX_FACTOR` 0.5 / 2 and the derived `NOISE.CADENCE_SIGMA` | **DEL** with the persisted sweep factor — PR (S2r, after RO-b replaces `schedule-manager.ts:121`; the frozen v1 rules keep literal copies with a reason) |
| `NOISE.DAILY_BOUNDARY_JITTER_MAX_MS` (= DESYNC) and the `'daily-boundary'` wait class, `jitterBoundary` | **DEL** (its three users become exact parks or are deleted) — PR (S2r) |
| `BOUNDS.NOISE.BEAT_MIN/MAX_FACTOR` 0.7 / 1.45 | BOUND; also the tempo `pace` band |
| `BOUNDS.NOISE.LIST_WALK_REST_EVERY_MIN/MAX` 5 / 10 pages | the `walk.rest-every` prior (PLAN, depth axis) — F (identity) / PR (live) |
| `BOUNDS.NOISE.PRUNE_LAUNCH_JITTER_MAX_MS` (= DESYNC/2) | **DEL** (bulk schedule retired) — PR (S2r) |
| `BOUNDS.POLL.KEEPALIVE_MS` 10 s | BOUND (renderer keep-alive pull) |
| `BOUNDS.CIRCADIAN.PHASE_JITTER_MAX_HOURS` 1.5 | BOUND; the phase draw becomes seeded `u('phase')` (PLAN) — PC |
| `BOUNDS.PATTERN.REST_DAY_MAX_FRACTION` 0.15 | BOUND (plan shape) |
| `BOUNDS.PATTERN.CYCLE_PLAN_{MIN_FRACTION, MAX_FRACTION, MIN_CAP}` | **kept, re-roled**: the automatic-day band of the day law (§5.4; values unchanged; doc comments say "plan-day") — PC |
| `BOUNDS.PATTERN.MAX_UNFOLLOW_FRACTION_PER_SESSION` 0.5 | BOUND `u_max` (0 inside Boost) |
| `BOUNDS.UPDATER.CHECK_INTERVAL_MS` 6 h | BOUND |
| `PACING_BASE_MS.{read, acquireScroll, listWalkPage, listWalkRest, notificationsClose, notificationsScroll, acceptPace}` | priors reached **only** through `resolve()`: `dwell.before-press`, `scroll.wait.acquire`, `walk.page`, `walk.rest`, `drawer.close-settle`/`ui.step-pause`, `scroll.wait.drawer`, `gap.accept` (PLAN) |
| `PACING_BASE_MS.resumeSettle` | the `pause.wake-settle` prior (PLAN, pace) |

### 17.3 `src/kernel/derive.ts` unnamed literals and `src/kernel/overrides.ts`

| Constant | Fate |
|---|---|
| precision guard (12 digits), band grid 50 ms, gap median/floor/cap grids (5 s / 1 s / 1 min), ladder grid 5 min / search 32, σ grids 0.05, timeout/retry grids 1 s / 100 ms, session-mass resolution 24×12, feasibility comparator, clamp steps | GEOM (numeric grids) |
| 10–90 z `1.2816` | named `POLICY`-adjacent constant `DRAW_DECILE_Z` (shared with `SETTINGS_POLICY.TYPICAL_DAY_Z`) — PR |
| poll divisor `4` and band `[100, 1000] ms` | named D4 bounds (`POLL_FRACTION_OF_P50`, `POLL_MIN_MS`, `POLL_MAX_MS`) — PR |
| watchdog check `/8`, canary window `×30`, exhausted re-verify `×2`, push throttle `×3` | named derivation factors with guard lines (values unchanged; golden unaffected) — PR |
| prune launch jitter `DESYNC/2` | **DEL** (C14) — PR |
| `OVERRIDES` `ENGINE.REFILL_PACING_MIN/MAX_MS` 2 000/5 000 | **DEL** after the activity-clock slice removes their consumer (RETIRED) — PR (S2r) |
| `OVERRIDES` `RIM.ACQUIRE_SCROLL_*`, `RIM.LIST_WALK_PAGE_*`, `RIM.LIST_WALK_REST_*`, `RIM.NOTIFICATIONS_CLOSE_DELAY_*`, `RIM.NOTIFICATIONS_SCROLL_WAIT_*`, `RIM.ACCEPT_PACE_*` | OVR kept as the **priors** of their tempo specs (identity at tempo 1) |
| `OVERRIDES` `RECOVERY.RESUME_SETTLE_MIN/MAX_MS` 3 000/10 000 | OVR kept as the **prior** of `pause.wake-settle` (identity at tempo 1) |
| `OVERRIDES` `ADAPTER.IDENTITY_RETRY_MS` 1 200 | OVR kept (harness default) |
| `OVERRIDES` `CAUTION.cautious.floorSeconds` 60 (derived 70, unsafe direction) | entry removed so the derived **70** applies, in its own commit after the `CHANGED` ledger lands (grid point and persona recorded there; owner Q11 default; ADR 0606 §4); the migration compares against the frozen `V1_DERIVED`, so no install gets a spurious override — PR (S2r) |
| `OVERRIDES` `CAUTION.bold.floorSeconds` 35 (derived 33, safe) | OVR kept |
| `OVERRIDES` `RECOVERY.HOLD_MEDIANS_MS.2` 120 min | OVR kept |
| `OVERRIDES` `ENGINE.ACTIONS_FAILING_HALT` (advisory 8 vs derived 7) | **applied derivation** `coldFailingThreshold()` = 7 (owner Q11 default); advisory entry removed — PR |
| `OVERRIDES` `RECOVERY.PRUNE_COOLDOWN_AFTER_RATE_HALT_MS` 3 h (the one deliberate change) | OVR kept; consumer moves to the plan view's cleanup admission (§5.7) — PR |
| **new** `OVERRIDES` `PRUNE.CONSECUTIVE_FAIL_HALT` 4 (derived 7) | OVR with reason "a bulk run halts sooner than the loop so a broken unfollow path cannot burn the list" — PR |

### 17.4 D6 (`src/kernel/derive-reads.ts`, `src/settings/read-allowance.ts`)

| Quantity | Fate |
|---|---|
| window: rolling 24 h | **PLAN**: the plan-day window for accounting and reset, plus a trailing-24 h backstop equal to the totals (§3 deviation 3) — PR |
| `verify` share = ceiling | kept + `verifyReserve = M` (non-verify debits capped) — PR |
| `reconcile` share `⌈ceiling × 1.3⌉` | kept (D6 ceiling); plan bucket = journal + protected re-eval + verify |
| `exploration` share | identity at the reference; the plan's explore sub-limit carries Boost within the non-verify room |
| `listPages = 200 + slices × 3` | `explorationPages + censusPagesMax + frontierPages` (header-relative census bounded by `CENSUS_POLICY.maxWalkPages`; frontier term `(1 + sessionsPerDayMax) × FRONTIER_PAGES_MAX`) — PC/PR |
| `notifications = ⌈24/sweepHours⌉ + sessionsMax` | `sessionsPerDayMax + ⌈M · targetMean(BEAT_MAX)/checkSpacingMin⌉ + 1`, `checkSpacingMin` = the slower of the derived minimum and the override — PC/PR |
| inputs (static Settings) | `ReadDemand` gains `checksPerDayMax`, `censusPagesMax`, `frontierPages`; read live on every check |

### 17.5 `MOTION` (`src/kernel/motion-policy.ts`, 61 keys) and the inline interaction literals

| Keys | Role | Fate |
|---|---|---|
| `travelBaseMs` 100, `travelScaleMs` 150, `moveMinMs` 120, `moveMaxMs` 1 400 | tempo | `motion.travel` (motion axis; per gesture) — F (identity) / PR (live tempo) |
| `pressMs` [40, 120], `pressMedianMs` 70, `pressSigma` 0.24 | tempo | `motion.press` |
| `hoverSettleMs` [250, 600] | tempo (floor measured) | `motion.hover-settle`; floor 250 ms = the measured ~200 ms transition |
| `profileDwellMedianMs` 9 000, `profileDwellSigma` 0.45, `profileDwellMs` [5 000, 30 000] | tempo (pace axis) | `dwell.visit`; floor 5 s (prior-min) |
| `wheelPauseMs` [30, 90] | tempo | `wheel.tick-pause` |
| `wheelMicroPauseProbability` 0.12, `wheelMicroPauseMs` [180, 450] | tempo | `wheel.micro-pause` |
| `wheelCorrectionPauseMs` [120, 300] | tempo | `wheel.correction-pause` |
| **new** `prePressMs` [30, 120] (from `interactor.ts:112`) | tempo | `motion.pre-press` — F |
| `overshootProbability`, `overshootFraction`, `targetSigmaFraction`, `wheelOvershootProbability`, `wheelOvershootFraction` | **speed-accuracy** (r2) | PLAN: co-vary with the gesture's `motion` factor, `x·m^(−SPEED_ACCURACY_ELASTICITY)`, clamped by the guardrails (§5.11); law: monotone non-increasing in `m`, within guardrails — F (identity) / PR (live) |
| `gravity`, `windGravityRatio`, `windMemory`, `momentum`, `maxStepPx`, `dampingRadiusPx`, `brakingScale`, `speedMemory`, `speedVariation`, `cadenceMemory`, `cadenceSigma`, `travelSigma`, `wheelDistanceFactor`, `wheelRampFraction`, `wheelSigma`, `wheelCorrectionFraction`, `wheelCorrectionMaxTicks` | shape | **POLICY dials** (`MOTION_ROLE 'shape'`, a guard line and provenance each in `motion-roles.ts`, listed in Under the hood; §3 deviation 4, owner Q42); law: identical at every tempo |
| **new** `driftProbability` 0.15, `driftPx` 3 (from `interactor.ts:166-169`) | shape | moved literals (POLICY dials) — F |
| **new** `initialCursorXPx` [180, 720], `initialCursorYPx` [160, 560] (from `interactor.ts:49-50`) | device | GEOM, absolute (drawn in the synchronous constructor before `viewport()` exists; a viewport-relative version is a later PR commit with its own re-baseline) — F |
| `maxDistancePx`, `maxIntegrationSteps`, `arrivalPx`, `referenceDistancePx`, `distanceScale`, `corridorFraction`, `corridorMinPx`, `overshootMinDistancePx`, `overshootMaxPx`, `overshootTargetFraction`, `peakSpeedPxPerSecond`, `minEventDelayMs`, `cadenceWeightFloor`, `travelBoundaryInsetFactor`, `travelRejectionAttempts`, `minTargetWidthPx`, `targetMarginFraction`, `targetMarginMaxFraction`, `targetRejectionAttempts`, `wheelOvershootMinTicks`, `wheelRampFloor`, `wheelWeightFloor` | guardrail | BOUND (`MOTION_ROLE 'guardrail'`) |
| `wheelAverageTickPx` [60, 130], `peakSpeedFactor` [0.82, 1] | device | GEOM now; optional per-install sub-ranges later (non-goal) |
| `motion-profile.ts` re-exported module constants (`PRESS_MIN_MS` … `MOVE_MAX_MS`) | — | **DEL** (frozen at import; consumers read `MotionPolicy` resolved per gesture) — F |
| `interactor.ts:58` `targetWidthPx = 32` (dev probe `moveTo`) | — | GEOM (allow-listed with reason: dev-only) |
| `interactor.ts:134` `timeoutMs: 0` (diagnostic field), `motion-profile.ts` aim-margin floor 1 px, bell shape, `1_000` ms/s, `motion-random.ts` EPSILON, `input-driver.ts`/`cdp-input.ts` protocol values (`clickCount`, `buttons`, delta sign) | — | GEOM |

### 17.6 `EXPLORATION_POLICY`, `RENDERER_HEALTH`, `src/timing/*`

| Constant | Fate |
|---|---|
| `maxSources` 5, `pagesPerSlice` 2, `rowsPerSlice` 100, `sourceOpenReads` 1, `emptySlicesBeforeDefer` 2, `sourceShare` 0.4, `shareWindow` 100 | BOUND |
| `followsPerVisit` 20, `profilesPerSlice` 20, `queuedPerSource` 10 | BOUND; real slice/visit sizes = `min(bound, session explore left)` (PLAN) — PR |
| `explorationFraction` 0.2, `priorRate` 0.15, `priorWeight` 20 | DIAL |
| `lowYieldRevisitMs` 1 d, `endedRevisitMs` / `profileFreshMs` / `enrichmentRetryMs` 7 d | **PLAN** (r2; they decide when Epo visits profiles and sources again, so they are Instagram-facing): low-yield revisit = the next plan-day start; the 7 d windows = `planDayStartAfter(WEEKLY_CYCLE)` (7 plan-days, the period of `HUMAN_CIRCADIAN.dayOfWeek`) — PR (consumers), F (`WEEKLY_CYCLE`) |
| `outcomeWindowMs` 4 d | default only; live = `waitDays × MS_PER_DAY` |
| **new** `ownFollowersPickMax` 15 (was `PICK_ENRICH_CAP`), `skipPoolFactor` 4 (was `ACQUIRE_SKIP_POOL_FACTOR`), `maxCoverageFraction` 0.5 (was `ACQUISITION_DEFAULTS`, `follower-acquisition.ts:81-91`), `maxEnrichPassesPerCycle` 1, source-utility literals (`< 2` candidates, unknown overlap 0.5, overlap weight 0.5, share penalty 0.1, `≥ 3` sources), frontier refill `< 3` live sources, `MAX_DISCOVERED` 5 / discovery weights (`src/rim/target-discovery.ts:26`) | BOUND (`EXPLORATION_POLICY` entries with guard lines, added with today's values in F2a); consumers switched by PR (acquisition, enricher, own-followers source) and SC (`source-frontier.ts`, `chain-controller.ts`, `src/rim/target-discovery.ts`) |
| `RENDERER_HEALTH.minAnimationFps` 10, `backstopWindowFactor` 4 | BOUND |
| `session-planner.ts` midnight tail 20 min, budget jitter U(0.6, 1.4), intensity probe floor/grid/attempts, `sessionEndsAt` estimate | **DEL** (file deleted; §5.4) — PR |
| rolling 1 h window | GEOM (definitional hour window) |
| `circadian.ts` Lewis thinning (unused), `samplePhaseOffset`, `sampleNextSessionStart` | **DEL**; `intensityAt` moves to `kernel/plan/circadian.ts` (re-exported) — PC |
| `distributions.ts` clamp re-draws 4 | BOUND (numerics) |
| `distributions.ts` weibull / pareto / logNormalMixture (unused) | **DEL** — PC |
| `noise.ts` daily-boundary offset 1 ms–40 min | **DEL** (ceiling/read-budget parks become exact) — PR (S2r) |
| `page-pacing.ts` `pauseBeforePageRetry` (sub-cadence band, `?? Math.random`) | `pause.retry` (PLAN) — F (identity) / PR |
| `delay-manager.ts`, `schedule-manager.ts` `?? Math.random` defaults and the cadence-factor redraw | **DEL** (the rng is injected from the launch noise stream; the factor redraw retires with the sweep factor) — PR / RO |
| `noise.ts` stride clamp 0.999999 | GEOM |
| `cycle-plan.ts` (seed, band) | **DEL** — PR |
| `primitives.ts` jitter clamp ≤ 95 %, `action-gap.ts` collapsed range | **DEL** with the legacy pacer — PR |
| `HARNESS.*` (11 keys) | HARN (never derives, ADR 0605) |

### 17.7 Settings knobs (`src/settings/settings.ts`)

| Knob | Fate |
|---|---|
| `dailyHardCeiling`, `dailyOperatingRate`, `dailyPlanSize`, `dailyVolumeVariancePct`, `restDayChancePct`, `sessionsPerDayMin/Max`, `gapMedianSeconds`, `gapFloorSeconds`, `hourlyVelocityCap`, `maxUnfollowFractionPerSession`, `weaveEnabled`, `maxWaitForFollowbackDays`, `holdAfterFollowbackDays` | SET (derived from intent at read time; overridable within the envelope; the gap rows act on the effective scale, slower only (§5.10); `dailyHardCeiling` moves only the manual/outside headroom; the 40/h cap clamp falls to the envelope 30) — SC |
| `minDelayMinutes`, `maxDelayMinutes`, `jitterPercent`, `pacingModel` | **DEL** (S2, with the pacer) — PR |
| `activeHoursStart`, `activeHoursEnd` | **DEL** (S2) → quiet hours (SET) + the plan-day boundary (PLAN) — PR |
| `followbackSweepHours` | SET override `checks.everyHours` of the `check.spacing` spec — SC |
| `sweepLastRunAt`, `sweepIntervalFactor` | **DEL** (→ `reopen_state.lastSweep`; the factor retires) — SC/RO |
| `pruneDailyLimit` | SET lowering override `unfollow.cleanupPerDay` of `U_prune` — SC |
| `pruneScheduleDays`, `pruneLastRunAt` | **DEL** (bulk schedule retired; cleanup intent + census slot) — SC/PR |
| `pruneScanMinSeconds`, `pruneScanMaxSeconds` | **DEL** → `tempo.walk.page` override only when slower than the prior (a faster value is dropped with a notice) — SC |
| `lowWaterCandidates` | SET `explore.refillBelow` (≤ `queuedPerSource`); the live refill threshold is `min(queuedPerSource, F_s,left)` (PLAN) |
| `maxRetries` | SET `unfollow.attempts`, recommended `retryLimit()` (3) |
| `minFollowBackRate`, `minPoolSize`, `privateBoost`, band/peak/hard curve, `minFollowers/maxFollowers` | SET (intent + overrides); `SCORER_DEFAULTS`, `CHAIN_DEFAULTS` reduced to one declaration each, reading `SETTINGS_POLICY` — SC |
| `persona` | **DEL** (migration input only) |
| `dryRun`, `autoAcceptFollowRequests`, `seed`, `pruneWhitelist`, `pruneBioFilterWords`, `tourCompletedAt` | SET (`prefs.practice`, `prefs.acceptRequests`, `seed`, `protection.*`, `app.*`) |

### 17.8 Engine, rim, adapter, governors (U02 §3.3, U03 §4)

| Constant (site) | Fate |
|---|---|
| engine wait keys `engine:active-hours-park` / `daily-ceiling-park` / `session-park` / `velocity-park` / `enrich-backoff` / `reconcile-backoff` / `read-budget-park` / `prune-park` / `blocked-park` / `idle` / `transient-backoff` / `action-delay` / `refill-pacing` / `recovery-hold`, `prune:park`, `prune:action-delay` | per §5.16: DEL / exact PLAN parks / tempo bases; `recovery-hold` D3 unchanged — PR (`reconcile-backoff` key, class and park reason DEL — UD, as its declared minimal touch on `engine-waits.ts`) |
| `ENGINE.VELOCITY_PARK_{MEDIAN_MS, SIGMA, MIN_MS, MAX_MS}` | **DEL** (RETIRED; exact window) — PR (consumer S2, key S2r) |
| `RIM.ENRICH_PACE_{MIN,MAX}_MS` | **DEL** (RETIRED) — PR (consumer `profile-enricher.ts:197` S2b, key S2r) |
| `ACTIONS_FAILING_HALT` 8 (`engine.ts:85`) | D5 `coldFailingThreshold()` = 7 — PR |
| `RECOVERY.{REENTRY_FAILS, BLOCKED_STREAK_ENTRY, WALLED_CYCLES_ENTRY}` | D5 (kept) |
| drift `≥ 2 && attempt ≥ 1` (`recovery.ts:154`) | D5 `driftConfirmThreshold()` — PR |
| `RECOVERY.HOLD_*`, `MAX_HOLDS`, `EXHAUSTED_REVERIFY_WINDOW_MS`, `RECOVERY_LADDER` | D3 (kept) |
| `CHURN_DEFAULTS`, `FOLLOWBACK_DEFAULTS`, `SCANNER_DEFAULTS`, `minPoolSize` fallback 300, max-wait fallback `4 × MS_PER_DAY`, `relationshipFreshMs ?? MS_PER_DAY` | **DEL** (tests use `tests/kit/configs.ts` built from defaults) — UD (churn), RO (follow-back), SC (`scanner.ts`) |
| `CHAIN_DEFAULTS`, `SCORER_DEFAULTS` | **one declaration** each, reading `SETTINGS_POLICY` (not deleted) — SC |
| consecutive cleanup `< 2` (`churn-scheduler.ts:219`) | **DEL** (plan mix) — PR |
| retry/abandon `maxRetries` | `retryLimit()` / SET |
| `RELATIONSHIP_FRESH_MS` 1 d | **DEL** (verify-at-act) — RO |
| interrupted retry `now + 30 000` | `beat.transient` (PLAN) — RO |
| pending-requests retry `now + 3 min` | **DEL** (requester predicate) — RO |
| census coverage `0.98` duplicate (`followback-watcher.ts:240`) | `censusAuthority()` — RO |
| reconcile batch 10, effect-reconciliation batch 10, reconciliation halt `≥ 5`, reconcile re-defer 30 s / 10 min | **DEL** (one intent / one verdict per step; no halt) — UD/RO |
| `REENTRY_POLICY` (1 h, 1 d, 5 min, 10, 3 min) | **DEL**; tolerance → `BOUNDS.CLOCK_TOLERANCE_MS`; probation → `probationOwed` (PLAN) — RO/PC |
| `ENRICH_BATCH_SIZE` 20, `DEFAULT_BATCH_CAP` 25, `PICK_ENRICH_CAP` 15, `MAX_ENRICH_PASSES_PER_CYCLE` 1, `ACQUIRE_SKIP_POOL_FACTOR` 4 | PLAN `min(profilesPerSlice, session explore left)`; 25 **DEL**; the rest → `EXPLORATION_POLICY` — PR |
| read-deferral fallback `+ lowYieldRevisitMs` (`target-pipeline.ts:118`) | PLAN: `view.window.endsAt` — PR |
| bootstrap wait `min(30 s, resumeAt − now)`, chain-retry wait `min(30 s, retryAt − now)` | PLAN exact parks until `resumeAt` / `retryAt` — PR |
| `SCORER_DEFAULTS` (curve, followers, private, bandEdge, mutualCap, mutualWeight) | `SETTINGS_POLICY` (one declaration) — SC |
| `RuntimeHealth` 2 000 chars / `≥ 5` errors | BOUND `RUNTIME_BOUNDS` — BL |
| `EFFECT_POLICY.READ_RETRY` (declaration only; `base: 2_000, cap: 30_000` literals, `effect-policy.ts:78`) | the two literals become kernel derivations (`base` = `retryWait(timeoutFor('fetchEnvelope'), n)`, `cap` = `timeoutFor('fetchEnvelope')`), so the declaration passes the scan; it stays unconsumed until a reader is wired, and its discretionary part is then `pause.retry` — PR |
| low-water `min(5, 10)`, sweep due `sweepHours × factor`, weave probability `min(fraction, 0.5)` | PLAN (refill threshold, `checkDue`, plan mix) — PR |
| prune scan coverage `known < 50`, `0.85` | BOUND `CENSUS_POLICY` — PP |
| prune daily plan `cyclePlan(50)`, `pruneDue`, `msUntilActiveWindow` | **DEL** — PR |
| `PRUNE_CONSECUTIVE_FAIL_HALT` 4 / `BLOCK_HALT` 3 / `PROGRESS_EMIT_MS` 250 | OVR 4 / D5 `blockedStreakThreshold()` / `POLL.GRAPH_PUSH_THROTTLE_MS` — PR |
| `unenrichedUsernames` windows 7 d | PLAN: `planDayStartAfter(WEEKLY_CYCLE)` (window via the store method's argument, never a store import) — RO |
| list-walk fetch retry (1 retry; backoff = rest band) | BOUND `RIM.LIST_WALK_FETCH_RETRIES` = 1 + `pause.retry` (PLAN) — PP |
| list-walk rest stride (5–10 pages, `NOISE.LIST_WALK_REST_EVERY_*`) | `walk.rest-every` (PLAN, depth) — F (identity) |
| `ACQUISITION_DEFAULTS` (`targetNewPks` 100, `maxPages` 2, `maxRounds` 2, `noNewStop` 2, scroll band) | BOUND (`EXPLORATION_POLICY`) + `scroll.wait.acquire` (PLAN) — PR |
| `MIN_SCROLL_STEP_PX` 600 (`actor.ts:50`) | BOUND `tempo-policy.ts` — F |
| drawer / dialog scroll `clientHeight × 2 / × 3` | PLAN `scroll.depth.drawer` / `.dialog` — F |
| `actor.ts:347` open-list-dialog attempts `< 2` | BOUND `ADAPTER.OPEN_LIST_ATTEMPTS` — CF |
| rect thresholds `≥ 2 px` (`actor.ts:704`, `identity.ts:62-64`, `page/dom.ts:85-91`), `AIM_GRID` 8, safe-point probe grid, confirm/drawer locate config (`maxChildren` 3, `maxTextLen` 40, `maxDepth` 8), CDP version `'1.3'` | GEOM (surface/protocol facts) |
| **new** `maxConfirmLayers` 2 | GEOM-surface fact in `versions/*` (`SURFACE.maxConfirmLayers`) — CF |
| `tab.ts:351-352` `probeInput` 10 × 50 ms | D4 derived from `DISPLAY.frameMs` (`INPUT_PROBE.ROUNDS`, `INPUT_PROBE.INTERVAL_MS = 3 × frame` in a new kernel module, **not** registry keys — the golden pins the registry), re-exported by `@/timing/config` so `tab.ts:27` becomes `import { INPUT_PROBE, RECOVERY, TAB } from '@/timing/config'` — **line-neutral** (`tab.ts` is at its 646 ceiling; ADR 1007 amendment) — F |
| `tab.ts:113` input-ACK deadline = evaluate seed | D4 (borrowed seed, documented; no new empirical without measurement) |
| `ADAPTER.{POLL_INTERVAL_MS, POLL_TIMEOUT_MS, MUTATION_RESPONSE_TIMEOUT_MS, NAV_SETTLE_MS, PROFILE_LAND_RETRY_MS}`, `TAB.{GOTO, EVALUATE, GET_BODY, FETCH_ABORT}`, `RECOVERY.CANARY_WINDOW_MS`, `RIM.{NOTIFICATIONS_WAIT_MS, NOTIFICATIONS_POLL_MS, ACCEPT_VERIFY_MS, ACCEPT_VERIFY_POLL_MS, LIST_WALK_STAGNANT_STOP}` | D4 / D5 (never plan-derived; law: identical at every tempo) |
| `versions/2026-08-12.ts:86` inlined `AbortSignal.timeout(20000)` | D4 parameter `abortMs` from `TAB.FETCH_ABORT_MS` — PP |
| `UNMATCHED_POSTS_KEPT` 12 (`mutation-watch.ts:50`), `MUTATION_BLIND_STREAK` | BOUND `SURFACE_BOUNDS.unmatchedPostsKept` / D5 — PP |
| `identity.ts` retries (harness defaults; production `SCHEDULER.*`) | BOUND |
| `renderer-canary.ts` backstop, fps verdict | BOUND (`RENDERER_HEALTH`) |
| governor cycle boundary 08:00, `plannedToday`, `atOperatingRate`, `withinActiveHours`, `nextDelayMs` | PLAN boundary / plan volume / **DEL** — PR |
| `atHardCeiling`, `actionsInLastHour` | PLAN ceiling `M` / kept (structural) |

### 17.9 Main process, store, renderer, shell (U01 §3.10, U03 §4.5–4.6)

| Constant | Fate |
|---|---|
| connectivity probe 20 s / timeout 5 s | BOUND / D4 |
| scheduled-prune watcher 30 min + launch jitter 0–20 min + active-hours gates | **DEL** (C14) — PR |
| prune rate cool-down 3 h | OVR (kept; consumer = plan view cleanup admission) — PR |
| step watchdog stale 8 min / check 1 min | D (derived from `GAP_CAP`; law L11) |
| tab-event debounce 1 min, teardown wait 15 s, manual-op drain 15 s | BOUND / BOUND / D4 |
| resume settle 3–10 s (`Math.random` today, `foundation-wiring.ts:1307-1310`) | `pause.wake-settle` (PLAN, pace; prior = the kept OVR band) — F (identity) / BL |
| probe and traffic-harness sleeps (`probe/verify.ts:32`, `probe/traffic.ts:26`, `probe/probe-main.ts:188`), `epo_nx_` name via `Math.random` | harness: the probe's reference `TempoSource` draws and the entropy root; allow-listed as harness — PP |
| profile landing 20 attempts × 1.5 s, 15 × 300 ms settle, **2** click attempts | BOUND + D4; the `2` becomes `ADAPTER.PROFILE_LAND_CLICK_ATTEMPTS` — BL |
| username resolve 4 × 1.5 s | BOUND + D4 (off the boot path) |
| new follow-back hold `× 86_400_000`, outcome window `× 86_400_000` | GEOM unit → `MS_PER_DAY` — RO |
| graph push throttle 300 ms | D (derived from perception) |
| runtime repair budget 3 per 60 min / 50 incidents (`runtime-coordinator.ts:6-7,60,185`) | BOUND `RUNTIME_BOUNDS` (`src/kernel/runtime-bounds.ts`) — BL |
| dashboard recovery 30 s load / 3 reloads per 10 min / `n × 1 s` (`dashboard-recovery.ts:24,37-45`) | BOUND `RUNTIME_BOUNDS` — BL |
| runtime log 2 MiB / 2 000 chars / 256 KiB pending / 1 s flush (`runtime-log.ts`) | BOUND `RUNTIME_BOUNDS` — BL |
| startup failure 15 s / 2 s (`startup-failure.ts:25-26`) | BOUND `RUNTIME_BOUNDS` — BL |
| `QUEUE_ROW_CAP` 100, `RUNWAY_RATE_WINDOW_DAYS` 7 (`foundation-reads.ts`) | BOUND; the runway fallback pace = the plan's volume (PLAN) — PR |
| `ORIGIN_SETTLE_MS` 2 s (`bootstrap.ts:22`) | BOUND `RUNTIME_BOUNDS.ORIGIN_SETTLE_MS` (one import line in `bootstrap.ts`; argued under the ADR 1007 amendment) — BL |
| `growthSeries` default 14 days | UI bound (`motion-scale.ts` sibling `CHART_DEFAULT_DAYS`) — SH |
| updater 6 h | BOUND |
| shell geometry 460 / 44, veil fade 400 ms / 16 ms, shell 500 ms | `SHELL_GEOMETRY` (BOUND) — TK; veil fade → `BOOT`-derived (`4 × perception`, frame) — BL |
| Chronos (no constants) | unchanged (no consumer) |
| `RING_ROWS` 50 000, span internals 32 / 512 / 100 (`spans.ts`) | BOUND `STORE_POLICY` (kernel), **injected** into the store (C24) — F |
| observation/username retention 90 d, settled-intent retention 90 d (two spellings) | one BOUND `STORE_POLICY.RETENTION_MS`, injected — F |
| `FIRST_CENSUS_STOCK_WINDOW_MS` 1 d (`census.ts:23`) | PLAN: one plan-day (injected window) — RO |
| `SOURCE_CONFIDENCE` 40/60/80/90/100 (`store/types.ts:4-7`) | GEOM (an ordinal merge-precedence table, not a quantity; allow-listed with reason) |
| `src/renderer/lib/settings-derive.ts` (×1.3, ×1.1, caps 150/120), `strategy-presets.ts` | **DEL** (dead or duplicate limit math; numbers come from main) — SU |
| `charts/growth-model.ts`, `growth-overlay.ts` projection constants | **DEL** (measured data only) — SH |
| `live-status-copy.ts` "3 long backoffs (~4h)" and other literal durations in copy | **DEL** (copy numbers come from projections; law L-COPY) — SB |
| `useSettingsDraft` `AUTOSAVE_MS` 600, `useTourGate` 900 ms | **DEL** (no debounce; the tour keys on the reveal) — SU/SB |
| renderer animation durations, splash dwell, caption delays | UI (`motion-scale.ts`, pinned to `DISPLAY.perceptionMs`) — TK/SB |
| `POLL.KEEPALIVE_MS` 10 s | BOUND |

### 17.10 New tier-1 numbers introduced by this overhaul (each with a guard line)

`TEMPO_POLICY.MOTION_ELASTICITY` 0.5 · `TEMPO_POLICY.SPEED_ACCURACY_ELASTICITY` 0.5 (r2) ·
`PLAN_POLICY.RETRY_CONFIDENCE` 0.99 · `BOUNDS.CLOCK_TOLERANCE_MS` 5 min (moved) · `BOUNDS.MIN_SCROLL_STEP_PX` 600 (moved)
· `SETTINGS_POLICY` (`QUIET_INTENSITY_FRACTION` 0.2, `QUIET_GRID_MINUTES` 30, `QUIET_MAX_HOURS` 16, `TYPICAL_DAY_Z`
1.2816, `AUDIENCE_WIDEN_FACTOR` 1.5, `AUDIENCE_SIZE`, `PRIVATE_EDGE` 0.15, `RATIO_CURVE`, `RECOMMENDED {minPoolSize 300,
lowWaterCandidates 5, mutualWeight 1.5, mutualCap 20, bandEdgeScore 0.6, minFollowBackRate =
EXPLORATION_POLICY.priorRate}`, `BOOST {DEFAULT_HOURS 12, MIN_HOURS 1, MAX_HOURS 24, CHOICES [2, 4, 8, 12, 24],
MAX_BACKLOG_DAYS 3 (r2)}`, `KEEP_RECHECK_DOUBLINGS` 3, `TEMPO_OVERRIDE_MAX_FACTOR` 3, `MAX_DAYS_OFF` 6 (r2), `INTERIM`
(until `capabilities.plan`)) · `SETTINGS_GUARDS` · `BOUNDS_REENTRY` (`MIN_ROWS_PER_PAGE` 10, `FRONTIER_PAGES_MAX` 5
(r2)) · `SURFACE_BOUNDS` (§10.9) · `CENSUS_POLICY` (moved; + `maxWalkPages` 1 000, r2) · `INPUT_PROBE` (derived, moved
from `tab.ts`) · `SHELL_GEOMETRY` (moved) · `BOOT` (+ the derived `IG_READY_DEADLINE_MS`, r2) · `LIVE`, `DIAGNOSTICS` ·
`RUNTIME_BOUNDS` · `STORE_POLICY` · the `MOTION` shape dials gain guard lines and provenance (values unchanged). Code-only
kernel additions with no numbers: `src/kernel/rng.ts` (`mulberry32`, `fnv1a`), `WEEKLY_CYCLE` (derived). Phase F creates
the module **skeletons** that several streams need first (`rng.ts`, `settings-policy.ts` with `BOOST`,
`KEEP_RECHECK_DOUBLINGS`, `TEMPO_OVERRIDE_MAX_FACTOR`, `MAX_DAYS_OFF`; `reentry-policy.ts`), then hands each to its stream.
New EMPIRICAL entries: none.

---

## 18. Decisions register and owner questions

### 18.1 Decisions by label

| Label | Decision | § |
|---|---|---|
| owner | Everything Instagram-facing derives from the daily plan; no hard-coded timings | 5 |
| owner | Sidebar is live-only; Settings is a stage tab beside Live/People/Graph/Prune, with Easy and Advanced | 6, 12 |
| owner | Protection lists protect from every automatic unfollow path, follow-back or not (reverses 2026-08-31) | 7 |
| owner | Boost default 12 h, configurable, endable, durable across restarts/offline/clock changes | 8 |
| owner | Parse through small API changes; handle the unfollow confirm pop-up; reopen reads only what changed; no stale state; friendlier UI with a launch animation | 9–13 |
| lead | Boost never raises ceilings; reallocates; never-deferred list | 8.1 |
| lead | Protected → never unfollowed; unreadable bio with keywords set → no unfollow; the record moves to `kept` without blocking the queue; plan-paced re-evaluation | 7.1, 7.5 |
| lead | The engine starts idle at launch; a passive, bounded, read-only catch-up may run (own header, drawer since the watermark, followers head until known rows) | 9.6, 12.8 |
| lead | The legacy pacer is replaced by the DayPlan in the same change that removes it | 5.13 |
| lead (refined by arch) | Per-record verification runs after Start, plan-paced — exactly once, at the click (verify-at-act) | 9.7, C9 |
| arch | All of §14 C1–C28; status contributor registry; migrations 14–17 in Phase F; per-topic IPC tables; the `ClickVerdict` union; the quiet-hours boundary rule; `TEMPO_OVERRIDE_MAX_FACTOR` 3 | 14 |
| arch r2 | The day law keeps today's realized law and its maximum (`automaticDayMax`); `M` is manual/outside headroom only | 5.4, 5.7 |
| arch r2 | Accepts get their own budget; follows ≤ `P0` at run time; re-plans and Boost work on the kept remainder | 5.7, 8.3 |
| arch r2 | The Boost overlay ends every re-plan; Boost keys on run intent, shows `paused`, refuses on backlog, is honest when it shifts nothing | 5.4, 8 |
| arch r2 | Overrides only lengthen waits; post-wall waits are `pace-up`; three new tempo keys (`pause.retry`, `pause.wake-settle`, `walk.rest-every`); revisit windows in plan-days; speed–accuracy co-varies with motion | 5.11, 5.16, 6.2 |
| arch r2 | D6 gains a frontier term and a census bound; a trailing-24 h backstop; the census is a durable per-session predicate | 5.8 |
| arch r2 | A session-mode following check; outside actions charged upward only | 9.2, 9.10 |
| arch r2 | Lists: an `exploration` gate and C2 `source-rows` for acquisition only; mutation `errors[]` always feeds the ladder; the unconfirmed-actions breaker; no confirm press fallback | 10.5, 10.6, 11.1 |
| arch r2 | The landing and identity confirmation run behind the splash; Graph preloads eagerly | 12.4, 12.8 |
| arch r2 | Settings recovery on a refused migration keeps v1 state; v2 deletion never silently re-migrates; the migration compares against the frozen v1 derivation | 6.6, 6.10 |

### 18.2 Owner questions (each answered with the default this design adopts; the owner may overturn any)

**● = changes visible behaviour or decides whether an owner item works. Every ● question is put to the owner as one
packet in Phase F (workplan F0) and answered before Phase P starts (gate G0); the answers are recorded in this table,
and the workplan's final sign-off (I.4) only confirms them.** Unmarked questions keep their defaults unless the owner
raises them.

| # | Question | Default |
|---|---|---|
| ●Q1 | In-session pace rate-neutral at Standard (≈ 12/h, as since 10-21); caution sets density (Cautious ≈ 7.5/h, Bold ≈ 16/h)? | Yes, with upgrade probation |
| Q2 | "A day" counts follows + unfollows + approvals together; follows never exceed the activity level's follow plan? | Yes |
| ●Q3 | One plan-day boundary at the install's quiet minute (≈ 2:45 AM with derived quiet hours) for every limit and "today"; charts keep calendar days? | Yes |
| Q4 | Start between sessions parks with a countdown; Boost is the act-now control; Boost while stopped offers "Start Epo and Boost"? | Yes |
| ●Q5 | **Boost never adds volume.** It starts work now and swaps today's remaining unfollows for follows. Consequence: when there are no unfollows left to swap — cleanup off (the new-install default), the first ≈ 4 days before any follow-back wait ends, or "keep following" with cleanup off — Boost adds **zero** follows (the preview says so and Start Boost is disabled when it would change nothing at all), and over a week Boost moves follows earlier rather than adding them. **Alternative** (compatible with "never raise a ceiling"): Boost may lift today's planned actions up to the most Epo ever does automatically in a day (`automaticDayMax`, ≈ 0.97 × the daily target: at Balanced ≈ +5–10 follows on a typical day), never above it. Keep "never adds volume"? | Yes (the lead's decision: Boost reallocates, never adds) |
| Q6 | Missed sessions expire; a late open covers the rest of the day; no catch-up? | Yes |
| Q7 | Phone actions (seen as header residuals) count against today's safety limit only, never the planned kinds? | Yes |
| Q8 | Approvals: up to 5 (Standard) per check, a few seconds apart, then the normal gap? | Yes |
| ●Q9 | Delete "Steady intervals", mapping legacy users to Consistency = Even + many short visits? | Yes |
| ●Q10 | Retire the scheduled bulk cleanup; cleanup runs gradually inside sessions with Epo keeping the census fresh; "Run now" stays manual? | Yes |
| Q11 | Failure breaker 8 → derived 7; retries stay 3; derived Cautious gap floor 70 s (from 60) in its own commit? | Yes |
| Q12 | A reading pause before pressing Follow/Unfollow (≈ 2.5–4.5 s) and short pauses between drawer presses and between the steps of an unfollow confirmation? | Yes |
| ●Q13 | Settings global for the install (protection by pk); Easy pace = Gentle / Balanced / Faster (no per-hour figure in Easy) with Very light and Maximum only in Advanced; Maximum needs a one-time acknowledgement; overrides never exceed the most permissive preset and timing overrides can only slow Epo down? | Yes |
| ●Q14 | Quiet hours derived from the day shape and on by default (≈ 23:30–06:00 for "Through the day"); day-off chips in Easy (at most 6)? | Yes |
| Q15 | When someone follows back: keep today's rotation (unfollow after the hold) as the default? | Yes |
| ●Q16 | Cleaning up people you followed yourself: off for new installs; on for existing installs only if an auto-prune schedule was on (mapped to "a few a day" unless woven cleanup was already set higher) — so an install without a schedule loses its woven cleanup until the owner turns it on; a manual scan never starts unfollowing by itself? | Yes |
| ●Q17 | Keep verified accounts protected by default; keyword match "anywhere" with "whole words" in Advanced; unreadable bio with keywords set → keep and re-check at 1/2/4/8 plan-days, never unfollow while unknown? | Yes |
| Q18 | Epo still follows accounts that match protection (they are kept; the count is shown)? | Yes |
| ●Q19 | Every launch: a read-only catch-up (header, notifications since last time, newest followers only if the count shows unmatched gains), even before Start, even while a non-safety notice is showing; never after a sign-in/account change or a rate limit? | Yes |
| ●Q20 | Each unfollow is checked once, on the profile, right before it happens (verify-at-act)? | Yes |
| Q21 | An account unavailable on two different days stops being managed (never unfollowed, never read again)? | Yes |
| Q22 | Opening the notifications panel marks notifications seen on the phone; Epo opens it at launch (only when stale) and at planned checks? | Yes |
| Q23 | Large accounts: the occasional full followers check reads as many pages as the header needs, only when the day's allowance covers it in full? | Yes |
| Q24 | Never unfollow someone who has asked to follow your private account while the request is open? | Yes |
| ●Q25 | Pause unfollows when Instagram changes the part of a response that says who follows whom, until an Epo update confirms the change; keep scrubbed local samples (≤ 12/day, copied only on request); a calm sidebar line when Epo adapts? | Yes |
| Q26 | Re-scrub the committed 2026-08-12 bodies and scrub the 2026-11-02 bodies into the test corpus? | Yes |
| Q27 | An unrecognized server error on follow/unfollow: check the screen and the block notice to tell what kind of refusal it is — and always count it toward the safety ladder (never as "unconfirmed")? | Yes |
| ●Q28 | Stage labels Live · People · Graph · **Clean up** · Settings (⌘1–⌘5, ⌘,) — the brief called the fourth tab "Prune"; "clean up" is the one word used everywhere; hero = followers gained today (net); bundle Inter; reopen `--faint`/`--muted`/`--danger` for WCAG AA; keep 460 × 44? | Yes |
| ●Q29 | After a crash, resume only once the window is revealed and the startup checks ran (≈ 1–3 s later)? Stop with no confirm and an Undo toast? Remove dashboard zoom? Window title + Dock "!" badge? Always open on Live? | Yes |
| ●Q30 | Delete the static growth projection band; measured growth only; organic new followers grouped, lost followers as a count; the raw log only in Diagnostics; a short "new look" tour once after updating? | Yes |
| Q31 | Allow an additive change to the tab's network listener to read request form fields (never stored or logged) — the optional last parse slice? | Deferred (non-goal for this overhaul) |
| Q32 | A "Check now" button? | Not in v1 |
| Q33 | A manual single unfollow of a protected account (no UI today): refused unless an explicit confirm names the matching rule? | Yes |
| Q34 | "Net today" counts only changes Epo can place on today; changes from while Epo was closed appear once under "While you were away"; on the first launch after the update, fill in missed follows (≈ 5 weeks from one notifications read) on their real chart days; headline = Instagram's count with "checked at" + "+N since"? | Yes |
| Q35 | Boost keeps accepting follow requests (a light check) so private accounts keep growing; "Reach more people" widens the follow-back curve by 1.5× in log space; changes made in an older build are offered back union-only; mode labels "Easy" and "Advanced"? | Yes |
| Q36 | Stop a list walk when Instagram's "end of list" turns out false with no next-page link, instead of guessing further pages? | Yes |
| ●Q37 | You quit while a Boost is on and reopen 3 h later: Epo starts stopped (as always), the Boost keeps its wall-clock end and the sidebar says "Boost is on, but Epo is stopped — press Start to use it". **Alternatives:** (a) an active Boost resumes work on reopen (a narrow exception to "always start idle"); (b) the Boost clock pauses while Epo is stopped. Keep the default? | Yes (wall clock, start idle, visible `paused`) |
| ●Q38 | When your following count shows changes made outside Epo, Epo reads your following list (2 requests) to learn exactly who changed — in the first session after Start, at most once a day, never at launch (the lead's launch list). Also allow it at launch? | Session only |
| ●Q39 | When Instagram changes how follower lists look, Epo keeps following the people it already found but **pauses finding new people** until an Epo update confirms the change (it stops sending list requests after two drifted pages, A5), and shows a compatibility line instead of "Taking a break". From the drifted pages it may still use rows it can read with certainty (each person is re-checked on their profile before any follow). OK? | Yes |
| ●Q40 | To open into a fully ready app, the splash stays up while Instagram loads and Epo opens your profile (typically 1.5–4 s, at most ≈ 6.6 s; slower or offline → the app opens with "Opening Instagram…"). OK? | Yes |
| ●Q41 | Epo's own work never makes a day bigger than today's build allows (≈ 97 % of your daily target: 48 at a target of 50); the room above it, up to the hard stop (65 at 50), is kept for actions you take yourself and for changes made outside Epo. Days stay as varied as today (Typical: most days 29–47 at a target of 50). Want automatic days above the target instead (the previous draft would have put ≈ 38 % of days above today's maximum and ≈ 15 % at ≥ 1.15 × the target)? | No — keep today's maximum |
| Q42 | Mouse paths keep a fixed shape per install (curvature, wind, momentum), while their speed, pauses and accuracy follow the plan? | Yes |

### 18.3 Recorded answers (gate G0 closed, 2026-11-02) — normative

The owner delegated the build and asked for no further questions, so the lead answered every ● question on the owner's
behalf, reading each against the owner's brief and the owner's current install. Every answer is listed in the hand-off
for the owner to confirm or overturn. **These answers win over any conflicting sentence in §1–§24 and Appendices A–E;
a stream that finds residual text contradicting them follows this table and reports the line to the lead.**

| # | Answer | What changes in the text |
|---|---|---|
| ●Q1, ●Q3, ●Q9, ●Q10, ●Q13, ●Q14, ●Q16, ●Q17, ●Q19, ●Q20, ●Q25, ●Q29, ●Q30, ●Q37, ●Q38, ●Q39, ●Q40, ●Q41 | **The default**, as written in §18.2. Notes: Q16 keeps cleanup of self-followed accounts *off* when no schedule was set, because in v1 an install without a schedule only cleaned up after a manual scan; v2 "on" would start a standing census and unfollow the owner's own follows without being asked. Q29 removes dashboard zoom because zoom desyncs the native tab's bounds from the CSS layout; the larger type ladder (§12.6) replaces it. | none |
| ●Q5 | **The bounded alternative.** Boost may lift each overlapped plan-day's automatic volume up to `automaticDayMax(P0)` (prorated on transition days), never above it; every lifted action is a follow inside the window, `follows ≤ P0` at plan and run time; `M`, `H`, the gap floor, the tempo and the D6 totals never move; a drawn light day is lifted (an explicit Boost overrides the drawn rest); the user's own days off and quiet hours still make Boost wait. Reason: the owner describes Boost as "focusing primarily on exploration and following new profiles"; under "never adds volume" the button adds zero follows in the most common states (cleanup off, the first days, keep-following), which reads as broken, while the lift never exceeds what Epo already does on its largest automatic days. | §8.1, §8.3, §8.5 and laws L13, L13b, L14b (edited in place); the Boost copy in Appendix B.10 / C.15: "Today has no unfollows to swap for follows…" → "Today is already at Epo's fullest day, and Epo is already working."; the `light-day` line is retired; `extraFollowsToday` includes the lift |
| ●Q28 | **"Prune"**, the owner's own word for the tab and the feature, not "Clean up". Stage labels: Live · People · Graph · **Prune** · Settings. In every user-facing string the concept word is Prune/prune/pruning ("Prune people you followed yourself", "Prune now", "Pruning waits during Boost"). Internal identifiers do not change (`prune` stage key, the `cleanup` intent key, the `'cleanup'` `PausedActivity`, the `cleanup-run` writer). The rest of Q28 is the default (hero = followers gained today, Inter bundled, `--faint`/`--muted`/`--danger` reopened for WCAG AA, 460 × 44 kept). | §12.4 (edited in place); every copy deck and stream title that says "Clean up" for the user-facing word reads "Prune" |
| unmarked (Q2, Q4, Q6–Q8, Q11, Q12, Q15, Q18, Q21–Q24, Q26, Q27, Q31–Q36, Q42) | The default. Q42 keeps path *geometry* as named POLICY dials (§3 deviation 4): the brief's "mouse movements" is satisfied by plan-derived durations, pauses and speed–accuracy. | none |
| TK direction boards (workplan TK step 0) | The lead signs off in the owner's absence; the boards stay in the dev gallery for the owner to review. | none |

---

## 19. ADRs to write and amendments

ADR format: `# NNNN — Title`, a status line in the series' style, sections Context / Decision / Consequences /
Alternatives rejected; amendments are appended (`## Amendment — 2026-11-02: …`), never rewritten. Drafts land with the
stream that implements them; the integration lead finalizes numbers and cross-links.

| ADR | Title | Abstract | Stream |
|---|---|---|---|
| **0105** | Settings v2: intent, derived values and overrides in one global document | One global `epo-settings-v2.json` holds plain intent, sparse overrides (`{value, setAt, basis}`), protection, prefs and app state; derived numbers are computed at read time from the kernel and never stored; one `SettingsService` writes (persist-first, atomic + fsync + `.bak`, quarantine, fail-closed protection); typed saves (`saved`/`not-saved`/`refused`) and an `epo:settings` push. The v1 file is never written again; migration is raw-list, count-checked and monotone. Amends 0103 (coercion stays; zod stays out of settings). | SC |
| **0213** | Frontiers, verify-at-act, and a per-account journal | Reopen reads only what changed: persisted frontiers per source (header series, drawer watermark, followers-head frontier, the session-mode following check, journal), one `FrontierSweep` in launch/session/check modes, absence verdicts only from complete censuses. Every unfollow decision is verified once at the click (typed `ClickVerdict`s consume work); no reconcile phase, batches or halt; a per-account journal gate replaces ADR 0212's global block; unreachable/unreadable records park on plan-derived schedules and end in honest terminals; probation derives from the ledger and plan-day windows. Supersedes 0212's "knowledge on return". | RO + UD |
| **0214** | Protection covers every automatic unfollow; the `kept` state | One pure predicate (people by pk, Unicode-folded bio words, verified) evaluated at selection on stored facts and at the click on the fresh observation's own fields; a protected or unreadable record moves to non-blocking `kept` with plan-derived re-checks; fail-closed when the settings document was restored or unreadable. Reverses the 2026-08-31 follow-back-only semantics. | UD |
| **0308** | An unfollow is a bounded sequence of confirm layers; one admission per action | The Actor presses each confirm layer with settle-then-press until evidence (mutation observed, header flip, no new layer); the dispatch closure admits and journals once; the topmost on-top dialog is located with a layer signature; one `MutationWatch` spans the presses (`peek`, `markPress`); Cancel/Close on any exit that did not land; a UI stall never feeds the rate-wall ladder. | CF |
| **0405** | A larger, calmer console: semantic type ladder, AA palette, bundled Inter, motion vocabulary | Semantic type ladder with 15 px body; spacing/control/radius ramps extended; three palette values reopened with measured WCAG AA on every surface; Inter Variable bundled; five motion gestures + file-into, each deadline animated once, a live reduced-motion signal, presentation constants pinned to perception. Amends 1005 (the ladder rule; fluid type removed) and 0402. | TK (+ SB) |
| **0607** | The day plan is the source of every Instagram-facing timing | One counter-seeded DayPlan per account per plan-day (quiet-minute boundary), drawn by a single writer and read purely; per-kind budgets, session layout and a per-session tempo (pace/motion/depth); a closed tempo-spec registry whose identity at tempo 1 reproduces the registry; a rate-neutral derived gap; D4 deadlines never plan-derived. Replaces the golden's "exactly one moved key" with the `RETIRED` ledger + tempo-identity + MOTION goldens + laws. Amends 0605, 0202, 0204, 0211, 0212, 0307; executes 0901. | PC + PR |
| **0608** | The settings envelope rule and the settings-policy tier | Overrides are bounded on the risky side by the most permissive value the kernel derives anywhere on the ordinal grid, on the safe side by named guards, and by coupled bounds over effective upstreams; risk levels and the at-limit acknowledgement; new tier-1 module `settings-policy.ts`. | SC |
| **0704** | Follower change log and own counts | `follower_changes` (transition rows with dating intervals) and `own_counts` (every header observation); components, read-time residuals and plan-day placement with a conservation law; deterministic backfill keeps charts identical at migration. Narrow precursor compatible with ADR 0701. | RO |
| **0806** | One parser, tiers, presence-gated verdicts, witnessed recovery | The surface document drives every endpoint; tiers C0/C1/C2 with an admission table (destructive claims need C0/C1, non-partial, present keys); I1–I10 invariants; bounded structural recovery for three roles with anchors and hints that never promote; one decoder/envelope/gate/router; `SurfaceGate`; persisted drift and per-plan-day health. Amends 0303, 0307, 0801, 0802, 0803. | PP + PH |
| **0904** | Explore Boost is a plan modifier that never raises a ceiling | Boost is a durable per-account window in `plan_state`, written by the plan's single writer, that reallocates the kept remainder to follows and exploration (re-applied by every re-plan), keys its act-now session on run intent, shows `paused` while Epo is stopped, refuses while an earlier Boost's backlog is unpaid, is honest when it shifts nothing, defers unfollows/cleanup/census/non-essential checks, never defers safety or the own-header read, and survives restarts, offline time and clock changes. | PC |
| **1010** | A live-only console, one stage space, and a store-first boot | The sidebar is instruments only (posture, plan, results, feed); targets/queues become the People stage; Settings is a stage; one `StageMode` source; a stage controller with a veil curtain; hidden-window boot with IPC before the dashboard loads, store-first identity, the landing and identity confirmation behind the splash (bounded by a derived IG deadline), Graph preloaded, readiness on `EpoStatus.boot`, a startup lease and sequence; an isolated-profile launch mode for pre-release checks. Amends 1007 (additive `shell.ts` options), 1008 (new pushes), 0210 (crash resume after reveal; passive catch-up under operational blocks), note on 0306. | BL + SH |
| **1011** | The Settings stage: Easy and Advanced | Easy = seven plain sections, intent cards with live numbers, no timings or sliders; Advanced = Easy + Fine-tune blocks + five read-only/expert sections rendered generically from `ParamView`; main computes every number; typed saves with Undo; search over v1 names; lazy mount with zero Instagram traffic. | SU |

**Amendments** (one paragraph each, appended): 0103, 0202, 0204, 0210, 0211, 0212, 0303, 0306 (note), 0307, 0402,
0605, 0801, 0802, 0803, 0901 (executed), 1005, 1007, 1008. **HANDOFF**: one entry at integration (Phase I), newest
first, in the house format. **PRINCIPLES.md**: §1 (the drawer streams per event; dating waits for the frontier), §3
(launch catch-up; planned checks; `advanceTimers` at build is true again). **Owner memory** (the owner session, not
an agent): update `unified-transport-and-bio-keep-list` (protection now covers every path) and `session-robustness`
(superseded parts).

---

## 20. Test strategy and laws

### 20.1 Kernel laws (fast-check over pattern points × day keys × entropy × demand × first-open × Boost)

| Law | Assertion |
|---|---|
| L1 envelope | Σ budgets = `V.planned` ≤ `V` ≤ `automaticDayMax(P0)` at every grid point **and every override** (in particular `V ≤ P0`, never `M`); unfollows ≤ ⌊V/2⌋ outside Boost, 0 inside; follows ≤ `P0` for the drawn kinds **and** at run time (property over `admits`/`mixDraw` with arbitrary unfollow-work availability and request arrivals); accepts never use the unfollow share; per-session `U_s ≤ ⌊b_s/2⌋` (±1 spill) |
| L2 pace | every session `targetMean ≥ 3600·1.3/H`; seeded simulation: realized mean within [0.97, 1.05] × target; the rolling hour exceeds `H` in < 1 % of session-hours |
| L3 unfollow rate | planned unfollow rate per session ≤ `unfollowHourlyCap/CEILING_HEADROOM` |
| L4 gap cap | `cap·τ ≤ CAP_MAX`; `CAP_MAX + max pre-action span < SESSION_BOUNDARY` |
| L5 layout | starts ordered within `[max(S, firstOpen), E)`; separation ≥ boundary; `start + L ≤ E`; **no session intersects quiet hours**; day off ⇒ no sessions |
| L6 volume | the day law equals today's realized law (`min(planner volume, cyclePlan)`, an in-test oracle) in distribution (two-sample KS at fixed seeds) at every consistency; `V ≤ automaticDayMax(P0)` always; rest-day `V ≤ ⌈P0·0.15⌉`; proration non-increasing in `firstOpenAt`; re-plans never re-apportion prorated volume |
| L7 determinism | identical inputs ⇒ byte-identical plan; A → B → A ⇒ plan(A); adding a coordinate site changes no other draw |
| L8 reads | plan reads (explore + census + check pages + catch-up pages + the following check) ≤ D6 everywhere, including Boost at `V = automaticDayMax`; no 24 h span exceeds the D6 totals (trailing backstop); census pages ≤ `censusWalkMax`; head walks never spend the census term; explore at `(V = P0, U = 0)` = D6's exploration share; non-verify ≤ profiles − verifyReserve; checks ≤ the notifications ceiling; no override raises a D6 total |
| L9 boundary | the quiet minute is the masked argmin (ties → centre of the longest run); windows tile time with no gap or overlap across DST (TZ `America/Los_Angeles`, 2026-11-01 and 2027-03-14); a transition day is 12–36 h |
| L10 tempo | factors ∈ [0.7, 1.45]; `motion = pace^½`; `scaleAbove` never crosses a floor; every D4 value and every **shape** `MOTION` key identical at every tempo; speed–accuracy keys monotone non-increasing in `motion` and within their guardrails; every `pace-up` key (`park.blocked`, `backoff.walled`, `beat.transient`) ≥ its prior (today's value) at every tempo and every override; `τ ≥ 1` |
| L11 watchdog | the longest in-step silence at maximum pace and maximum tempo override (factor 3) < `STEP_WATCHDOG_MS` |
| L12 accepts | per pass ≤ `⌊H − H/1.3⌋`; never makes the trailing hour exceed `H − 1`; the day's accepts ≤ `A + slack + F` and never touch the unfollow share |
| L13 Boost | for **every** `ReplanCause` (day-start, first-open, settings, demand, boost-start, boost-end, clock, repair): sessions with `startAt ∈ [t0, t1)` have `mix: 'boost'` and `U_s = 0`, and Σ budgets of the kept remainder = `R + lift` with the lift only in sessions inside the window; the plan-day's automatic total ≤ `automaticDayMax(P0)` (prorated); D6 totals and tempo unchanged; follows ≤ `P0`; clock rules (back, forward, tampered); insertion keys on run intent (`alsoStart` order) |
| L13b Boost honesty | with `U_remaining = 0` and `lift = 0` Boost changes no budget (only session placement, if any); `extraFollowsToday = U_remaining moved + lift placed`; no re-plan without an active Boost ever increases Σ future budgets beyond the kept remainder |
| L14 backlog | after a 12 h Boost the backlog returns to steady state within ⌈excess/(V/4)⌉ days; `u_max` never exceeded; Boost is refused while backlog > `MAX_BACKLOG_DAYS · room` |
| L14b multi-day | over any 7 plan-days, Σ follows with Boosts − Σ follows without ≤ Σ lifts granted + the deferred unfollows still unpaid at the horizon; no plan-day's automatic total ever exceeds `automaticDayMax(P0)` |
| L15 census | an overdue census runs in the first eligible session (a day whose peak session was skipped runs it in the next one); never in a Boost or probation session; never longer than `censusWalkMax`; "too large" refuses with absence verdicts off |
| L-ENV | settings: effective ∈ bounds for every intent × override; with no overrides effective = today's derivation at all 30 grid points; `ENVELOPE.hourlyCap.max ≤ FOLLOW_WALL_PER_HOUR.low`; every `tempo.*` and gap override only lengthens (effective ≥ the plan's own briskest draw); `checks.everyHours` ≥ the briskest derived spacing; no override raises a read total or `V` |
| L-MIG | protection monotone; no list shrinks; idempotent; default v1 and every default persona (incl. cautious) → zero overrides; a refusal keeps v1 state and writes no v2 |
| L-PROT | predicate monotone in entries/words/rules; folding ⊇ today's matches; no follow-back field on the subject |
| reentry L1–L13 | T5 §8: only the delta; never fabricate; conservation; clock independence; no head-of-line; journal per account; one conversion; backfill identity; watermark monotone; frontier never removes an edge; probation; launch passivity; park schedule monotone |
| surface laws | correct parse or typed failure, never a wrong fact; small delivery changes still parse; C2 never destructive; walk table (L-WALK) |
| UI laws | L-POSTURE (exactly one kind; predicate holds; earlier fail; `day-off` only from `plan.day.dayOff`; a late first open and a zero-volume light day render `done-for-today` with their own next line), L-PRIMARY, L-COUNTDOWN, L-ZERO, L-FRESH, L-GEOMETRY, L-CONTRAST (every text token ≥ 4.5:1 on every surface), L-COPY (no banned words; no raw keys; headline ≤ 15 chars; no literal duration or count in copy; one word per concept: no "prune", "whitelist" or "Steady" as a pace/cleanup label), L-TOKENS (every `var(--…)` declared), L-STAGE, L-ATTENTION, L-MOTION, L-MARK, L-RESUME (peek = adopt, no writes), L-FEED, L-BOOT (phases only advance; before the reveal the only tab work is the home load, the landing press and its URL wait and `confirm-account`'s passive reads — no drawer, list read or third-party visit) |

### 20.2 Goldens and identity

`derive-golden.test.ts` (snapshot − RETIRED ⊕ CHANGED = registry, grid, personas and profiles; the deliberate-change
test equals the `CHANGED` ledger; reviewed tally 40/34/16/9); `tempo-identity.test.ts` (every spec at
`REFERENCE_TEMPO` = its prior; every RIM/ENGINE/NOISE band and MOTION duration claimed exactly once or listed in
`NOT_TEMPO`; every `TempoKey` has ≥ 1 call site or sits in `PENDING_CONSUMERS`, which Phase I empties);
`motion-golden.test.ts` (frozen snapshot + `ADDED` + `MOTION_ROLE` coverage); `gap-model.test.ts` (Balanced 303.9 s
± 1 %; τ = 1 reproduces today's draw formula); `day-law.test.ts` (the volume law against the in-test `cyclePlan`
oracle); `derive-reads.test.ts` amended (profiles 415 / exploration 189 / pages per the census and frontier terms;
governor holds no numbers); `catalog.test.ts` (every exported kernel tier-1 entry appears in the Under-the-hood
catalog); tokens golden (deliberately updated with ADR 0405); `fundamentals.test.ts` unchanged (no new EMPIRICAL
entries).

### 20.3 Integration (`tests/integration/*`, through `tests/kit`, fake tab + fake clock + real store)

Plan: I1 rate oracle (red against S1, green after S2); I2 zero reads on refused mutations (ceiling / session / kind /
deadline / probation / journal / surface-paused / protection-paused); I3 cleanup run under the plan; I4 N status reads
leave `plan_state` byte-identical; I5 restart mid-gap serves the persisted deadline and the next draw is identical; I6
bookkeeping never re-plans; I7 a legacy settings file loads, drops keys loudly, the plan runs; I8 a 6 h close → expiry
and proration; I9 Boost across a restart, a clock jump, a settings change during Boost, the plan-day edge inside a 20 h
Boost and a `plan_state` repair (the overlay survives every cause); I10 `tallySince` = `actionsToday` on journal
fixtures; I11 one simulated week per persona (daily totals = `V.planned` ≤ `automaticDayMax(P0)`, spacing ≥ floor,
hourly ≤ `H`, reads ≤ D6); I12 a cleanup run with a deadline and an hourly-cap refusal mid-run (no candidate marked
visited without a visit); I13 the unconfirmed-actions breaker (two silent refusals pause unfollows; the third enters the
ladder); I14 `alsoStart` while stopped inserts the act-now session; a quit + reopen with Boost shows `paused`.
**Checkpoint test** `tests/integration/lifecycle-reachable.test.ts` (lands with UD-b, kept green through PR S1/S2 and
RO-b): a due lifecycle unfollow is executed end to end and no reconcile phase wedges admission at every merge from UD-b
to RO-b. Reopen: T5 I1–I12 (overnight reopen; a week away; DST fall-back; drawer drift; a deleted account at the queue
head; a private account with 5 requesters; a manual unfollow after a week away; crash after N; a 4 500-follower header;
conversion parity; Boost active; upgrade of the live store's shape: exactly one head page) + the following check
(outside follow and unfollow identified; charge replaced by the exact count). Settings: service write failure →
`not-saved` with no reload/push/re-plan for user settings; run bookkeeping stays in the account store. The one-time
migration claim/consume persists ownership before clearing, and failed consumption cannot seed freshness; seed check never at launch; facts not-built
shape; migration refusal keeps practice mode and writes no v2 after a user op; v2 deleted with `.bak` present →
`restored-from-backup` + `needs-review`. Boot: R2 → R3 → landing behind the splash → ready; the IG deadline falls back
to the placeholder; steps in order under the lease; queued Start never `manual-running`; settle-deadline fallback; no
read path calls the tab.

### 20.4 Tooling tests

- `tests/tooling/no-static-timing.test.ts` (TypeScript compiler API, already a devDependency) [arch r2: the gate that
  enforces owner item 1 has no syntactic holes]:
  - **Scope**: every `.ts/.tsx` under `src` except `src/kernel/**` (the home of every allowed constant) and
    `src/renderer/**` (§3 deviation 1, pinned by its own tests). `src/probe`, `src/livetest`, `src/capture`,
    `src/inspect`, `src/tools` and `src/surface-lab` are in scope; their entries are allow-listed as **harness** with a
    reason, so a harness can never quietly become production.
  - **Literals**: refuses **every** numeric literal other than `0`, `1`, `−1` and the unit multipliers of
    `kernel/units`, in **any** syntactic position — call argument, default parameter, object-literal property (e.g.
    `ACQUISITION_DEFAULTS {maxCoverageFraction: 0.5}`, `EFFECT_POLICY.READ_RETRY {base: 2_000}`), class field, local or
    top-level `const`, operand of arithmetic, array element — unless allow-listed.
  - **Priors**: refuses any **property access** (not only imports) to a key a tempo spec claims (`MOTION.*`,
    `PACING_BASE_MS.*`, the claimed `RIM`/`ENGINE`/`PRUNE`/`NOISE`/`RECOVERY` keys including `ENGINE.IDLE_MS`,
    `PRUNE.PARK_MS`, `ENGINE.ENRICH_BACKOFF_MS`, `RIM.SCROLL_WAIT_MS`) outside `src/kernel/tempo/**`; group imports
    (`import { ENGINE, RIM }`) cannot hide them.
  - **Randomness**: refuses `Math.random` everywhere outside the renderer; the one true-random call is the entropy root
    `src/utils/entropy.ts` (`node:crypto`). Every `?? Math.random` default (`profile-visit.ts:63`,
    `list-page-walker.ts:91`, `followers-page-reader.ts:90`, `interactor.ts:46`, `primitives.ts:72`,
    `page-pacing.ts:12`, `delay-manager.ts:62`, `engine.ts:250`, `recovery.ts:103`, `prune-engine.ts:207`,
    `rate-governor.ts:27`, `schedule-manager.ts:131`, `knowledge-store.ts:92`, `spans.ts:129`, `graph-builder.ts:339`)
    is deleted in the same commit that seeds the gate, replaced by an injected seeded stream.
  - **Allow-list** `tests/tooling/static-timing.allow.json`: each entry `{key, class: 'GEOM' | 'HARNESS' | 'PENDING',
    reason (≥ 20 chars), stream?}` with `key = <file> :: <enclosing function or declaration> :: <callee or property
    name> :: <literal text>` (line-free, stable under unrelated edits). `node scripts/gen-static-timing-allow.mjs` is
    **prune-only**: it removes entries that no longer match, never adds; `--seed` (run once, by F2c) writes the initial
    list, every `PENDING` entry naming the stream that removes it; `--move <old-key> <new-key>` re-keys an entry when a
    literal moves (a split, a rename) and keeps its reason; `--against <git-ref>` refuses any key absent at that ref.
    After Phase I only `GEOM` and `HARNESS` entries remain.
  - **Tempo keys**: every `TempoKey` has ≥ 1 call site, or sits in `PENDING_CONSUMERS` (`src/kernel/tempo/pending.ts`,
    e.g. `gap.action` until PR S2, `check.spacing` until PC/PR), which Phase I empties.
- `scripts/gen-line-budget.mjs` gains `--against <git-ref>` (refuses any upward entry relative to the ref); Phase I
  regenerates with `--against overhaul/integration`.
- `tests/tooling/pending-wiring.test.ts`: every path in `tests/tooling/pending-wiring.json` (modules deliberately
  unwired for now, read by `.dependency-cruiser.mjs` as `no-orphans` exceptions) still exists and is still unwired; the
  list is empty at Phase I.
- `tests/tooling/no-overhaul-files.test.ts`: `git ls-files -- .overhaul` is empty (no topic-design copy is ever committed).
- Guard-line structural tests for every new tier-1 module (each entry has a one-line comment).
- `scripts/plan-qc.mjs` simulates 28 plan-days per persona × consistency × caution and exits non-zero on any envelope
  breach (the offline distributional evidence, because live tests are scarce).

### 20.5 Renderer, background, visual

`view-liveness` (a pushed status/feed/activity/settings/settingsFacts/surface revision moves a rendered value with no
pull); sidebar zones; boot gate; app shell (five tabs, `stageRequest`, ⌘, , no `checkSeed` at boot, tooltip host outside
`.console`); settings stage (one apply per click; revert on `not-saved`; Undo; older-rev pushes ignored); seed field
(zero `checkSeed` on mount); protection section (no remove-all; Undo); tour anchors (written **first**, before any card is
deleted); gallery scenarios at heights 640/800/920/1200 and widths 1024/1440/1920. `node scripts/background-probe.mjs
--soak-ms 10000` must pass every scenario including `stage-hidden` and the new `never-shown-boot` (zero Instagram
traffic), and the dashboard pacing guard (≤ 150 callbacks/s) must hold with the new animations. **Visual checks run only
in the isolated profile** [arch r2]: `EPO_USER_DATA_DIR=<fresh temp dir>` (honoured in `app-identity.ts` before
`app.setName`, so the real `<appData>/Epo` is never opened: no store migration, no `epo-settings-v2.json`, no live
cookies) plus `EPO_BLOCK_NETWORK=1` (the IG partition gets `session.setProxy` to an unroutable proxy), i.e. signed out
and offline by construction. The integration build **never** opens the real `userData` before Phase L (it would migrate
the owner's store past what the installed release can open, `migrations.ts:16`). Checks: no white frame, maximized
state restored without visible zoom, the IG view never visible before the curtain, smooth curtain, pixel-exact mark
FLIP, no font reflow, reduced motion complete, shortcuts while IG has focus, no popover under the native view, layout
modes at 640/800/920, the offline placeholder after `IG_READY_DEADLINE_MS`.

---

## 21. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Bold now runs ≈ 16/h in-session (today ≈ 12/h for every caution) | upgrade probation; owner Q1; law L2; live L4/L5 watch |
| R2 | A partial merge removes the legacy floor without the plan gap (≈ 3× the action rate) | S2 is one merge, guarded red-to-green by I1; Phase I checks the merge order |
| R3 | Estimator error makes the realized pace faster than the target | law L2 [0.97, 1.05]; I1 against the legacy oracle |
| R4 | Golden churn tempts snapshot edits | `RETIRED` ledger + ADR 0607; the test computes its expectation from the ledger |
| R5 | Line-budget and shared-table collisions across worktrees | Phase F lands every split, migration, IPC row, CSS file and status field first; streams add code in owned files; re-seed is one command |
| R6 | Verify-at-act changes the queue meaning ("up for review" is unverified until its click) | typed verdicts consume work; law L5; the non-dispatch review bound; fallback named (§9.7) |
| R7 | A migration bug drops or empties a protection list | raw-list reads; count post-conditions refuse instead of fixing up; monotone laws; v1 never written; `.bak`; fail-closed |
| R8 | Broad keywords protect too many people; unreadable bios pile up `kept` records | live per-word counts; whole-word option; kept/unreadable counts visible; drift signal |
| R9 | The sibling requests preview is only ≈ 5 rows | presence only; "at least N"; absence only from a complete panel |
| R10 | The filtered drawer body is not captured (chip timing), so the feed's reach drops to ≈ 20 h | chip-when-ready + post-chip wait; `filtered` logged; the head walk recovers identities; the header keeps counts exact |
| R11 | A flipped parser rejects a body legacy tolerated, killing a census mid-walk | per-row/per-field tolerance; corpus differential; laws; one flip per commit; reverse shadow; deletion only after L1 + L4 |
| R12 | Unfollows pause for days while a surface change waits for an update | visible sidebar line; Copy report with the exact one-line fix; the gate wastes no reads |
| R13 | A never-shown window or hidden `maximize()` behaves differently than reasoned | no input while hidden; reveal on `did-finish-load` + fallback; the `never-shown-boot` probe; visual checks; fallback to today's show-then-maximize |
| R14 | A stale stored username after a rename while closed | no username-dependent tab work before `confirm-account`; rebuild while idle |
| R15 | The owner rejects the visual direction again | **direction boards first**: TK's step 0 renders static boards from fixtures (sidebar postures at 640/800/920 px, Easy and Advanced Settings, People, the splash and intro storyboard) and the owner signs off **before TK merges**, so no stream builds on an unapproved direction; SB's gallery step only confirms the wired version |
| R16 | Every drawer pass marks notifications seen on the phone | at most one pass at launch (only when stale) and one per planned check — fewer than today's up to 28 a day; owner Q22 |
| R17 | A capability flag left false hides a control permanently | each wiring site sets its flag in the same commit; a Phase I test asserts all flags true in the composed graph |
| R18 | Plan-day "net today" differs from calendar-day charts | live counters use the plan-day; charts stay calendar days, labelled |
| R19 | The first launch after the update writes dozens of dated follows onto past chart days | that is the truth arriving; law L8 keeps charts identical at migration; the copy explains it |
| R20 | An owner answer reverses a default after streams built on it | every ● question is answered before Phase P (gate G0); the remaining defaults change no shared contract |
| R21 | Boost disappoints because it often shifts nothing | the preview states the real effect (or disables Start), Q5 is asked with its consequence and the bounded alternative |
| R22 | A drifted list format stops growth until an update | the exploration gate stops requests after two pages, queued candidates keep being followed, the compatibility line explains it, C2 `source-rows` keep up to two pages of certain rows; owner Q39 |
| R23 | A pre-release check opens the owner's real profile and migrates the store | the isolated-profile launch mode; the workplan forbids any launch against the real `userData` before Phase L |
| R24 | A topic-design copy with account evidence is committed | contracts live in this spec's appendices; `.overhaul/` is excluded through the common git dir and a test fails if any path under it is tracked |

---

## 22. The minimal live-test plan (Phase L; strictly sequential; run by the lead only; owner present)

Ground rules (memory `account-safety-probing`, U11 §1): passive first; each composed read once; stop at the first wall;
consent for any action; Epo quit before any tool run (tool harnesses do not take the single-instance lock and share
`userData`); one designated runner; outputs under the session scratchpad, never in a worktree; space steps ≥ 1 h and
never on a day the account already hit a wall. **Do not start the production engine before the confirm fix (F1–F5) and
the settlement fix (F6) are merged** (the live store holds one stuck uncertain unfollow from 18:30; `epo-runtime.json`
says `desired: stopped` — keep it so). **Before L1 the integration build has never opened the real `userData`**
(every earlier visual check ran in the isolated profile, §20.5); L1 and L4 are the first runs against it, after the
lead backs up `<appData>/Epo` (the store and both settings files) to the scratchpad. The plan's timing (look-before-act,
step pauses) is verified in L4/L5, where the production engine runs with the plan-backed tempo; L1 verifies parsing
only. Do-not-run: `EPO_PROBE=followers` (whole list), `EPO_PROBE=window` (stale),
`unfollow-hover` on any target not just verified `following:true, requested:false`, any scripted press-through of a
confirm dialog, `capture` while the owner clicks Unfollow, repeated `verify` runs, two tools at once.

| Step | What | Requests | Pass | Stop |
|---|---|---|---|---|
| **L0** offline gate (mandatory) | `npm run check`; the U06 actor tests (P, R, public, stall, F6); seed-never-at-launch; reentry DST tests; corpus replay + leak; `node scripts/background-probe.mjs --soak-ms 10000 --output "$SCRATCH/bg.json"`; `plan-qc` | 0 | all green | any red |
| **L1** `EPO_PROBE=verify`, once, post-merge (mandatory) | parsers on the visit and drawer paths (the probe builds its own interactor and actor and drives the drawer directly with its own settles, `probe/verify.ts:44-46,81-85`, so it can observe **parsing**, never the plan's timings) | 0 composed, 0 mutations; ≈ 90 IG-client exchanges; ≈ 2 min | own and target `ok` with counts and viewer flags; `biography` and `is_verified` present on both bodies; `EPO_PROBE_TARGET` is a public account the owner follows, mutual preferred (use an **empty-bio** account if the owner can name one, to observe `null` vs `''`; without supporting corpus/live evidence, `EMPTY_BIO` stays unresolved and null stays absent/fail safe); nonexistent `gone`; drawer steps true; each completed exchange 2xx, with positively observed ancillary navigation cancellations accounted separately under ADR 0807; every profile/feed/requests body `canonical`, not partial; 0 `shadow-disagreed` | any observed non-2xx, HTML, sentinel ≠ ok, shadow disagreement, unqualified transport or missing required body |
| **L4** supervised production relaunch after ≥ 1 night away (mandatory) | reopen catch-up, seed, boot, geometry, Boost durability, the production tempo | the home load + the landing behind the splash (1 navigation); 1 drawer pass (≈ 2 feed bodies); **exactly 1 composed list page** on this first launch after the upgrade (no `reopen_state` → `initialized`); **0 third-party visits before Start**; after Start: 1 journal visit (the 18:30 intent), then planned work | before the reveal only the home load, the landing press and its URL wait (no drawer, no list read); no seed-check hold at launch; the intro lands on the own profile, already settled; `confirm-account` confirms; catch-up steps `done` or typed skips; the summary agrees with the header (conservation); the head walk reads one page and initializes the frontier; `filtered: true`; the drawer's step pauses (`ui.step-pause`) present between bell, chip and close; "checked …" moves to now; the feed shows "While you were away"; no "0 / 0", no "not available", no count-up (screen recording); the stuck intent settles `cancelled` with its record still `unfollow_queued`; no census; no following check before Start; the compatibility panel reads "Working normally"; list pages read with 0 `shadow-disagreed`; if a Boost was left on before the quit: `paused` while stopped ("Boost is on, but Epo is stopped"), then `on` after Start with its original end time | sentinel ≠ ok; a drawer opened > 2× in 5 min; more than one list page before Start; any census start; any visit before Start |
| **L5** same session continuing: the first due unfollows (mandatory; consented; planned mutations only) | confirm layers (item 5), the DayPlan cadence and in-action pacing | nothing extra: the engine takes its next due unfollows — the stranded Requested record (cancel request), the next public, the next private | exactly one admission per unfollow, before the header press; the look-before-act dwell (≈ 2.5–4.5 s at a normal-pace session) precedes each header press; a `ui.step-pause` precedes each confirm-layer press; the mutation observed and arbitrated `ok` (cancel-request op name captured if not unfollow-named); header `Follow` within the DOM window; no dialog left on screen; the record → `unfollowed`, never `external`; the capture hook wrote the layer DOM; the first 2–3 dispatch-to-dispatch gaps match the session's GapSpec; the trailing-hour count ≤ H; the session layout matches the plan projection; the first session runs in probation | `throttled`/`walled`/`refused`; `TabUnresponsive post-click`; a dialog still visible; a second admission; any press on an unrecognized dialog; any record → `external` |
| L5b Boost (optional, same session, after L5) | start a Boost (one tap, the saved length), watch the first 2–3 follows (re-verifies the follow press), end it early | planned follows only | the preview line matched what happened (act-now session, follows instead of the remaining unfollows); follows only; no unfollow/census during Boost; the own header still read at the session start; the band and countdown render; End Boost restores the normal mix | any unfollow during Boost |
| L2 / L3 (conditional) | passive traffic / bounded own-list reads | — | **not needed**: the reopen design answers order and page size offline (LC0) and folds the head walk into L4 | — |
| L6 (optional) | a consented public follow/unfollow pair via `EPO_PROBE=follow` | 2 mutations | the public path of the layer loop | — |
| After L1 + L4 evidence | the parse deletion slice (S8) may merge | 0 | 0 `shadow-disagreed` on profile/feed/requests (L1) and lists (L4) | — |

**L1 capture qualification amendment, 2026-11-04 ([ADR 0807](../../adr/0807-probe-transport-evidence.md)).**
Local Electron reproductions showed that page CDP can omit terminal events both for a natively canceled
request and for a natively completed 200 response. L1 now requires an independent, owned native request
inventory and unambiguous correlation with CDP. Only a positive native `net::ERR_ABORTED` terminal for an
ancillary request overlapping observed main-frame navigation may be recorded as `navigation-canceled`;
it is never counted as a successful response. Missing/ambiguous terminals and all unsafe responses fail.
Every known Reader request still needs its own captured body and each profile/feed/requests body its own
canonical, non-partial read. Auxiliary 2xx response bodies may be explicitly unavailable. This amends the
previous literal "every exchange 2xx" gate; none of the earlier stopped runs is reclassified as passed.

---

## 23. Defect register (owner-reported and research-confirmed; each fixed at its root)

| Defect | Root cause | Fix (§) | Stream |
|---|---|---|---|
| Unfollow hangs on the private-account confirm pop-up | single-confirm model | 11 F2/F3/F5 | CF |
| "Requested" cancel double-dispatch (live 18:30) | admission re-run at the confirm press | 11 F1 | CF |
| A stalled unfollow strands the record as terminal `external` | settlement maps "still following/requested" to external | 9.8 / 11 F6 | UD |
| A UI stall feeds the rate-wall ladder (~1 h hold after 3) | any blocked cause noted as rate-limited | 11 F7 | CF |
| "Target not available" at reopen | hidden mount-time seed check + typed refusals + catch-all copy + no re-validation | 13 | SC + SH + BL |
| Failed saves shown as "Saved" | persist failure logged and the call returns success; fallbacks return the old settings | 6.6, 6.10 | SC |
| Cleanup "Deep" clamped to "Steady" | the 0.5 per-draw bound | 5.7 (share of room), 6.4 (`deep` retired) | PC + SC |
| One accept per drawer pass | each accept stamps the legacy deadline that the next accept refuses on | 5.7 `acceptsAllowed` | PR |
| Drawer Follows chip located once with no wait | single locate at `follow-notifications.ts:233` | 9.4 step 3 | RO |
| Unresolvable records wedge reconciliation; halt after 5 | batches ahead of decisions; unavailable = forever | 9.7–9.9 | UD + RO |
| DST forces a census and probation | `getTimezoneOffset()` compared as an untrusted clock | 9.11 | RO |
| Stage desync when `login()` shows the tab | `login()` calls `tab.show()` directly | 12.4 | BL |
| Tooltip clipping on stage pages | `TooltipHost` inside `.console` (`overflow:hidden`) | 12.4 | SH |
| Status reads forfeit sessions | status calls `sync()`-running planner methods | 5.1 | PR |
| Visit-then-defer loops (reads burned on refused mutations) | admission after the visit | 5.13 S2 step 3; 9.7 step 0 | PR + UD |
| Velocity park a fixed 5–15 min | log-normal park instead of the window | 5.10 | PR |
| 17 % of planned days exactly at the ceiling (masked today only by the cycle-plan gate) | the planner's `Math.min` clamp at `M` | 5.4 step 2 (today's realized law, never above `automaticDayMax`) | PC |
| A manual Prune scan silently starts woven unfollowing | the feed drains any fresh census while `weaveEnabled` | 6.4 (cleanup off never drains) | UD |
| Cleanup never runs for an owner who opens Epo outside the day's peak | (would-be) census pinned to one session at draw time | 5.8.3 durable per-session predicate | PC + RO |
| Every timing-related randomness default falls back to `Math.random` | `?? Math.random` in a dozen constructors | 20.4 randomness ban + injected streams | F + PR |
| Protection lists lost on a corrupt file / reset wipes lists and practice mode | defaults overwrite; reset writes `DEFAULT_SETTINGS` | 6.6, 6.7 | SC |
| Lost-update race in the list editor | whole-list writes | 6.7 keyed ops | SC |
| An absent relationship key flips held records to `external` | `=== true` truthiness | 10.4 | PP |
| A missing cursor ends a walk with `has_more:true`; a synthesized offset "verifies" | continuation semantics | 10.4 | PP |
| `{data:{user:null}, errors}` reads as "gone" | envelope ignores errors | 10.4, 10.5 | PP |
| Coverage waves a census through on an unknown header | `known === null` early return | 10.4 | PP |
| The large-account census can never complete | the 200-page bound | 5.8 | PC + RO |
| Organic new followers uncounted (feed skipped when nothing managed is pending) | watcher early return | 9.4 | RO |
| Zeros and count-ups at boot; white first frame; IPC after page load | not-built shapes rendered; visible window; load order | 12.8 | BL + SB |
| "You are up to date" without a check | `idle` mapped to up-to-date | 13 | BL |
| Start refused `manual-running` at launch, then auto-starts anyway | no single tab owner at launch | 12.8 | BL |

---

## 24. Glossary

| Term | Meaning |
|---|---|
| DayPlan | the one plan per account per plan-day: volume, kind budgets, sessions with tempo, reads, census slot |
| plan-day | the window between two quiet minutes (23–25 h); the key is the local date it starts on |
| quiet minute | the argmin of the masked weekday intensity; the plan-day boundary |
| tempo | a session's `{pace, motion, depth}` factors; ambient tempo applies outside sessions |
| prior | a tempo spec's value at tempo 1 (identity with today's registry) |
| GapSpec | the session's time-scaled gap shape, drawn at dispatch |
| preflight / armAtDispatch | the admission before any visit / the deadline drawn and persisted when a mutation dispatches |
| verify-at-act | every unfollow decision verified once, by the click-time visit, with a typed verdict |
| journal | `effect_intents`: Epo's own writes and their outcomes; gated per account |
| frontier | a persisted cursor per source (watermark, head frontier, header series) |
| C0 / C1 / C2 | canonical / normalized / recovered read tiers |
| destructive / guarded / additive | what a read may feed (§10.2) |
| `kept` | a non-terminal follow state for protected or unreadable records; never blocks the queue |
| Boost | a durable per-account window that reallocates the kept remainder of the day to follows and exploration |
| posture | the one pure description of what Epo is doing (headline, tone, primary control, countdown) |
| basis | `built` / `not-built`: whether a status may render counts |
| startup lease | the `'startup'` tab owner from R3 through the startup sequence (the landing behind the splash, then catch-up and resume) |
| capability | a Settings flag that hides controls until their engine dependency is wired |
| `P0` / `V` / `M` | the daily target / the day's automatic volume (today's law, ≤ `automaticDayMax(P0)`) / the hard stop (manual and outside headroom) |
| automatic-day band | today's `cyclePlan` draw `[0.85, 0.97)·P0`, kept as the upper half of the day law |
| `R` | the kept remainder: Σ budgets of kept sessions not yet ended, minus their usage |
| pace-up | the tempo axis `max(1, pace)` for waits after a wall, refusal or failure (never shorter than today) |
| frontier term | the D6 list-page term for head walks (`(1 + sessionsPerDayMax) × FRONTIER_PAGES_MAX`) |
| `PlanDayClock` | the one port every day counter reads the plan-day boundary through |
| unconfirmed-actions breaker | two silent refusals in a row pause that kind of action; a third enters the ladder |
| isolated profile | `EPO_USER_DATA_DIR` + `EPO_BLOCK_NETWORK`: a signed-out, offline launch that never touches the real `userData` |

---

## Appendix A — DayPlan, tempo, cadence and Boost contracts (normative)

Reconciled from T1 §4 with §14 (C3, C4, C6, C9, C11, C19, C21, C25) and revision 2. §5.15 is the condensed view of this
appendix; where they differ, the more specific statement here wins only if it agrees with §5 — report any conflict to
the lead. Every type below lands in Phase F (F2a) unless a stream is named.

```ts
// ── src/kernel/rng.ts (F2a) ────────────────────────────────────────────────────────────
export declare function mulberry32(seed: number): () => number;
export declare function fnv1a(s: string): number;

// ── src/kernel/plan/types.ts (F2a; types only) ─────────────────────────────────────────
export type PlanDayKey = string;                              // local date the window STARTS on, 'YYYY-MM-DD'
export interface PlanDayWindow { readonly key: PlanDayKey; readonly startsAt: number; readonly endsAt: number; readonly quietMinute: number }
export interface PlanDayClock {                               // the ONE boundary every day counter reads (§4.4)
  window(t: number): PlanDayWindow; dayKey(t: number): PlanDayKey; onRoll(fn: (w: PlanDayWindow) => void): () => void;
}
export type MutationKind = 'follow' | 'unfollow' | 'accept';
export type Writer = 'growth' | 'woven' | 'cleanup-run' | 'manual' | 'accept-pass';
export type ReplanCause = 'day-start' | 'first-open' | 'settings' | 'demand' | 'boost-start' | 'boost-end' | 'clock' | 'repair';
export type PlanBinding = 'none' | 'band' | 'session-time' | 'light-day' | 'follow-bound' | 'day-off';
export type ReadUse = 'verify' | 'reconcile' | 'explore' | 'check' | 'census' | 'catch-up';
export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;           // Sun..Sat (kernel-local; equal to src/shared's by a test)

export interface CircadianShape {
  readonly bumps: readonly { readonly centerHour: number; readonly amplitude: number; readonly widthHours: number }[];
  readonly overnightFloor: number;
  readonly weekdayWeights: readonly number[];                 // Sun..Sat
  readonly weekendShiftHours: number;
}
export interface GapShape {                                    // the rhythm/caution reference at time-scale 1
  readonly medianMs: number; readonly sigma: number; readonly floorMs: number; readonly capMs: number;
  readonly hawkesAlpha: number; readonly hawkesTauMs: number;
}
export interface PlanIntent {                                  // §5.3 (built by src/settings/plan-intent.ts)
  readonly operatingRate: number;                              // P0: the daily target; V ≤ automaticDayMax(P0)
  readonly hardCeiling: number;                                // M: manual + outside headroom only
  readonly hourlyCap: number;                                  // H
  readonly probationHourlyCap: number;                         // H one caution rung down
  readonly unfollowHourlyCap: number;                          // from UNFOLLOW_WALL_PER_HOUR (law L3)
  readonly sessions: { readonly min: number; readonly max: number };
  readonly gap: GapShape;
  readonly gapTargetOverrideMs: number | null;                 // effective scale, slower only (§5.10)
  readonly gapFloorOverrideMs: number | null;
  readonly volumeSigma: number;                                // dailyVolumeVariancePct / 100
  readonly restDayProbability: number;
  readonly consistencyScale: number;                           // SCALES.consistency[k]
  readonly cleanupShare: number;                               // 0 · .36 · .71
  readonly cleanupPerDayCap: number | null;
  readonly patienceWaitMs: number;                             // census freshness
  readonly checkSpacingOverrideMs: number | null;              // slower only
  readonly acceptRequests: boolean;
  readonly shape: CircadianShape;
  readonly quietHours: { readonly startMinute: number; readonly endMinute: number } | null;
  readonly daysOff: readonly DayOfWeek[];                      // ≤ 6
  readonly tempoOverrides: Readonly<Partial<Record<TempoKey, number>>>;   // factors ∈ [1, 3]
  readonly planBuffer: number;                                 // POLICY.PLAN_BUFFER (explore sizing)
}
export interface PlanDemand {                                  // store snapshot built in plan-wiring.ts; audit only in the plan
  readonly lifecycleDueByDayEnd: number; readonly lifecycleBacklog: number; readonly pruneStock: number;
  readonly protectedReeval: number; readonly journalPending: number;
  readonly followsDoneToday: number; readonly outsideToday: number;
  readonly pendingRequests: number; readonly acceptsRecent: number;      // accepts per plan-day, trailing 7
  readonly ownHeader: { readonly followers: number | null; readonly following: number | null };
  readonly census: { readonly lastCompleteAt: number | null; readonly rowsPerPage: number | null };
}
export interface KindBudgets { readonly follow: number; readonly unfollow: number; readonly accept: number }
export interface SessionReads {
  readonly reconcile: number; readonly explore: number; readonly explorePages: number;
  readonly checks: number; readonly checkPages: number;          // checkPages ≤ FRONTIER_PAGES_MAX
}
export interface ReadPlan extends SessionReads {
  readonly census: number;                                       // censusWalkPages for the host session, else 0
  readonly following: number;                                    // SURFACE.followingWalkPages when step G may run, else 0
  readonly catchUp: { readonly profiles: number; readonly notifications: number; readonly pages: number };
}
export interface GapSpec extends GapShape { readonly timeScale: number; readonly targetMeanMs: number }
export interface SessionTempo {
  readonly z: number; readonly pace: number; readonly motion: number; readonly depth: number;
  readonly gap: GapSpec; readonly mix: 'normal' | 'boost'; readonly probation: boolean;   // C25: two orthogonal fields
}
export interface PlannedSession {
  readonly idx: number; readonly startAt: number; readonly expectedEndAt: number;
  readonly budget: number; readonly mix: KindBudgets; readonly reads: SessionReads;
  readonly tempo: SessionTempo; readonly before: 'none' | 'first-open';     // no census pin (§5.8.3)
}
export interface BoostWindow {
  readonly v: 1; readonly startedAt: number; readonly endsAt: number; readonly durationMs: number;
  readonly endedAt: number | null; readonly endReason: 'user' | 'expired' | 'clock' | null;
}
export interface DayPlan {
  readonly v: 1; readonly window: PlanDayWindow; readonly revision: number; readonly cause: ReplanCause;
  readonly drawnAt: number; readonly firstOpenAt: number; readonly intentDigest: string; readonly seed: number;
  readonly volume: { readonly lognormal: number; readonly band: number; readonly rest: boolean;
    readonly drawn: number; readonly planned: number; readonly binding: PlanBinding };
  readonly ceilings: { readonly automaticMax: number; readonly day: number; readonly hour: number;
    readonly unfollowHour: number; readonly probationHour: number; readonly followDay: number; readonly acceptsPerPass: number };
  readonly kinds: KindBudgets & { readonly lifecycleUnfollow: number; readonly slack: number };
  readonly reads: ReadPlan;
  readonly dayTempo: { readonly z: number };
  readonly sessions: readonly PlannedSession[];
  readonly demand: PlanDemand;                                   // audit only
}
export interface DrawInput {
  readonly installEntropy: number; readonly window: PlanDayWindow; readonly intent: PlanIntent;
  readonly demand: PlanDemand; readonly phaseOffsetHours: number; readonly firstOpenAt: number;
  readonly boost: BoostWindow | null;
  readonly runIntent: 'running' | 'stopped' | 'paused';          // Boost's act-now insertion keys on this (§8.2)
}
export interface PlanPreviewDay { readonly dayKey: string; readonly startAt: number; readonly endAt: number;
  readonly restDay: boolean; readonly dayOff: boolean; readonly total: number; readonly follows: number;
  readonly unfollows: number; readonly accepts: number;
  readonly sessions: readonly { readonly startAt: number; readonly endAt: number; readonly budget: number }[] }

// ── src/kernel/plan/seed.ts (PC) ───────────────────────────────────────────────────────
export declare function planSeed(installEntropy: number, key: PlanDayKey): number;
export declare function u(seed: number, ...coords: readonly (string | number)[]): number;   // (0,1), order-independent
export declare function z(seed: number, ...coords: readonly (string | number)[]): number;   // Φ⁻¹(u), Acklam
export declare function phaseOffsetHours(installEntropy: number): number;                    // (2u(installEntropy,'phase') − 1) × PHASE_JITTER_MAX_HOURS

// ── src/kernel/plan/circadian.ts (PC) ──────────────────────────────────────────────────
export declare function intensityAt(nowMs: number, shape: CircadianShape, phaseOffsetHours: number): number; // moved; timing/circadian.ts re-exports
export declare function quietMinute(shape: CircadianShape, phaseOffsetHours: number,
  quietHours: { startMinute: number; endMinute: number } | null): number;                    // masked argmin, 0..1439
export declare function planDayWindow(now: number, quietMinuteOfDay: number): PlanDayWindow;
export declare function transitionDay(prevEndsAt: number, newQuietMinute: number): PlanDayWindow & { readonly prorate: number }; // 12–36 h; prorate < 1 only below 23 h
export declare function massQuantileAt(window: PlanDayWindow, shape: CircadianShape, phase: number, q: number): number;
export declare function massBetween(from: number, to: number, shape: CircadianShape, phase: number): number;

// ── src/kernel/plan/volume.ts (PC) ─────────────────────────────────────────────────────
export declare function automaticDayMax(operatingRate: number): number;   // P0 < 10 ? P0 : min(P0 − 1, ⌈0.97·P0 − ½⌉)
export declare function drawVolume(seed: number, intent: PlanIntent): DayPlan['volume'];   // min(lognormal day, band day), §5.4
export declare function allocateKinds(volume: number, intent: PlanIntent, demand: PlanDemand, boost: boolean): DayPlan['kinds'];
export declare function acceptsPerPass(hourlyCap: number): number;                          // ⌊H − H/CEILING_HEADROOM⌋
export declare function dayLawQuantiles(intent: PlanIntent): { readonly p10: number; readonly median: number; readonly p90: number };   // Settings' "most days"

// ── src/kernel/plan/gap.ts (PC) ────────────────────────────────────────────────────────
export declare function targetMeanMs(hourlyCap: number, pace: number, overrideMs: number | null): number;
  // max(3600 s·CEILING_HEADROOM/H/BEAT_MIN, override) × pace
export declare function gapCapMax(): number;                                    // boundary − max pre-action span
export declare function stationaryMeanGapMs(shape: GapShape, sessionBudget: number): number; // deterministic, memoized
export declare function solveGapSpec(shape: GapShape, targetMs: number, sessionBudget: number, floorOverrideMs: number | null): GapSpec;
export declare function drawGapMs(spec: GapSpec, recentTimes: readonly number[], now: number,
  uAt: (attempt: number) => number): number;                                     // Hawkes above the floor
export declare function velocityWakeAt(recentTimes: readonly number[], hourlyCap: number, now: number): number | null;

// ── src/kernel/plan/{tempo,layout,reads,probation,draw,boost}.ts (PC) ─────────────────
export declare function sessionTempo(seed: number, s: number, intent: PlanIntent,
  flags: { readonly mix: 'normal' | 'boost'; readonly probation: boolean }, hourlyCap: number, budget: number): SessionTempo;
export declare function layoutSessions(seed: number, input: DrawInput, volume: number, kinds: DayPlan['kinds']): readonly PlannedSession[];
export declare function planReads(input: DrawInput, kinds: DayPlan['kinds'], sessions: readonly PlannedSession[]): ReadPlan;
export declare function probationOwed(lastMutationAt: number | null, sessionStartAt: number,
  windowOf: (t: number) => { readonly startsAt: number; readonly endsAt: number }): boolean;
  // owed ⇔ sessionStartAt − lastMutationAt ≥ one plan-day length ∨ a complete plan-day lies strictly between (§9.11)
export declare function drawDayPlan(input: DrawInput): DayPlan;                                  // pure; ends with applyBoost
export declare function replanRemainder(prev: DayPlan, input: DrawInput, now: number, used: UsageTally, cause: ReplanCause): DayPlan;
  // keeps proration; Σ future ≤ the kept remainder; ends with applyBoost (law L13 for every cause)
export declare function applyBoost(prev: DayPlan, input: DrawInput, now: number, used: UsageTally): DayPlan;
  // inserts the act-now session only when input.runIntent === 'running' (§8.3); never grows Σ future budgets

// ── src/kernel/derive-reads.ts (amended D6; PC) ────────────────────────────────────────
export interface ReadDemand {
  readonly dailyHardCeiling: number; readonly dailyPlanSize: number; readonly sessionsPerDayMax: number;
  readonly checksPerDayMax: number;                            // replaces followbackSweepHours
  readonly censusPagesMax: number;                             // bounded by CENSUS_POLICY.maxWalkPages; LIST_WALK_MAX_PAGES when the header is unknown
  readonly frontierPages: number;                              // (1 + sessionsPerDayMax) × FRONTIER_PAGES_MAX
}
export interface ReadAllowance {
  readonly profiles: number; readonly verifyReserve: number; readonly explorationProfiles: number;
  readonly listPages: number; readonly explorationPages: number; readonly notifications: number;
}                                                              // enforced per plan-day AND over any trailing 24 h (§3 deviation 3)
export declare function deriveReadAllowance(d: ReadDemand): ReadAllowance;
export declare function checksPerDayMax(intent: PlanIntent): number;          // spacing = the slower of override and derived
export declare function censusPagesMax(header: PlanDemand['ownHeader'], rowsPerPage: number | null, fallbackRows: number): number;
export declare function censusWalkMax(session: { readonly remainingMs: number; readonly tempo: SessionTempo }): number;
export declare function frontierPages(sessionsPerDayMax: number): number;

// ── src/kernel/tempo/{keys,specs,resolve,motion,source,pending}.ts (F2a) ───────────────
export const TEMPO_KEYS = [
  'gap.action', 'gap.accept', 'dwell.visit', 'dwell.before-press', 'ui.step-pause', 'drawer.close-settle',
  'scroll.wait.drawer', 'scroll.wait.dialog', 'scroll.wait.acquire', 'scroll.depth.drawer', 'scroll.depth.dialog',
  'walk.page', 'walk.rest', 'walk.rest-every', 'pause.retry', 'pause.wake-settle', 'pause.after-task',
  'park.blocked', 'backoff.walled', 'beat.transient', 'check.spacing',
  'motion.travel', 'motion.press', 'motion.pre-press', 'motion.hover-settle',
  'wheel.tick-pause', 'wheel.micro-pause', 'wheel.correction-pause',
] as const;                                                    // 28; 'pause.after-task' leaves in S2b
export type TempoKey = (typeof TEMPO_KEYS)[number];
export type TempoAxis = 'pace' | 'pace-up' | 'motion' | 'depth';   // pace-up = max(1, pace): never shorter than the prior
export type Prior =
  | { readonly shape: 'band'; readonly min: number; readonly max: number }
  | { readonly shape: 'logn'; readonly median: number; readonly sigma: number; readonly min: number; readonly max: number }
  | { readonly shape: 'mix'; readonly p: number; readonly base: Prior; readonly alt: Prior }
  | { readonly shape: 'scale'; readonly value: number; readonly spread: number }   // viewports
  | { readonly shape: 'base'; readonly value: number }
  | { readonly shape: 'pages'; readonly min: number; readonly max: number }        // walk.rest-every
  | { readonly shape: 'relative'; readonly lo: number; readonly hi: number }       // pause.retry: [0.7, 1.45] × the call site's D4 base
  | { readonly shape: 'travel' }                                                  // MOTION Fitts terms
  | { readonly shape: 'gap' };                                                    // resolved from SessionTempo.gap
export type Floor =
  | { readonly kind: 'latency'; readonly op: 'hydration' | 'notifications' | 'fetchEnvelope' | 'acceptRow' | 'probe' }
  | { readonly kind: 'display' } | { readonly kind: 'prior-min' } | { readonly kind: 'equals-prior' }
  | { readonly kind: 'poll' }                                                      // the call site's pollEveryFor(op)
  | { readonly kind: 'boundary' } | { readonly kind: 'px'; readonly px: number } | { readonly kind: 'pages'; readonly pages: number }
  | { readonly kind: 'caution-floor' };
export type Identity =
  | { readonly registry: readonly string[] } | { readonly motion: readonly string[] }
  | { readonly added: '0607'; readonly from: string };
export interface TempoSpec { readonly axis: TempoAxis; readonly prior: Prior; readonly floor: Floor; readonly identity: Identity }
export declare const TEMPO_SPECS: { readonly [K in TempoKey]: TempoSpec };
export declare const PENDING_CONSUMERS: readonly TempoKey[];   // keys awaiting their call site; empty at Phase I
export declare function scaleAbove(value: number, floor: number, factor: number): number;
export interface Resolved { readonly key: TempoKey; readonly prior: Prior; readonly floorValue: number }
export declare function resolve(key: TempoKey, tempo: SessionTempo, overrideFactor?: number /* ∈ [1, 3] */): Resolved;
export declare function drawResolved(r: Resolved, rng: () => number): number;

export type MotionRole = 'tempo' | 'speed-accuracy' | 'shape' | 'guardrail' | 'device';
export declare const MOTION_ROLE: { readonly [K in keyof typeof MOTION]: MotionRole };   // + a guard line per shape dial
export interface MotionPolicy {                                // the widened shape of MOTION; MOTION_REFERENCE === deriveMotion(1)
  readonly [k: string]: number | readonly [number, number];
  readonly prePressMs: readonly [number, number]; readonly driftProbability: number; readonly driftPx: number;
  readonly initialCursorXPx: readonly [number, number]; readonly initialCursorYPx: readonly [number, number];
}
export declare const MOTION_REFERENCE: MotionPolicy;
export declare function deriveMotion(motionFactor: number): MotionPolicy;
  // tempo-role durations × m; speed-accuracy keys × m^(−SPEED_ACCURACY_ELASTICITY) within the guardrails; nothing else

export interface TempoSource {
  current(): SessionTempo;                                     // pure read of the tempo in force (open session or ambient)
  base(key: TempoKey): number;                                 // location at the current tempo (WaitRunner bases)
  draw(key: TempoKey): number;                                 // one draw from the key's own noise stream
  policy(key: TempoKey): { readonly kind: string; sample(rng?: () => number): number };
  gesture(): { readonly policy: MotionPolicy; readonly rng: () => number };   // resolved ONCE per gesture
  enabled(key: TempoKey): boolean;                             // false only for keys added by 0607 under the reference source
}
export declare const REFERENCE_TEMPO: SessionTempo;
export declare function referenceTempoSource(launchSeed?: number): TempoSource;   // reproduces today's values exactly

// ── src/governors/plan-view.ts (PURE; PC) ──────────────────────────────────────────────
export interface UsageTally {
  readonly all: number; readonly auto: number; readonly manual: number;
  readonly follow: number; readonly unfollow: number; readonly accept: number;
  readonly perSession: readonly number[]; readonly outside: number;
}
export type AdmitRefusal = 'session-closed' | 'kind-spent' | 'day-done' | 'ceiling' | 'hourly-cap'
  | 'deadline' | 'deferred-by-boost' | 'journal' | 'probation' | 'quiet-hours' | 'day-off' | 'unconfirmed';
export type Admission = { readonly ok: true } | { readonly ok: false; readonly reason: AdmitRefusal; readonly until: number | null };
export type SessionState = 'done' | 'partial' | 'skipped' | 'before-open' | 'now' | 'next' | 'later';
export interface PlanView {
  readonly plan: DayPlan; readonly provisional: boolean; readonly at: number; readonly window: PlanDayWindow;
  readonly sessions: readonly { readonly idx: number; readonly state: SessionState; readonly used: number;
    readonly budget: number /* effective b'_s */; readonly closesAt: number | null }[];
  readonly open: { readonly idx: number; readonly mixLeft: KindBudgets; readonly readsLeft: SessionReads;
    readonly mix: 'normal' | 'boost'; readonly probation: boolean; readonly censusHost: boolean } | null;
  readonly nextSessionAt: number | null;                       // null ⇒ parks end at window.endsAt
  readonly nextCheckAt: number | null;
  readonly used: UsageTally; readonly remaining: number; readonly R: number;
  readonly boost: BoostWindow | null;
  readonly freshSince: number;                                 // = plan.window.startsAt (display only)
  readonly tempo: SessionTempo;                                // open session's, else ambient
  admits(kind: MutationKind, writer: Writer, subject?: { pk: string; intentId?: string }): Admission;
  manualOpen(): Admission;
  checkDue(lastSweepEndedAt: number | null): boolean;          // anchored on the sweep's end (C11)
  checkLight(): boolean;                                       // Boost: own header at session start + drawer + accepts
  censusDue(census: { readonly lastCompleteAt: number | null; readonly walkPages: number }): boolean;
  acceptsAllowed(pending: number, lastHour: number): number;
  mixDraw(k: number): number | null;                           // u('mix', open.idx, k) when both kinds have work
  planDayStartAfter(k: number): number;
}
export declare function viewPlan(plan: DayPlan, inputs: {
  now: number; used: UsageTally; boost: BoostWindow | null; runIntent: 'running' | 'stopped' | 'paused';
  hourly: { lastHour: number; recentTimes: readonly number[] }; deadline: number | null; tomorrow: () => DayPlan;
  journal: { blocks(pk: string, exceptIntentId?: string): boolean };
  lastMutationBefore(t: number): number | null;                // probation (C21; replaces T1's reentryPhase)
  unconfirmed: { readonly kind: 'follow' | 'unfollow'; readonly streak: number } | null;   // §11.1 F7 breaker
  surfacePaused(a: 'unfollows' | 'exploration'): boolean;
}): PlanView;

// ── src/governors/plan-service.ts (THE writer; PC) ─────────────────────────────────────
export interface PlanStore {
  getPlanState(): string | null; setPlanState(raw: string | null): void;
  getPacingState(): string | null;                             // read once for the phase migration (legacy key, then cleared)
  tallySince(since: number): Omit<UsageTally, 'perSession' | 'outside'>;
  recentMutationTimes(since: number): readonly number[];
  hasAnyMutation(): boolean;                                   // upgrade probation for any install with a ledger
}
export interface PlanServiceDeps {
  store: PlanStore; clock: { now(): number }; installEntropy: number; launchSeed: number;
  intent(): PlanIntent; demand(window: PlanDayWindow, now: number): PlanDemand;
  lastMutationBefore(t: number): number | null;
  outsideSince(since: number): number;                         // increases only (§9.10)
  deadline(): number | null; journal: { blocks(pk: string, exceptIntentId?: string): boolean };
  runIntent(): 'running' | 'stopped' | 'paused';
  unconfirmed(): { readonly kind: 'follow' | 'unfollow'; readonly streak: number } | null;
  surfaceGate: { paused(a: 'unfollows' | 'exploration'): boolean };
  onChanged?(view: PlanView, cause: ReplanCause): void;
}
export declare class PlanService {
  constructor(deps: PlanServiceDeps);
  view(now?: number): PlanView;                                // PURE
  ensure(now?: number): PlanView;                              // THE writer; writes only on a §5.6 cause
  onSettings(now?: number): PlanView;                          // digest check
  onDemand(now?: number): PlanView;                            // census completed
  startBoost(durationMs: number, now?: number): PlanView;      // window + re-plan in one setPlanState
  endBoost(reason: 'user', now?: number): PlanView;
  previewBoost(hours: number, now?: number): BoostPreview;     // pure: applyBoost on a copy (§8.5)
  nextEdgeAt(now?: number): number;
  tempo(): TempoSource;
  planDayClock(): PlanDayClock;
  dayStart(): number;                                          // the RateGovernor's provider
  previewDays(intent: PlanIntent, at: number, days: number): readonly PlanPreviewDay[];   // the PlanPreviewPort (C6)
}
export interface PlanStateV1 { readonly v: 1; readonly phaseOffsetHours: number; readonly plan: DayPlan | null;
  readonly boost: BoostWindow | null; readonly upgradeProbation: boolean }

// ── src/main/services/mutation-cadence.ts (PR) ─────────────────────────────────────────
export interface MutationCadence {
  preflight(kind: MutationKind, writer: Writer, now: number, subject?: { pk: string; intentId?: string }): Admission;   // no I/O; BEFORE the visit
  armAtDispatch(kind: MutationKind, writer: Writer, now: number, subject?: { pk: string; intentId?: string }): number; // re-check + draw + persist
  acceptPassEnded(now: number): number;
  manualOpen(now: number): Admission;
}
// adapter/errors.ts: class ActionDeferredError { constructor(msg: string, opts?: { reason?: AdmitRefusal | string; until?: number | null }) }

// ── src/engine/plan-port.ts (replaces EnginePacing; EngineRate shrinks) ────────────────
export interface EngineRate { atHardCeiling(): boolean; actionsToday(): number; actionsInLastHour(): number }
export interface EnginePlan { view(now: number): PlanView; ensureIfProvisional(now: number): PlanView; wake(): void }
export interface PlanFacts {                                   // the `pacing` fact group's new type (group name kept)
  readonly sessionOpen: boolean;
  readonly park: { readonly key: 'engine:session-park' | 'engine:daily-ceiling-park' | 'engine:velocity-park' | 'engine:read-budget-park';
    readonly until: number } | null;
  readonly admits: { readonly follow: boolean; readonly unfollow: boolean; readonly accept: boolean; readonly explore: boolean };
  readonly mix: 'normal' | 'boost'; readonly probation: boolean;
  readonly reads: { readonly exploreLeft: number; readonly reconcileLeft: number };
  readonly checkDue: boolean; readonly checkLight: boolean; readonly censusDue: boolean;
}

// ── src/rim/ig-activity-clock.ts (PR S2b) ──────────────────────────────────────────────
export interface IgActivityClock {
  lastEndAt(): number | null;
  noteEnd(at: number): void;
  spaceEntry(signal?: AbortSignal): Promise<void>;             // wait lastEnd + draw(dwell.visit) − now
}

// ── src/governors/read-budget.ts (amended; PR) ─────────────────────────────────────────
export interface ReadDebit { at: number; kind: ReadKind; purpose: 'exploration' | 'reconciliation'; count: number; use?: ReadUse }
export interface ReadLimits {
  readonly allowance: ReadAllowance; readonly window: { readonly startsAt: number; readonly endsAt: number };
  readonly backstopMs: number;                                  // trailing window = 24 h (§3 deviation 3)
  readonly explore: { readonly profiles: number; readonly pages: number };   // plan sub-limit
}
// consume(kind, use, count): purpose = use === 'explore' ? 'exploration' : 'reconciliation';
// refuses when the plan-day total OR the trailing-24 h total would pass the allowance; resumeAt = max(boundary, trailing expiry)
```

Boost types (`BoostView`, `BoostPreview`, `BoostCommandResult`) are §8.5; `PlanProjection` and `paceLabel` are §5.17.

---

## Appendix B — Settings and protection contracts, Settings copy (normative)

Reconciled from T2 §13 and §18 with §14 (C6, C12, C13, C16, C17, C18, C19) and revision 2. Section numbers inside
refer to this document. Where a line here and §1–§24 disagree, §1–§24 win; report the conflict to the lead.

### B.1 Shared vocabulary and model (`src/shared/settings-intent.ts`, `settings-model.ts`; pure, no imports)

```ts
// --- src/shared/settings-intent.ts --------------------------------------------------------------
export const ACTIVITY_LEVELS = ['minimal', 'light', 'moderate', 'active', 'aggressive'] as const;
export const CAUTIONS = ['cautious', 'standard', 'bold'] as const;
export const RHYTHMS = ['trickle', 'sessions', 'bursts'] as const;
export const CONSISTENCIES = ['clockwork', 'natural', 'erratic'] as const;
export const DAY_SHAPES = ['balanced', 'morning', 'evening', 'nightowl', 'business'] as const;
export const WEEKLY_SHAPES = ['realistic', 'uniform', 'weekdays', 'weekends'] as const;
export const PATIENCES = ['quick', 'normal', 'patient'] as const;
export const CLEANUP_LEVELS = ['off', 'trickle', 'steady'] as const;   // kernel 'deep' retired (≡ steady via the 0.5 bound, U04 H3)
export const MUTUAL_POLICIES = ['rotate', 'keep'] as const;
export const AUDIENCE_FOCUSES = ['likely', 'wide'] as const;
export const AUDIENCE_SIZES = ['small', 'everyday', 'larger'] as const;
export type ActivityLevel = (typeof ACTIVITY_LEVELS)[number];
export type Caution = (typeof CAUTIONS)[number];
export type Rhythm = (typeof RHYTHMS)[number];
export type Consistency = (typeof CONSISTENCIES)[number];
export type DayShape = (typeof DAY_SHAPES)[number];
export type WeeklyShape = (typeof WEEKLY_SHAPES)[number];
export type Patience = (typeof PATIENCES)[number];
export type CleanupLevel = (typeof CLEANUP_LEVELS)[number];
export type MutualPolicy = (typeof MUTUAL_POLICIES)[number];
export type AudienceFocus = (typeof AUDIENCE_FOCUSES)[number];
export type AudienceSize = (typeof AUDIENCE_SIZES)[number];
/** Sun..Sat — the kernel's weeklyWeights order. The UI renders Mon-first. */
export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export const MAX_DAYS_OFF = 6;                     // seven days off is Stop, not a plan (SETTINGS_POLICY.MAX_DAYS_OFF)

/** Local wall-clock minutes in [0,1440) on the 30-minute grid; may wrap midnight; start ≠ end. */
export type QuietHours =
  | { readonly kind: 'derived' }
  | { readonly kind: 'custom'; readonly startMinute: number; readonly endMinute: number }
  | { readonly kind: 'none' };

/** The plain choices. Every field is a plan or engine INPUT; none is a timing (A2). */
export interface Intent {
  readonly activity: ActivityLevel;
  readonly caution: Caution;
  readonly rhythm: Rhythm;
  readonly consistency: Consistency;
  readonly dayShape: DayShape;
  readonly weeklyShape: WeeklyShape;
  readonly quietHours: QuietHours;
  readonly daysOff: readonly DayOfWeek[];
  readonly patience: Patience;
  readonly mutuals: MutualPolicy;
  readonly cleanup: CleanupLevel;
  readonly audienceFocus: AudienceFocus;
  readonly audienceSize: AudienceSize;
  readonly preferPrivate: boolean;
}
export type IntentKey = keyof Intent;
export const INTENT_KEYS: readonly IntentKey[];

/** Easy pace cards → ordinals (product vocabulary, not numbers). */
export type PaceCardId = 'gentle' | 'balanced' | 'faster';
export const PACE_CARDS: Readonly<Record<PaceCardId, { readonly activity: ActivityLevel; readonly caution: Caution }>>;
// = { gentle: {light, cautious}, balanced: {moderate, standard}, faster: {active, standard} }

// --- src/shared/settings-model.ts ---------------------------------------------------------------
export interface ProtectedAccount {
  readonly pk: string | null;
  readonly username: string;                 // normalized: trimmed, no '@', lowercase
  readonly linkedAt: number | null;          // pk↔username confirmed together → match by pk ONLY
  readonly formerUsernames: readonly string[];   // display only
  readonly addedAt: number;
  readonly source: 'you' | 'migrated' | 'older-version' | 'prune-page';
  readonly valid: boolean;                   // false: not a handle (migrated, kept, never dropped)
}
export interface KeepWord { readonly text: string; readonly addedAt: number }
export interface ProtectionSettings {
  readonly accounts: readonly ProtectedAccount[];
  readonly words: readonly KeepWord[];
  readonly wordMatch: 'anywhere' | 'whole-word';
  readonly keepVerified: boolean;
}
export type ProtectionState = 'ready' | 'needs-review' | 'unavailable';
export interface Prefs {
  readonly practice: boolean;                // engine name: dryRun
  readonly acceptRequests: boolean;          // engine name: autoAcceptFollowRequests
  readonly boost: { readonly hours: number; readonly acceptRequests: boolean };
}
export interface RatioCurve { readonly hardLow: number; readonly bandLow: number; readonly peakLow: number;
  readonly peakHigh: number; readonly bandHigh: number; readonly hardHigh: number }
export type ParamValue = number | boolean | { readonly min: number; readonly max: number } | RatioCurve;
```

`tests/settings/intent-vocabulary.test.ts` asserts that each tuple equals the kernel's keys as a set (`SCALES.*`,
`PREFERENCES.*`, `'balanced'`/`'realistic'`). For cleanup the tuple is the kernel keys minus `deep`. The kernel
stays the source of meaning; `src/shared` stays import-free, which adds no boundary edge.

### B.2 The persisted document (`src/settings/doc.ts`, main only; coercion in `doc-rules.ts`, ADR 0103 style)

```ts
export interface SettingsDocV2 {
  readonly v: 2;
  readonly rev: number;                                          // +1 on every persisted write
  readonly intent: Intent;
  readonly seed: string;                                         // '' = none
  readonly overrides: Readonly<Partial<Record<ParamKey, OverrideEntry>>>;
  readonly protection: ProtectionSettings;
  readonly protectionState: ProtectionState;                     // persisted: a review survives restart
  readonly prefs: Prefs;
  readonly app: { readonly mode: 'easy' | 'advanced'; readonly tourCompletedAt: number | null;
                  readonly tourVersionSeen: string | null; readonly dismissedNotices: readonly string[] };
  readonly migration: MigrationRecord | null;
  /** @transitional — deleted by PR S2 together with every reader (§5.13); migrate-v1 then maps legacy pacing itself. */
  readonly legacyCarry: LegacyCarry | null;
}
export interface OverrideEntry { readonly value: ParamValue; readonly setAt: number; readonly basis: ParamValue }
export interface MigrationRecord {
  readonly at: number;
  readonly fromV1: { readonly mtimeMs: number; readonly sha256: string } | null;
  readonly notes: readonly MigrationNote[];
  readonly bookkeeping: { readonly forPk: string | null; readonly sweepLastRunAt: number | null;
                          readonly sweepIntervalFactor: number | null; readonly pruneLastRunAt: number | null } | null;
}
export type MigrationNote =
  | { readonly kind: 'bio-words-widened'; readonly words: number }
  | { readonly kind: 'verified-kept' }
  | { readonly kind: 'quiet-hours-derived' } | { readonly kind: 'quiet-hours-from-active-hours'; readonly start: number; readonly end: number }
  | { readonly kind: 'cleanup-own-follows-off' } | { readonly kind: 'cleanup-scheduled-now-gradual' }
  | { readonly kind: 'value-clamped'; readonly key: ParamKey; readonly from: number; readonly to: number }
  | { readonly kind: 'list-items-dropped'; readonly list: 'accounts' | 'words'; readonly count: number }
  | { readonly kind: 'legacy-pacing-retired' }
  | { readonly kind: 'cleanup-trickle-from-schedule' }                         // off + a schedule → 'trickle' (§6.10)
  | { readonly kind: 'faster-value-dropped'; readonly key: 'pruneScan' | 'gapTypical' | 'gapMinimum' | 'checksEveryHours'; readonly from: number };
export interface LegacyCarry {
  readonly pacingModel: 'legacy' | 'organic';
  readonly minDelayMinutes: number; readonly maxDelayMinutes: number; readonly jitterPercent: number;
  readonly activeHoursStart: number; readonly activeHoursEnd: number;
}   // pruneScan* are not carried: they map to a slower-only tempo.walk.page override at migration (§6.10)
export const RECOMMENDED_INTENT: Intent;   // balanced ordinals; quietHours derived; daysOff []; patience normal;
                                           // mutuals rotate; cleanup off; likely; everyday; preferPrivate true
export const DEFAULT_DOC: SettingsDocV2;
```

### B.3 What the engine consumes (`src/settings/effective.ts`)

`EffectiveSettings` is a flat record that keeps today's v1 field names wherever the meaning is unchanged. The
`toXConfig` mappers (moved to `src/settings/mappers.ts`) and engine call sites therefore barely move. There is **no**
alias: the old renderer keeps the frozen v1 `Settings` interface until SU deletes it (§6.9).

```ts
export interface EffectiveSettings {
  seed: string;
  // scorer
  bandLow: number; bandHigh: number; peakLow: number; peakHigh: number; hardLow: number; hardHigh: number;
  minFollowers: number; maxFollowers: number; privateBoost: number;
  mutualWeight: number; mutualCap: number; bandEdgeScore: number;          // today SCORER_DEFAULTS → SETTINGS_POLICY
  // lifecycle
  maxWaitForFollowbackDays: number; holdAfterFollowbackDays: number; rotateMutuals: boolean; maxRetries: number;
  autoAcceptFollowRequests: boolean;
  // plan inputs (toPlanIntent reads these)
  pattern: OrdinalPattern;                                                   // intent ordinals + cleanup
  dailyOperatingRate: number; dailyHardCeiling: number; dailyPlanSize: number;
  dailyVolumeVariancePct: number; restDayChancePct: number;
  sessionsPerDayMin: number; sessionsPerDayMax: number;
  gapMedianSeconds: number; gapFloorSeconds: number;                          // the reference shape (internal)
  gapTargetOverrideSeconds: number | null; gapFloorOverrideSeconds: number | null;   // effective scale, slower only (§5.10)
  hourlyVelocityCap: number;
  quietHours: { readonly startMinute: number; readonly endMinute: number } | null;   // resolved
  daysOff: readonly DayOfWeek[];                                             // ≤ 6
  checkSpacingHoursOverride: number | null; cleanupPerDayOverride: number | null; censusEveryDaysOverride: number | null;
  tempoOverrides: Readonly<Partial<Record<TempoKey, number>>>;               // factors ∈ [1, 3]
  // cleanup (own follows)
  weaveEnabled: boolean; maxUnfollowFractionPerSession: number;
  // exploration
  lowWaterCandidates: number; minFollowBackRate: number; minPoolSize: number;
  // prefs
  dryRun: boolean;
  boost: { readonly hours: number; readonly acceptRequests: boolean };
  /** @transitional (PR S2 deletes with the pacer) */
  pacingModel: 'legacy' | 'organic'; minDelayMinutes: number; maxDelayMinutes: number; jitterPercent: number;
  activeHoursStart: number; activeHoursEnd: number;
  /** @transitional (UD's last commit deletes once every unfollow path reads ProtectionPort) */
  pruneWhitelist: string[]; pruneBioFilterWords: string[];
  /** @transitional: derived from the v2 doc so today's consumers keep running; deleted with their consumers */
  followbackSweepHours: number;                                              // RO-b: the sweep cadence moves to plan checks
  pruneDailyLimit: number; pruneScheduleDays: number;                        // PR S2: prune daily plan and scheduled prune deleted
  pruneScanMinSeconds: number; pruneScanMaxSeconds: number;                  // PR S2: walk.page tempo
}
```

### B.4 Parameters, view and previews (`src/shared/settings-params.ts`, `settings-view.ts`)

```ts
// --- src/shared/settings-params.ts --------------------------------------------------------------
export const T2_PARAM_KEYS = [
  'pace.dailyVolume', 'pace.dailyCeiling', 'pace.hourlyCap', 'pace.dayVariation', 'pace.restDayChance',
  'pace.candidateBuffer',
  'sessions.perDayMin', 'sessions.perDayMax', 'sessions.gapTypical', 'sessions.gapMinimum',
  'unfollow.waitDays', 'unfollow.holdDays', 'unfollow.cleanupShare', 'unfollow.cleanupPerDay',
  'unfollow.censusEveryDays', 'unfollow.attempts', 'checks.everyHours',
  'audience.followerRange', 'audience.ratioCurve', 'audience.privateBoost', 'audience.mutualWeight',
  'audience.mutualCap', 'audience.bandEdgeScore',
  'explore.moveOnRate', 'explore.moveOnPool', 'explore.refillBelow',
] as const;
/** F2b lands it generated from TEMPO_KEYS minus 'gap.action' and 'check.spacing'; SC owns it afterwards. */
import { TEMPO_PARAM_KEYS } from './settings-params-tempo';
export { TEMPO_PARAM_KEYS };
export type ParamKey = (typeof T2_PARAM_KEYS)[number] | (typeof TEMPO_PARAM_KEYS)[number];
export type SectionId = 'pace' | 'schedule' | 'audience' | 'unfollow' | 'protection' | 'boost' | 'app'
  | 'timing' | 'explore' | 'limits' | 'technical' | 'diagnostics';
export const EASY_SECTIONS: readonly SectionId[];          // first seven, in order
export type ParamKind = 'int' | 'number' | 'range' | 'curve' | 'bool';
export type ParamUnit = 'per-day' | 'per-hour' | 'percent' | 'count' | 'seconds' | 'ms' | 'hours' | 'days'
  | 'share' | 'ratio' | 'followers' | 'factor';
export type ParamRisk = 'higher-is-riskier' | 'lower-is-riskier' | 'neutral';
export type ApplyWhen = 'now' | 'replan' | 'next-day' | 'next-start';
export const RISK_LEVELS = ['low', 'standard', 'elevated', 'at-limit'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

// --- src/shared/settings-view.ts ----------------------------------------------------------------
export interface SettingsCapabilities {
  readonly plan: boolean; readonly tempo: boolean; readonly boost: boolean; readonly protectionEverywhere: boolean;
}
export type SettingsHealth =
  | { readonly kind: 'ok' } | { readonly kind: 'migrated'; readonly at: number }
  | { readonly kind: 'restored-from-backup'; readonly quarantined: string }
  | { readonly kind: 'remigrated-from-v1'; readonly quarantined: string | null }
  | { readonly kind: 'defaults-after-unreadable'; readonly quarantined: string | null }
  | { readonly kind: 'migration-refused'; readonly detail: string };

export interface SettingsView {
  readonly rev: number;
  readonly health: SettingsHealth;
  readonly capabilities: SettingsCapabilities;
  readonly mode: 'easy' | 'advanced';
  readonly intent: Intent;
  readonly seed: string;
  readonly protection: ProtectionSettings;
  readonly protectionState: ProtectionState;
  readonly prefs: Prefs;
  readonly easy: EasyMatch;
  readonly options: OptionPreviews;              // numbers for every choice (instant hover, no IPC)
  readonly typical: TypicalDay;
  readonly params: readonly ParamView[];          // every ParamKey whose capability is on
  readonly reads: ReadAllowanceView;              // D6, read-only
  readonly overrides: { readonly count: number; readonly stale: number;
                        readonly bySection: Readonly<Partial<Record<SectionId, number>>> };
  readonly effective: EffectiveSummary;          // what OTHER views may read (below)
  readonly notices: readonly SettingsNotice[];
  readonly app: { readonly tourCompletedAt: number | null; readonly tourVersionSeen: string | null };
}

export interface EasyMatch {
  readonly pace: PaceCardId | 'custom';
  readonly size: AudienceSize | 'custom';         // custom ⇔ audience.followerRange override
  readonly focus: AudienceFocus | 'custom';       // custom ⇔ audience.ratioCurve override
  readonly quietHours: { readonly startMinute: number; readonly endMinute: number } | null;
}
export type Feasibility =
  | { readonly kind: 'ok'; readonly reachablePerDay: number }
  | { readonly kind: 'short'; readonly reachablePerDay: number; readonly binding: 'hourly-cap' | 'active-time' };
export interface DayNumbers { readonly typical: number; readonly low: number; readonly high: number }
export interface PaceOption { readonly id: PaceCardId | ActivityLevel; readonly perDay: DayNumbers;
  readonly perHourMax: number; readonly shareOfLowWall: number; readonly risk: RiskLevel; readonly feasibility: Feasibility }
export interface ScheduleOption { readonly dayShape: DayShape; readonly intensity: readonly number[];   // 24 hourly λ, 0..1
  readonly quiet: { readonly startMinute: number; readonly endMinute: number } | null; readonly feasibility: Feasibility }
export interface OptionPreviews {
  readonly paceCards: readonly PaceOption[];                                  // gentle, balanced, faster (Easy shows perDay only)
  readonly activity: Readonly<Record<ActivityLevel, PaceOption>>;
  readonly caution: Readonly<Record<Caution, { readonly hourlyCap: number; readonly minGapSeconds: number }>>;
  readonly rhythm: Readonly<Record<Rhythm, { readonly sessions: { readonly min: number; readonly max: number }; readonly gapSeconds: number }>>;
  readonly consistency: Readonly<Record<Consistency, { readonly variationPct: number; readonly restDayPct: number }>>;
  readonly schedule: readonly ScheduleOption[];
  readonly patience: Readonly<Record<Patience, { readonly waitDays: number; readonly holdDays: number }>>;
  readonly cleanup: Readonly<Record<CleanupLevel, { readonly share: number }>>;
  readonly size: Readonly<Record<AudienceSize, { readonly min: number; readonly max: number }>>;
  readonly focus: Readonly<Record<AudienceFocus, RatioCurve>>;
  readonly boostHours: { readonly choices: readonly number[]; readonly min: number; readonly max: number };
}
export interface TypicalDay {
  readonly perDay: DayNumbers;                       // the day law's p10 / median / p90 (§5.4), never median·e^{±zσ}
  readonly automaticMax: number;                     // automaticDayMax(P0)
  readonly ceiling: number; readonly perHourMax: number;   // perHourMax is shown in Advanced only
  readonly sessions: { readonly min: number; readonly max: number };
  readonly shareOfLowWall: number; readonly risk: RiskLevel; readonly feasibility: Feasibility;
  readonly week: readonly PlanPreviewDay[] | null;                            // capabilities.plan
}
export interface PlanPreviewDay { readonly dayKey: string; readonly startAt: number; readonly endAt: number;
  readonly restDay: boolean; readonly dayOff: boolean; readonly total: number; readonly follows: number;
  readonly unfollows: number; readonly sessions: readonly { readonly startAt: number; readonly endAt: number; readonly budget: number }[] }

export interface ParamView {
  readonly key: ParamKey; readonly section: SectionId; readonly kind: ParamKind; readonly unit: ParamUnit;
  readonly step: number;
  readonly value: ParamValue;                    // effective
  readonly recommended: ParamValue;              // derived from intent + effective upstreams
  readonly override: { readonly requested: ParamValue; readonly setAt: number; readonly clamped: boolean;
                       readonly stale: boolean; readonly basis: ParamValue } | null;
  readonly bounds: ParamBounds;
  readonly risk: ParamRisk;
  readonly applies: ApplyWhen;
  readonly source: 'derived' | 'recommended' | 'plan';
  readonly inactive: 'mutuals-kept' | 'cleanup-off' | null;
  readonly provenance: readonly ProvenanceStep[];
}
export type ParamBounds =
  | { readonly kind: 'number' | 'range' | 'curve'; readonly min: number; readonly max: number } | { readonly kind: 'bool' };
export type ProvenanceStep =
  | { readonly kind: 'fundamental'; readonly key: string; readonly value: number; readonly unit: string; readonly rev: string }
  | { readonly kind: 'policy'; readonly key: string; readonly value: number }
  | { readonly kind: 'choice'; readonly intent: IntentKey; readonly value: string }
  | { readonly kind: 'param'; readonly key: ParamKey; readonly value: number }
  | { readonly kind: 'op'; readonly op: 'times' | 'divide' | 'round' | 'ceil' | 'min' | 'max' };
export interface ReadAllowanceView { readonly profiles: number; readonly explorationProfiles: number;
  readonly listPages: number; readonly explorationPages: number; readonly notifications: number;
  readonly window: 'plan-day'; readonly backstop: 'trailing-24h' }
export interface BasisRow { readonly id: string; readonly group: 'fundamental' | 'policy' | 'bound' | 'derived' | 'registry' | 'motion';
  readonly value: number | string; readonly unit: string | null; readonly tier: string | null;
  readonly src: string | null; readonly rev: string | null;
  readonly module: string; readonly guard: string | null }   // the catalog of EVERY kernel tier-1 module (Under the hood; catalog.test.ts)
export type BasisResult = { readonly kind: 'ok'; readonly rows: readonly BasisRow[] } | { readonly kind: 'unavailable' };
export interface EffectiveSummary {
  readonly seed: string; readonly practice: boolean; readonly acceptRequests: boolean;
  readonly waitDays: number; readonly holdDays: number | null;            // null = people who follow back are kept
  readonly dailyVolume: number; readonly dailyCeiling: number; readonly hourlyCap: number;
  readonly quietHours: { readonly startMinute: number; readonly endMinute: number } | null;
  readonly daysOff: readonly DayOfWeek[]; readonly cleanup: CleanupLevel; readonly boostDefaultHours: number;
}
export interface SettingsNotice { readonly id: string; readonly tone: 'info' | 'warning' | 'error';
  readonly kind: MigrationNote['kind'] | 'migrated' | 'restored-backup' | 'unreadable-defaults' | 'needs-review'
    | 'older-version-changed' | 'override-stale' | 'everything-in-advanced' | 'migration-refused';
  readonly data: Readonly<Record<string, string | number>>; readonly dismissible: boolean }
```

### B.5 Ops and results (`src/shared/settings-ops.ts`)

```ts
type IntentOp = { [K in IntentKey]: { readonly op: 'intent'; readonly key: K; readonly value: Intent[K] } }[IntentKey];
export type SettingsOp =
  | IntentOp
  | { readonly op: 'override'; readonly key: ParamKey; readonly value: ParamValue }
  | { readonly op: 'clear-override'; readonly key: ParamKey }
  | { readonly op: 'seed'; readonly handle: string }                                   // '' clears
  | { readonly op: 'protect-add'; readonly entries: readonly { readonly username: string; readonly pk?: string }[];
      readonly source: ProtectedAccount['source'] }
  | { readonly op: 'protect-remove'; readonly match: { readonly pk?: string; readonly username?: string } }
  | { readonly op: 'protect-restore'; readonly accounts: readonly ProtectedAccount[]; readonly words: readonly KeepWord[] }
  | { readonly op: 'word-add'; readonly texts: readonly string[] }
  | { readonly op: 'word-remove'; readonly text: string }
  | { readonly op: 'protect-rule'; readonly rule: 'keepVerified'; readonly value: boolean }
  | { readonly op: 'protect-rule'; readonly rule: 'wordMatch'; readonly value: 'anywhere' | 'whole-word' }
  | { readonly op: 'protect-link'; readonly pk: string; readonly username: string; readonly at: number }   // system only
  | { readonly op: 'pref'; readonly key: 'practice' | 'acceptRequests' | 'boost.acceptRequests'; readonly value: boolean }
  | { readonly op: 'pref'; readonly key: 'boost.hours'; readonly value: number }
  | { readonly op: 'ui'; readonly mode: 'easy' | 'advanced' }
  | { readonly op: 'tour-completed'; readonly at: number }
  | { readonly op: 'dismiss-notice'; readonly id: string }
  | { readonly op: 'acknowledge-protection' }                                            // needs-review/unavailable → ready
  | { readonly op: 'import-older-version' }                                              // union only
  | { readonly op: 'migration'; readonly action: 'retry' | 'start-from-recommended' | 'remigrate-from-v1' }   // recovery (§6.10, §6.6)
  | { readonly op: 'consume-bookkeeping' }                                               // system only
  | { readonly op: 'reset'; readonly scope: { readonly kind: 'recommended' } | { readonly kind: 'section'; readonly section: SectionId } };

export type SettingsSaveResult =
  | { readonly kind: 'saved'; readonly view: SettingsView; readonly adjustments: readonly Adjustment[];
      readonly conflicts: readonly OverrideConflict[]; readonly applies: readonly ApplyNote[];
      readonly inverse: readonly SettingsOp[] }
  | { readonly kind: 'not-saved'; readonly view: SettingsView; readonly detail: string }      // NOTHING changed
  | { readonly kind: 'refused'; readonly view: SettingsView;
      readonly reason: 'invalid' | 'internal' | 'migration-pending' | 'protection-not-migrated'; readonly detail: string };
export interface Adjustment {
  readonly key: ParamKey | IntentKey | 'seed' | 'protection' | 'prefs.boost.hours';
  readonly requested: unknown; readonly applied: unknown;
  readonly because: 'above-safe-max' | 'below-safe-min' | 'kept-order' | 'coupled-bound' | 'not-an-option' | 'normalized';
}
export interface OverrideConflict { readonly key: ParamKey; readonly yours: ParamValue;
  readonly recommendedBefore: ParamValue; readonly recommendedNow: ParamValue }
export interface ApplyNote { readonly what: 'applies-now' | 'replanned-today' | 'from-tomorrow' | 'after-restart'
  | 'records-kept' | 'records-released'; readonly count?: number }
export type SettingsPreviewResult =
  | { readonly kind: 'ok'; readonly view: SettingsView; readonly changes: readonly ChangeLine[];
      readonly conflicts: readonly OverrideConflict[]; readonly adjustments: readonly Adjustment[] }
  | { readonly kind: 'unavailable' };
export interface ChangeLine { readonly key: ParamKey | IntentKey | 'seed' | 'prefs.practice';
  readonly before: string | number | boolean; readonly after: string | number | boolean; readonly loosensUnfollows: boolean }
```

- The ops in one call apply **atomically**, in order: all of them persist, or none.
- Coercion never rejects a value. A value that is the wrong *shape* is stopped by the guard.
- `protect-link` and `consume-bookkeeping` are refused when `origin === 'user'`.
- While a migration was refused, every op except `migration` and `ui` is refused with `migration-pending`;
  `acknowledge-protection` is refused with `protection-not-migrated` until a migration succeeded (§6.10).

### B.6 Facts projection (`src/shared/settings-facts.ts`, `src/shared/seed-check.ts`)

```ts
export interface SettingsFacts {
  readonly built: boolean;                        // false before the store opens: every field honest-unknown
  readonly seed: SeedStatus;
  readonly ownAccount: { readonly isPrivate: boolean | null };
  readonly protection: ProtectionFacts | null;
  readonly cleanup: { readonly census: { readonly at: number; readonly candidates: number; readonly protectedAmong: number;
                                         readonly verifiedComplete: boolean; readonly tooLarge: boolean } | null } | null;
}
export interface ProtectionFacts {
  readonly followingKnown: number | null;         // accounts Epo has seen you follow (active edges)
  readonly protectedFollowing: number;
  readonly byRule: { readonly account: number; readonly verified: number; readonly bioWord: number };
  readonly byWord: Readonly<Record<string, number>>;        // folded word → count
  readonly bioUnread: number;                     // followed accounts with no stored bio
  readonly entries: Readonly<Record<string, { readonly status: 'linked' | 'not-seen' | 'not-followed' | 'invalid';
    readonly currentUsername: string | null; readonly youFollow: boolean | null; readonly followsYou: boolean | null }>>;
  readonly kept: { readonly total: number; readonly unreadable: number };
}
export type SeedStatus =
  | { readonly kind: 'none' } | { readonly kind: 'loading' }
  | { readonly kind: 'unseen'; readonly handle: string }
  | { readonly kind: 'seen'; readonly handle: string; readonly pk: string; readonly currentUsername: string;
      readonly observedAt: number; readonly followers: number | null; readonly isPrivate: boolean | null;
      readonly followersVisible: boolean | null }
  | { readonly kind: 'checking'; readonly handle: string }
  | { readonly kind: 'queued'; readonly handle: string; readonly why: SeedQueueReason }
  | { readonly kind: 'gone'; readonly handle: string; readonly at: number; readonly evidence: 'profile-absent' | 'page-text' };
export interface AccountSuggestion { readonly pk: string; readonly username: string; readonly youFollow: boolean;
  readonly followsYou: boolean | null; readonly isVerified: boolean | null; readonly followers: number | null;
  readonly protected: boolean }
export type SuggestResult = { readonly kind: 'ok'; readonly rows: readonly AccountSuggestion[] } | { readonly kind: 'unavailable' };
export interface KeptRow { readonly pk: string; readonly username: string | null; readonly reason: string;
  readonly match: string | null; readonly keptAt: number; readonly recheckAt: number | null }
export type KeptPageResult = { readonly kind: 'ok'; readonly rows: readonly KeptRow[]; readonly total: number } | { readonly kind: 'unavailable' };
// SeedCheckResult / SeedQueueReason: §13 (src/shared/seed-check.ts; the wire keeps today's shape until SU's last commit)
```

### B.7 Kernel signatures (new tier-1/2 modules; they import only kernel siblings)

```ts
// src/kernel/settings-policy.ts — tier 1; one guard line per entry (ADR 0605 tiering)
export const SETTINGS_POLICY: {
  QUIET_INTENSITY_FRACTION: 0.2;       // λ below a fifth of the day's peak = hours a typical person rarely opens the app
  QUIET_GRID_MINUTES: 30;              // the granularity people state schedules in
  QUIET_MAX_HOURS: 16;                 // longer leaves too little active time for any pace
  TYPICAL_DAY_Z: 1.2816;               // "most days" = 10th–90th percentile of the day draw
  AUDIENCE_WIDEN_FACTOR: 1.5;          // preference: "reach more people" curve width (owner Q)
  AUDIENCE_SIZE: { small: {min:50,max:2_000}; everyday: {min:50,max:20_000}; larger: {min:50,max:100_000} };
  PRIVATE_EDGE: 0.15;                  // today's privateBoost
  RATIO_CURVE: { hardLow:0.5; bandLow:0.9; peakLow:1.0; peakHigh:1.2; bandHigh:1.5; hardHigh:3.0 };   // today's curve
  RECOMMENDED: { minPoolSize:300; lowWaterCandidates:5; mutualWeight:1.5; mutualCap:20; bandEdgeScore:0.6;   // no maxRetries: retryLimit() (C18)
                 minFollowBackRate: typeof EXPLORATION_POLICY.priorRate };   // linked, no longer a twin literal
  BOOST: { DEFAULT_HOURS:12; MIN_HOURS:1; MAX_HOURS:24; CHOICES: readonly [2,4,8,12,24];   // owner 2026-11-02; ≤ 1 plan-day
           MAX_BACKLOG_DAYS: 3 };      // a Boost waits while earlier Boosts' unfollows would take longer than this to clear
  KEEP_RECHECK_DOUBLINGS: 3;           // ≤ 1 visit per unreadable record per 8 plan-days
  TEMPO_OVERRIDE_MAX_FACTOR: 3;        // keeps the longest in-step silence under the step watchdog (law L11); overrides ≥ 1
  MAX_DAYS_OFF: 6;                     // seven days off is "Stop", not a plan; a null next session never exists
  INTERIM: { pruneDailyLimit:50; pruneScheduleDays:7; followbackSweepHours:1 };   // only until capabilities.plan (C16)
};
export const SETTINGS_GUARDS: { /* safe-side sanity bounds, the §6.5 catalog's "G" column — each with its guard line */ };
// SCORER_DEFAULTS (scorer.ts:44-57), CHAIN_DEFAULTS and the RULES fallbacks READ these — one declaration.

// src/kernel/derive-envelope.ts — tier 2
export type EnvelopeKey = 'dailyVolume' | 'dailyCeiling' | 'hourlyCap' | 'dayVariation' | 'restDayChance'
  | 'candidateBuffer' | 'sessionsMin' | 'sessionsMax' | 'gapTypical' | 'gapFloor' | 'waitDays' | 'holdDays' | 'cleanupShare'
  | 'checksEveryHours';                // ≥ 0.85 h, the briskest derived spacing; timing rows are slower-only
export const ENVELOPE: Readonly<Record<EnvelopeKey, { readonly min: number; readonly max: number }>>;  // over the grid, once
export function burstFloorSeconds(hourlyCap: number): number;          // ceil(3600 / (cap × POLICY.BURST_TOLERANCE))
export function riskRung(e: { dailyVolume: number; hourlyCap: number }): 0 | 1 | 2 | 3;   // §6.2; main maps → RISK_LEVELS
export function shareOfLowWall(automaticDayMax: number): number;      // ÷ EMPIRICAL.FOLLOW_WALL_PER_DAY.low (the true automatic maximum)
export function typicalDayRange(p: OrdinalPattern, overrides: { dailyVolume?: number }): { low: number; typical: number; high: number };
// = the day law's p10 / median / p90 (kernel/plan/volume.ts dayLawQuantiles), so Easy never promises a day above automaticDayMax

// src/kernel/derive-schedule.ts — tier 2. `DayShape`, `WeeklyShape`, `OrdinalPattern` are the kernel's own types
// (`./derive`); the kernel never imports `src/shared` — the vocabulary test (B.1) keeps both sides equal.
export interface QuietWindow { readonly startMinute: number; readonly endMinute: number }
export function deriveQuietHours(dayShape: DayShape): QuietWindow;   // weekday curve, phase 0, snapped to the grid
export function hourlyIntensity(dayShape: DayShape, weeklyShape: WeeklyShape, dow: number): number[];   // 24 values
export function sessionMassMasked(p: Pick<OrdinalPattern, 'dayShape' | 'weeklyShape'>,
  quiet: QuietWindow | null, daysOff: readonly number[]): number;     // = sessionMassHours(p) when nothing is masked
export function feasibility(i: { dailyVolume: number; hourlyCap: number; massHours: number }):
  { kind: 'ok' | 'short'; reachablePerDay: number; binding: 'hourly-cap' | 'active-time' | null };
// binding: 'hourly-cap' when raising the cap to ENVELOPE.hourlyCap.max would make the volume reachable, else 'active-time'
// (the same rule deriveOperatingPlan uses, derive.ts:527-533).

// src/kernel/derive-audience.ts — tier 2 (kernel-local curve type; structurally equal to the shared RatioCurve)
export interface AudienceCurve { readonly hardLow: number; readonly bandLow: number; readonly peakLow: number;
  readonly peakHigh: number; readonly bandHigh: number; readonly hardHigh: number }
export function audienceCurve(focus: 'likely' | 'wide'): AudienceCurve;
// wide: every bound b ↦ c · (b/c)^AUDIENCE_WIDEN_FACTOR with c = √(peakLow·peakHigh); the peak plateau is unchanged
export function audienceRange(size: 'small' | 'everyday' | 'larger'): { min: number; max: number };
```

Coercion of a quiet-hours window that is not on the grid snaps it to the nearest 30 minutes. A window with
`start === end` after snapping has no nearest safe value: that op is `refused: invalid` with a detail, and the
renderer prevents it beforehand (the two selects never offer equal values).

### B.8 Main seams

```ts
// src/main/modules/settings-service.ts (≤ 250 lines; resolve/view/ops/persist live in src/settings)
export interface SettingsService {
  view(): SettingsView;                               // cached per rev + capabilities
  effective(): EffectiveSettings;                     // cached per rev
  protection(): ProtectionIndex;                      // compiled per rev
  app(): { readonly tourCompletedAt: number | null };
  apply(ops: readonly SettingsOp[], origin: 'user' | 'system'): SettingsSaveResult;
  preview(ops: readonly SettingsOp[]): SettingsPreviewResult;      // pure: no persist, no push, no plan mutation
  basis(): BasisResult;
  onChange(fn: (e: SettingsChangeEvent) => void): () => void;
  bindStore(binding: SettingsStoreBinding | null): void;           // graph OPEN/CLOSE (kernel Session binding)
  setCapabilities(patch: Partial<SettingsCapabilities>): void;     // PR / PC / UD set them at wiring
  setPlanPort(port: PlanPreviewPort | null): void;
}
export interface SettingsChangeEvent {
  readonly rev: number; readonly prev: EffectiveSettings; readonly next: EffectiveSettings;
  readonly touched: ReadonlySet<'intent' | 'overrides' | 'seed' | 'protection' | 'prefs' | 'app'>;
  readonly origin: 'user' | 'system' | 'migration';
}
export interface SettingsStoreBinding {           // C13: no cadence_state / prune_last_run_at meta keys
  readonly ownPk: string;
  pkByUsername(username: string): string | null;
  username(pk: string): string | null;
  onMutation(fn: () => void): () => void;
}
// The v1 sweep stamp travels once: SettingsService.takeBookkeeping() → RO seeds reopen_state.lastSweep → op consume-bookkeeping.

/** PlanService implements it (PC; C6); SettingsService calls it. Pure; never mutates the live plan (A1). */
export interface PlanPreviewPort {
  fingerprint(e: EffectiveSettings): string;                                   // differs ⇔ re-plan event
  previewDays(e: EffectiveSettings, at: number, days: number): readonly PlanPreviewDay[];
  feasibility(e: EffectiveSettings): Feasibility;
}

// src/main/modules/seed-check.ts (moved from Foundation :1648-1712 by F1a; SC owns)
export interface SeedCheckService {
  check(handle: string): Promise<SeedCheckResult>;
  status(store: SeedStoreView | null, handle: string): SeedStatus;
  onTabFree(): void;                                  // Foundation calls it when busyDriverReason() → null
}

// src/main/modules/settings-facts.ts
export function shapeSettingsFacts(d: { graph: BuiltGraph | null; settings: SettingsService; seed: SeedCheckService }): SettingsFacts;
export function notBuiltFacts(why: 'signed-out' | 'loading' | 'error'): SettingsFacts;

// src/main/modules/protection-linker.ts — throttled store.onMutation → protect-link ops (system), only on change
// src/main/modules/settings-reload.ts — diffed applyConfig per component (§6.6)
```

Engine seams (UD):

```ts
// src/engine/protection-port.ts
export interface ProtectionPort {
  index(): ProtectionIndex;                           // LIVE provider, never a constructor snapshot
  recheckDelayMs(consecutiveUnreadable: number): number;   // plan-day length (PlanDayClock) × 2^min(n−1, KEEP_RECHECK_DOUBLINGS)
}
// src/engine/protection-gate.ts (pure helpers + the store reads they need)
export function storedSubject(store: { getAccount(pk: string): AccountState | null }, pk: string): ProtectionSubject;
export function freshSubject(obs: Observation, visitedUsername: string): ProtectionSubject;   // obs.fields ONLY
export type KeptReason = 'account' | 'verified' | 'bio-word' | 'source' | 'unreadable-bio' | 'unreadable-verified';
export interface KeptStamp { readonly reason: KeptReason; readonly match: string | null; readonly at: number;
  readonly recheckAt: number | null; readonly checks: number }
export function keptStampFor(v: Exclude<ProtectionVerdict, { kind: 'clear' | 'paused' }>, now: number,
  prevChecks: number, port: ProtectionPort): KeptStamp;
export function keepRecord(store: KeptStore, rec: FollowRecord, s: KeptStamp): void;    // → state 'kept'
export function releaseRecord(store: KeptStore, rec: FollowRecord): void;                 // → followed_back | pending_followback, reconciledAt cleared
// src/engine/protection-reconciler.ts
export class ProtectionReconciler {
  constructor(d: { store: KeptStore & { followRecordsByState(s: 'kept'): FollowRecord[] }; port: ProtectionPort; clock: Clock });
  reapply(reason: 'rules' | 'day-roll'): { kept: number; released: number; rechecking: number };   // one transaction, no IG
}
// C19: ONE consuming error, ActionReviewedError(verdict: ClickVerdict) (§9.7); the protection outcomes are ClickVerdict
// members 'protected' | 'protection-unknown' | 'protection-paused'. There is no ActionProtectedError.
// src/engine/churn-types.ts — ChurnActionOutcome.status gains 'reviewed' plus an optional `verdict: ClickVerdict`
// src/engine/churn-scheduler.ts — ChurnConfig gains `rotateMutuals: boolean`; bioKeepWords removed (UD)
// src/engine/prune-candidate.ts — PruneCandidateInput: `whitelist` → `protection: ProtectionVerdict`;
//                                  PruneSkipReason gains 'protected'
// src/engine/facts.ts — PruneFacts.whitelist → PruneFacts.protection (the prune-run mode rule P10, §7.1)
```

Store (F2b skeletons; SC and UD fill them):

```ts
// src/store/repos/meta.ts — no Settings meta keys (C13: the sweep stamp lives in reopen_state; the bulk prune is retired)
// src/store/repos/protection-facts.ts (read-only SQL; store → shared types only)
export class ProtectionFactsRepo {
  followingRows(ownPk: string): { pk: string; username: string | null; bio: string | null; isVerified: boolean | null; followsUs: boolean | null }[];
  suggest(ownPk: string, prefix: string, scope: 'following' | 'known', limit: number): AccountSuggestion[];  // prefix match, LIMIT
  keptPage(page: number, size: number): { rows: KeptRow[]; total: number };
  keptCounts(): { total: number; unreadable: number };
}
// the kept/review columns are migration 14 (§16.1, C12), landed in Phase F
```

### B.9 IPC, guards, fallbacks, push, projection

`src/ipc/contract-settings.ts` exports `SETTINGS_CHANNELS` and `SettingsIpcContract`. `contract.ts` spreads them into
`CHANNELS` and `extends` them into `IpcContract`. The `epo:*` push strings stay in `contract.ts`, as the push-channel
test requires.

| Method | Channel | req → res | Guard (shape only, ADR 1009) | Typed fallback (never a success) |
|---|---|---|---|---|
| `settingsView` | `settings:view` | `[]` → `SettingsView` | — | `service.view()` |
| `applySettings` | `settings:apply` | `[ops: SettingsOp[]]` → `SettingsSaveResult` | `SETTINGS_OPS` | `{kind:'refused', reason:'internal', detail, view}` |
| `previewSettings` | `settings:preview` | `[ops]` → `SettingsPreviewResult` | `SETTINGS_OPS` | `{kind:'unavailable'}` |
| `settingsBasis` | `settings:basis` | `[]` → `BasisResult` | — | `{kind:'unavailable'}` |
| `settingsFacts` | `settings:facts` | `[]` → `SettingsFacts` | — | `notBuiltFacts('error')` |
| `suggestAccounts` | `accounts:suggest` | `[query, scope]` → `SuggestResult` | `QUERY` (≤ 31 chars), `SCOPE` enum | `{kind:'unavailable'}` |
| `keptList` | `protection:kept` | `[page]` → `KeptPageResult` | `PAGE` (int 0..10 000) | `{kind:'unavailable'}` |
| `checkSeed` (re-typed in SU's last commit) | `seed:check` | `[handle]` → today's shape, then `SeedCheckResult` | **`SEED`** (new) | `{kind:'unreadable', why:'error'}` |
| `pruneCandidates` (re-typed) | `prune:candidates` | `[]` → `PruneCandidateView[]` (adds `protectedBy`, `bioUnread`) | — | `[]` (unchanged) |
| `getSettings` / `updateSettings` / `resetSettings` | unchanged strings | **transitional** v1 adapter (§6.10); deleted in SU's last commit | `updateSettings` keeps `SETTINGS_PATCH` | `getSettings` → `toV1Settings(view)`. `updateSettings`/`resetSettings` **rethrow** (the one transitional exception to typed fallbacks): `register.ts:63,69` resolves whatever the fallback returns, so only a rejecting fallback lets the old renderer show "Not saved" instead of the old settings |

- **`SETTINGS_OPS`** (`src/ipc/guards-settings.ts`):
  - `z.array(OP).min(1).max(64)`, with `OP` a discriminated union on `op`.
  - Intent ops are a union over the 14 key schemas. Their enums come from the shared tuples.
  - `quietHours`: minutes are integers in [0, 1439].
  - `daysOff`: integers in 0..6, at most 6.
  - the `migration` op: `action` ∈ {retry, start-from-recommended, remigrate-from-v1}.
  - `ParamKey` is `z.enum([...T2_PARAM_KEYS, ...TEMPO_PARAM_KEYS])`.
  - Values are a finite number, a boolean, `{min,max}`, or a six-field curve.
  - Strings: usernames ≤ 64 chars (main validates the handle), words ≤ 100 chars (≤ 50 per op), pk digits ≤ 25.
- **`ipc-guards.test.ts`** pins the sorted list of §15.1 (`applySettings, chainDetail, checkSeed, keptList,
  previewBoost, previewSettings, queueList, restartFromSeed, setLogStream, startBoost, suggestAccounts`, plus
  `updateSettings` until the adapter goes).
- **Push** (`contract.ts`):
  - `settings: 'epo:settings'` (`SettingsView`). It is sent by the service after every persisted write, whatever
    its origin. It is **not** a projection, because it does not derive from the graph (same reasoning as
    `updateStatus`, `projections.ts:62-64`).
  - `settingsFacts: 'epo:settings-facts'` (`SettingsFacts`). It **is** a `PROJECTIONS` row (store-derived): one
    `ProjectionSource.settingsFacts()` member, the opening push, and the throttled push on mutation. Foundation also
    sends it on each settings change (protection or seed edits move the counts without a store write).
    `projections-registry.test.ts` pins the five rows of §15.2 (`status, pruneStatus, chainList, settingsFacts, feed`).
- **Handlers and fallbacks** live in `src/main/ipc-settings.ts` and are spread into `handlers`/`fallbacks` in
  `src/main/ipc.ts`.
- **The stage handler** uses `isStageMode(mode)` from `src/shared/stage-mode.ts`. It logs a warning on an unknown
  mode instead of a silent no-op.

### B.10 Copy deck (neutral naming: no bot, human-emulation or detection framing)

**Never use:** block, ban, flagged, detection, bot, automation, aggressive, stealth, mimic, human-like, jitter, churn,
ceiling, velocity. Risk is a *share of Instagram's known limits*, never a warning label.

| Where | Copy |
|---|---|
| Stage tab · page title | "Settings" |
| Mode switch | "Easy" · "Advanced" — help: "Advanced shows every number Epo uses and lets you set any of them yourself." |
| Save status | "All changes saved" · "Saving…" · "Saved · Undo" · "Saved — 1 value adjusted to stay in the safe range" · "Couldn't save — nothing was changed. [Try again]" |
| Load failure | "Couldn't load your settings. [Retry]" |
| Growth pace | Q: "How quickly should Epo grow your account?" · Gentle "About {n} a day. Light and relaxed." · Balanced *(Recommended)* "About {n} a day. Steady growth with room to spare." · Faster "About {n} a day. More new people each day." · Card foot: "follows, unfollows and approvals together" (no per-hour figure in Easy) · "Most days land between {lo} and {hi}." · "Epo's own work never uses more than {p}% of the lowest daily follow limit Instagram is known to apply." · Custom: "Your own mix — about {n} a day. Set in Advanced. [Review]" |
| Feasibility | "Your schedule is too short for this pace. Epo can fit about {n} a day into your active hours at a safe speed. Pick a slower pace, or shorten your quiet hours." |
| At-limit confirm | "This runs at the low end of what Instagram is known to allow in a day. Some accounts get temporarily restricted at this pace. Continue?" [Use it anyway] [Keep current] |
| When Epo works | Q: "When should Epo be active?" · Through the day *(Recommended)* · Mornings · Evenings · Late nights · Work hours · "Quiet hours: {start} – {end} · from your schedule · [Change]" · Editor: "Follow my schedule (recommended)" / "Set my own: From [ ] To [ ]" / "No quiet hours" · Hint: "Epo does nothing on Instagram during quiet hours. Anything you start yourself still runs." · Days off: "Days off" + hint "Epo takes these days off completely (up to 6 days a week). Your daily limits don't move to other days." · Session style: "Many short visits ({a}–{b} a day)" · "A few regular sessions ({a}–{b} a day)" *(Recommended)* · "A couple of longer sessions ({a}–{b} a day)" |
| Who to follow | "Starting account" · placeholder "@username" · help "Epo finds people through this account's followers. Pick one whose followers look like your audience." · Account size: "Smaller accounts (up to {max})" · "Everyday accounts ({min}–{max})" *(Recommended)* · "Larger accounts (up to {max})" · hint "Very large accounts rarely follow back." · Prefer: "People likely to follow you back" *(Recommended)* · "Reach more people (fewer follow back)" · "Give private accounts a small edge" · hint "Epo favours accounts that follow about as many people as follow them, and private accounts. They follow back most often." · **Follow requests**: "Accept follow requests automatically" + pill "Your account is private"/"Your account is public" + help "Each accepted request counts toward your daily and hourly limits." |
| Unfollowing | Lead: "Epo unfollows people it followed who didn't follow back, so your following count stays healthy. Everyone in Protection is always kept." · "If someone doesn't follow back, unfollow them after" 2 days · 4 days · 1 week · "When someone follows you back": "Unfollow them after {hold} days. Most keep following you, and your following count stays low." / "Keep following them. Your following count grows over time." · "People you followed yourself" (accounts Epo didn't follow for you): "Leave them alone" *(Recommended)* · "Unfollow those who don't follow back, a few a day" · "…more each day" |
| Cleanup confirm | "Epo found {n} accounts you follow that don't follow you back (checked {ago}). {k} of them are protected and will be kept. Epo will unfollow the rest a few at a time, mixed into its normal sessions, inside your daily limits." [Turn on] [Review the list] [Cancel] · Without a census: "Epo will first check who follows you back (reading only), then start slowly." |
| Protection | Lead: "Epo never unfollows anyone protected here — not in its daily cycle, not when pruning, not during Boost — whether or not they follow you back." · People: "Never unfollow these accounts" · "Add @username" · [Paste a list] · badges "You follow · Follows you" / "Renamed from @{old}" / "Not seen yet — check the spelling" / "Not among accounts you follow" / "Not a valid username" · Empty: "No one yet. Add friends, family or brands you want to keep following." · Keywords: "Never unfollow anyone whose bio mentions…" · "{word} · {n} people" · "Add a word or phrase" · hint "Matches anywhere in the bio, ignoring capitals, accents and fancy fonts. Epo re-reads the bio right before every unfollow. If it can't read a bio, it keeps the account and checks again later." · "Keep verified accounts" + "Accounts with Instagram's verified badge: brands, creators and public figures." · "Also always kept: your starting account and the accounts Epo explores through." · Summary: "Protecting {p} of the {f} accounts Epo has seen you follow · Kept so far: {k} · Bios not read yet: {u} (checked before any unfollow)." · Remove toast: "Removed @{u} from Protection. [Undo]" · Own-follow note: "Accounts Epo follows that match your keywords are kept too, even if they don't follow back." |
| Protection paused | needs-review: "Check your protection list before Epo unfollows anyone. Epo restored it from a saved copy." [Review protection] → [My protection list is right] · unavailable: "Epo couldn't read your settings and found no saved copy, so it won't unfollow anyone until you check Protection." |
| Boost (Settings) | Lead: "Boost has Epo spend the next hours finding and following new people. Unfollowing, cleanup and routine checks wait until it ends. Your daily safety limits never change." · "Default length" · "Keep accepting follow requests during Boost" + "Matters only for private accounts: their follow-backs arrive as requests." · Checklist: "More follows and more exploring of new accounts" · "Unfollows, cleanup and follow-back checks wait" · "Quiet hours and days off still apply" · "Your daily and hourly limits never go up" · "This is where you choose how long a Boost lasts. Start or end one with the Boost button in the left panel. [Show me]" · On: "Boost is on until {time} · {n} follows so far · [End Boost]" |
| Boost (sidebar) | One control, one tap: button "⚡ Boost for {h} h" / "Start Epo and Boost" · preview "Until {time} · about +{n} follows today, within your usual limits · {k} unfollows will wait" · link "Change length in Settings" · act-now only: "Boost starts working now instead of at {time}. There are no unfollows to swap today, so follows stay about {n}." · disabled: "Today has no unfollows to swap for follows, and Epo is already working." · backlog: "Too many unfollows are still waiting from earlier Boosts. Boost is available again in about {d} days." · light day: "Today is a light day — Boost would shape tomorrow's sessions until {time}." · "Most of this falls in your quiet hours; Boost starts at {time}." · "Today's limit is already reached; Boost starts helping tomorrow." · Paused: "⚡ Boost on until {time} — Epo is stopped. Press Start to use it." · On: "⚡ Boost on · ends {time} · {h} h {m} m left" [End Boost] · Waiting: "⚡ Boost starts at {time} (quiet hours)" · Ended toast: "Boost ended. Unfollows that waited will be spread over the next sessions." · Unavailable: "Sign in to use Boost" / "Choose a starting account first" / "Epo needs your attention first" |
| Practice & app | "Practice mode" + "Epo plans and works as usual but never presses Follow, Unfollow or Accept. It still opens profiles and lists to read them." · Off confirm: "Turn off practice mode? Epo will start following and unfollowing for real the next time it runs." [Turn off] [Keep practicing] · "Replay the intro" · "Reset to recommended" · "Clear data & log out" + "Removes Epo's data about your account and signs you out of Instagram. Your settings and protection list are kept." |
| Reset confirm | "Reset to recommended? This changes: {diff lines}." Loosening lines get ⚠ "Epo will unfollow more" · "Your starting account, protection list ({a} accounts, {w} keywords), practice mode and Boost preferences stay as they are." [Reset] [Keep mine] |
| Advanced rows | "Recommended {v}" · "Why this number?" · "Set by you" · "Use recommended" · "Safe range {min}–{max}" · "Applies now" / "Updates today's remaining plan" / "From tomorrow's plan" / "After Epo restarts" · Clamp: "You asked for {x}; Epo uses {y}, the safe {maximum/minimum}." · Stale: "Set to {x} when Epo recommended {b}; it now recommends {r}." · Conflict: "You set {label} yourself ({x}). {choice} would use {r}. [Use {r}] [Keep {x}]" · Inactive: "Not used — you keep people who follow you back." / "Not used — cleanup is off." · Fine-tuned (Easy): "Fine-tuned in Advanced ({n}) · [Review] · [Use recommended]" |
| Notices (one-time) | "Your bio keywords ({n}) now protect everyone you follow, not only people who follow you back." · "Verified accounts are now kept by default." · "Epo now keeps quiet hours overnight ({start}–{end}, from your schedule). Change them in Settings → When Epo works." · "Cleaning up people you followed yourself is now its own setting, and it's off." / "Scheduled cleanup now happens gradually inside Epo's sessions." · "Everything you could set before is in Advanced." · "Settings were changed in an older version of Epo: {a} protected accounts and {w} keywords were added there. [Add them here] [Ignore] (Removals made there aren't applied.)" · "Steady intervals is retired. Epo now paces every action from your daily plan. For more regular days, Consistency is set to Even." · "Your scheduled cleanup now runs a few at a time inside sessions." · "A setting from the older version would have made Epo faster than its own plan ({what}), so it was left out." |
| Tour (settings step) | Title "Make it yours" · "Settings has an Easy view for the essentials and an Advanced view for every detail. Start by choosing a starting account whose followers look like your audience. Every change saves as you make it." |
| Tour (done step) | "Sign in on the Live tab, choose a starting account in Settings, and press Start. You can replay this tour from Settings → Practice & app." |
| Settings recovery | Refused migration: "Epo couldn't move your settings to the new format, so it is running on your previous settings as they were (practice mode and your protection lists included). Unfollows wait until this is sorted out. [Try again] [Start from recommended settings]" · "Start over from the older version's settings" (Advanced → Practice & app) + confirm "This replaces your current settings with the ones the older version saved on {date}. Your protection list will need a review." |
| Today's plan in detail (Advanced → Timing) | "Today's plan in detail" · per session "Session {i} · {start}–{end} · {f} follows · {u} unfollows · {a} approvals · {pace} pace · average pause {t} · shortest {t}" · per day "Plan-day {start}–{end} · resets at {quiet} · Epo's own maximum {n} · hard stop {m} · at most {h} an hour ({uh} unfollows, {ph} while easing back in) · up to {k} approvals per check" |
| Gap rows (Advanced) | "Average pause between actions" + help "Epo's typical wait between actions at a normal-pace session. You can only make it longer." · "Shortest pause between actions" + help "The shortest wait Epo allows. You can only make it longer." · beside each: "Today: {value}" |

---

## Appendix C — Sidebar, boot, stage, feed contracts and copy (normative)

Reconciled from T3 §10 and §15 with §14 (C3, C4, C7, C8, C22, C26) and revision 2 (the landing behind the splash,
posture inputs, one-tap Boost, Prune, liveOpText ownership). Where a line here and §1–§24 disagree, §1–§24 win.

All payload types live in `src/shared/*`: pure, renderer-safe, never importing `@/types` (the cycle hub,
U12 §3.3) or `@/kernel`. New renderer files import only renderer, shared and `@/ipc/contract` code, so the
boundaries warning count (100 after F1a step 0) does not grow. Rewriting `shared/stage-mode.ts`, `shared/update-status.ts` and
`shared/log-entry.ts` as imported modules removes three orphan warnings.

### C.1 Shared

```ts
// ── src/shared/stage-mode.ts (rewrite of the orphan; canonical) ─────────────────────────────
export const STAGE_MODES = ['tab', 'people', 'graph', 'prune', 'settings'] as const;
export type StageMode = (typeof STAGE_MODES)[number];
export function isStageMode(v: unknown): v is StageMode {
  return typeof v === 'string' && (STAGE_MODES as readonly string[]).includes(v);
}

// ── src/shared/boot.ts ────────────────────────────────────────────────────────────────────────
export type StartupStepName = 'open-own-profile' | 'confirm-account' | 'catch-up' | 'resume-run';
export type BootDataProblem = 'future-version' | 'unreadable' | 'locked';
export interface BootView {
  readonly phase: 'starting' | 'ready' | 'live';
  readonly identity: 'pending' | 'signed-in' | 'signed-out';
  readonly data: 'pending' | 'open' | 'not-applicable' | 'unavailable';
  readonly dataProblem: BootDataProblem | null;
  /** The IG tab's first navigation. */
  readonly tab: 'loading' | 'settled' | 'failed';
  /** R5 (r2): the landing and confirm-account done behind the splash ('ready'), or the reveal proceeds onto the
   *  Live placeholder ('placeholder': past BOOT.IG_READY_DEADLINE_MS, offline, signed out, or the tour held). */
  readonly ig: 'pending' | 'ready' | 'placeholder';
  /** Main-process boot instant (epoch ms). */
  readonly startedAt: number;
  /** Reveal no later than this, ready or not (startedAt + max(DATA_DEADLINE_MS, IG_READY_DEADLINE_MS)). */
  readonly revealBy: number;
  readonly startup: {
    readonly step: StartupStepName | null;        // the running step, null when none runs
    readonly startQueued: boolean;                // a user Start waits for the sequence
    readonly done: boolean;
  };
}

// ── (C22) there is no live-status.ts: `basis`, `boot`, `account` are members of the one StatusFields interface
//    in src/shared/status-fields.ts (§15.3).

// ── src/shared/live-op.ts ─────────────────────────────────────────────────────────────────────
export type ActivityKind = 'api' | 'page';
export type LiveOp =
  | { readonly op: 'follow'; readonly username: string }
  | { readonly op: 'unfollow'; readonly username: string }
  | { readonly op: 'accept-request'; readonly username: string }
  | { readonly op: 'open-list'; readonly list: 'followers' | 'following'; readonly of: string }
  | { readonly op: 'browse-list'; readonly list: 'followers' | 'following'; readonly of: string | null;
      readonly done: number; readonly total: number | null }                 // page scroll (followers-page-reader)
  | { readonly op: 'read-list'; readonly list: 'followers' | 'following'; readonly of: string | null;
      readonly done: number; readonly total: number | null }                 // API walk (list-page-walker)
  | { readonly op: 'visit-profiles'; readonly done: number; readonly total: number }
  | { readonly op: 'visit-profile'; readonly username: string; readonly purpose: 'check-back' | 'verify' | 'settle' | 'seed' }
  | { readonly op: 'check-notifications' }
  | { readonly op: 'open-own-profile' }
  | { readonly op: 'confirm-account' };
/** The adapter seam (replaces `label/count/total/detail` at the seven call sites, line-neutral). */
export interface ActivityInfo { readonly kind: ActivityKind; readonly op: LiveOp }
/** The veil page's existing payload (veil.html is unchanged). */
export interface VeilInfo { kind: ActivityKind; label: string; count?: number; total?: number; detail?: string }
/** One sentence per op, shared by the sidebar now line and the veil chip ("Following @jane", "Reading @studio.lumen's
 *  followers · 120 of 250"). SB owns the wording (L-COPY); BL owns the types. */
export declare function liveOpText(op: LiveOp): string;
/** The veil's chip fields. A Phase F identity test pins today's seven labels; from SB on the label is liveOpText(op). */
export declare function toVeilInfo(info: ActivityInfo): VeilInfo;
export interface LiveTab {
  readonly activity: { readonly info: ActivityInfo; readonly since: number } | null;
  /** True while any routine holds the page (the veil is up). */
  readonly busy: boolean;
  /** TabActivity hold names, for Diagnostics and the stage-bar context. */
  readonly holds: readonly string[];
}

// ── src/shared/feed.ts ────────────────────────────────────────────────────────────────────────
export interface Person { readonly pk: string; readonly username: string | null }
export type UnfollowWhy = 'no-follow-back' | 'after-follow-back' | 'clean-up' | 'you' | 'other';
type At = { readonly id: string; readonly at: number };        // id stable across re-grouping (FLIP key)
export type FeedItem = At & (
  | { readonly kind: 'followed'; readonly people: readonly Person[]; readonly via: 'plan' | 'boost' | 'you'; readonly practice: boolean }
  | { readonly kind: 'unfollowed'; readonly people: readonly Person[]; readonly why: UnfollowWhy; readonly practice: boolean }
  | { readonly kind: 'followed-back'; readonly person: Person; readonly afterMs: number | null; readonly dated: boolean }
  | { readonly kind: 'new-followers'; readonly people: readonly Person[]; readonly dated: boolean }
  | { readonly kind: 'lost-followers'; readonly count: number }
  | { readonly kind: 'request-accepted'; readonly people: readonly Person[] }
  | { readonly kind: 'not-done'; readonly action: 'follow' | 'unfollow' | 'accept'; readonly person: Person;
      readonly why: 'refused' | 'unavailable' | 'unconfirmed' | 'error' }
  | { readonly kind: 'kept'; readonly person: Person; readonly reason: string }             // T2 KeptReason
  | { readonly kind: 'boost'; readonly edge: 'started' | 'ended'; readonly endsAt: number | null;
      readonly why: 'user' | 'expired' | 'clock' | null }                         // C3
  | { readonly kind: 'slowed-down'; readonly until: number | null }
  | { readonly kind: 'resumed'; readonly after: 'restart' }
  | { readonly kind: 'caught-up'; readonly summary: AwaySummaryLite }
);
/** The fields of T5's AwaySummary the feed renders (T5 owns the full type). */
export interface AwaySummaryLite {
  readonly awayFrom: number; readonly checkedAt: number;
  readonly newFollowers: number; readonly followBacks: number; readonly left: number;
}
export interface FeedView {
  readonly items: readonly FeedItem[];             // newest first, grouped, ≤ LIVE.FEED_LIMIT
  readonly awayFrom: number | null;                // "Since you left" divider
  readonly windowStart: number;
  readonly shapedAt: number;
}
export declare function formatAgo(at: number, now: number): string;   // "just now" · "2m" · "1h 5m" · "yesterday 3:10 PM"

// ── src/shared/attention.ts ───────────────────────────────────────────────────────────────────
export const KNOWN_BLOCK_KEYS = [
  'account-changed', 'login-required', 'account-identity-unavailable', 'automatic-resume-failed',
  'tab-recovery-failed', 'wake-recovery-failed', 'wake-sentinel-failed', 'wake-reconciliation-failed',
  'runtime-recovery-exhausted', 'runtime-state-persist-failed', 'runtime-state-unreadable',
  'startup-failed', 'dashboard-recovery-exhausted', 'data-clear-in-progress',
  // the halt vocabulary (parity with haltReasonKey(ALL_HALT_REASONS) is a test)
  'runtime-error', 'identity-changed', 'sentinel:ok', 'sentinel:challenge',   // 'reconciliation-failed' goes with UD-b's halt removal
  'sentinel:logged-out', 'sentinel:action-blocked', 'chain-exhausted', 'recovery-exhausted', 'adapter-drift',
  'seed-missing', 'seed-unresolved', 'no-current-target', 'rate-limited', 'actions-failing',
  'blocked-repeatedly', 'scan-failed', 'run-failed',
  'actions-unconfirmed',                                     // the F7 breaker's attention (§11.1); not a runtime block
] as const;
export type KnownBlockKey = (typeof KNOWN_BLOCK_KEYS)[number];
export type AttentionAction =
  | 'start' | 'show-live' | 'choose-seed' | 'check-update' | 'open-prune' | 'diagnostics' | 'restart-app' | 'wait';
export interface Attention {
  readonly key: KnownBlockKey | 'unknown';
  readonly raw: string;                            // shown only as "Code: {raw}" when unknown, and in Diagnostics
  readonly action: AttentionAction;
  readonly blocksSchedules: boolean;
}
export declare function classifyBlock(raw: string): Attention;

// ── src/shared/posture.ts ─────────────────────────────────────────────────────────────────────
export type PostureKind =
  | 'starting-up' | 'data-unavailable' | 'signed-out' | 'needs-attention' | 'sleeping' | 'reconnecting'
  | 'offline' | 'cleaning-up' | 'catching-up' | 'starting' | 'paused' | 'needs-seed' | 'stopped'
  | 'taking-a-break' | 'day-off' | 'done-for-today' | 'pacing' | 'retrying' | 'resting' | 'working';
export type PostureTone = 'live' | 'calm' | 'idle' | 'hold' | 'alert';
export type PrimaryControl =
  | 'start' | 'starting' | 'pause' | 'resume' | 'sign-in' | 'set-up' | 'pause-cleanup' | 'resume-cleanup'
  | 'diagnostics' | Exclude<AttentionAction, 'start' | 'diagnostics' | 'restart-app' | 'wait'> | null;
export interface Countdown {
  readonly from: number;                           // anchor of the fraction (lastActionAt, park start, …)
  readonly to: number;                             // the deadline (epoch ms), always > from
  readonly toward: 'next-step' | 'next-session' | 'retry' | 'resume' | 'cleanup-step';
}
export interface Posture {
  readonly kind: PostureKind;
  readonly tone: PostureTone;
  readonly driver: 'growth' | 'prune';
  readonly primary: PrimaryControl;
  readonly secondary: 'stop' | 'stop-cleanup' | 'start' | null;
  readonly countdown: Countdown | null;
  readonly busy: boolean;                          // indeterminate ring
  readonly attention: Attention | null;
  readonly overlay: { readonly boost: boolean; readonly practice: boolean; readonly careful: boolean };
  readonly explain: ExplainTopic | null;           // the "Why?" popover topic
}
export type ExplainTopic = 'resting' | 'pacing-hour' | 'pacing-visits' | 'retrying' | 'taking-a-break'
  | 'done-for-today' | 'day-off' | 'catching-up' | 'boost' | 'practice';
/** Plain inputs (renderer-safe); the renderer builds them from its signals, main from its projections. */
export interface PostureInput {
  readonly boot: Pick<BootView, 'phase' | 'identity' | 'data' | 'startup'> | null;
  readonly status: {
    readonly basis: 'built' | 'not-built';
    readonly loggedIn: boolean;
    readonly state: 'idle' | 'running' | 'paused' | 'halted';
    readonly online: boolean;
    readonly haltReason: string | null;
    readonly parkReason: string | null;
    readonly parkedUntil: number | null;
    readonly nextActionAt: number | null;
    readonly lastActionAt: number | null;
    readonly hasStepped: boolean;                  // lastStep !== null
    readonly recovery: { readonly phase: 'holding' | 'probing'; readonly resumeAt: number | null } | null;
    readonly runtime: { readonly desired: 'stopped' | 'paused' | 'running';
                        readonly phase: 'ready' | 'suspended' | 'reconciling' | 'recovering';
                        readonly blockedReason: string | null } | null;
  } | null;
  readonly prune: { readonly state: string; readonly nextActionAt: number | null } | null;
  readonly plan: { readonly totalsPlanned: number; readonly remaining: number;
                   readonly sessionIdx: number | null; readonly nextAt: number | null;
                   readonly dayOff: boolean; readonly lateStart: boolean; readonly light: boolean } | null;   // PlanProjection.day (§5.17)
  readonly catchUpRunning: boolean;                // catchUp.state === 'running'
  readonly boost: 'off' | 'on' | 'waiting' | 'paused';   // BoostView.state (§8.5); the pill is an indicator only
  readonly practice: boolean;                      // T2 practice mode (engine name dryRun)
  readonly liveOpInFlight: boolean;                // activity push
  readonly seedSet: boolean;                       // settingsFacts.seed.kind !== 'none'
  readonly unconfirmed: 'follow' | 'unfollow' | null;   // status.actionsUnconfirmed
  readonly pending: 'start' | 'pause' | 'stop' | null;   // the renderer's in-flight control
}
export declare function derivePosture(input: PostureInput, now: number): Posture;
export declare function postureHeadline(kind: PostureKind): string;   // ≤ 15 chars; main's window title uses it

// ── src/shared/brand-mark.ts ──────────────────────────────────────────────────────────────────
export const BRAND_MARK: {
  readonly viewBox: 64;
  readonly cut: readonly { x: number; y: number; w: number; h: number; rx: number; fill: '#fff' | '#000' }[];
  readonly body: readonly { offset: string; color: string }[];
  readonly shadow: readonly { offset: string; color: string; opacity: number }[];
  readonly highlight: readonly { offset: string; color: string; opacity: number }[];
};
```

### C.2 Kernel (tier 1/2; new files; outside the 119-key registry)

```ts
// ── src/kernel/shell-geometry.ts ──────────────────────────────────────────────────────────────
export const SHELL_GEOMETRY = {
  /** Sidebar width = the IG tab's x. Guards: IG breakpoints narrower than today's tab are unmeasured (U11 H6). */
  SIDEBAR_WIDTH_PX: 460,
  /** Top band (stage bar + masthead) = the IG tab's y. Guards: the tab must start under the bar's hairline. */
  STAGE_BAR_HEIGHT_PX: 44,
} as const;

// ── src/kernel/boot-policy.ts ─────────────────────────────────────────────────────────────────
import { EMPIRICAL } from './fundamentals';
const P = EMPIRICAL.DISPLAY.perceptionMs;          // 100
const F = EMPIRICAL.DISPLAY.frameMs;               // 16.7
export const BOOT = {
  /** Guards: an invisible app when the dashboard never finishes loading. */
  SHOW_FALLBACK_MS: 1_500,
  /** Guards: a slow disk or long migration never traps the user behind the splash (renderer reveals skeletons). */
  DATA_DEADLINE_MS: 4_000,
  /** r2: the typical launch (p95 home hydration + two median navigations) lands behind the splash. Derived. */
  IG_READY_DEADLINE_MS: EMPIRICAL.LATENCY.hydration.p95 + 2 * EMPIRICAL.LATENCY.nav.p50,   // 6 600
  /** Guards: crash-resume durability (ADR 0210) when the renderer never reports the reveal. */
  SETTLE_DEADLINE_MS: 8_000,
  /** Longest wait for the veil's opaque layer to paint before a plain cut. Derived: six frames. */
  CURTAIN_PAINT_MAX_MS: Math.ceil(6 * F),        // 101
  /** The curtain's fade. Derived: three perception units. */
  CURTAIN_FADE_MS: 3 * P,                        // 300
  /** An activity `null` is held this long so the now line never blinks between steps. Derived. */
  ACTIVITY_NULL_HOLD_MS: 2 * P,                  // 200
} as const;

// ── src/kernel/live-policy.ts ─────────────────────────────────────────────────────────────────
import { EMPIRICAL } from './fundamentals';
import { MS_PER_DAY } from './units';
export const LIVE = {
  /** Guards: per-push shaping cost and payload size of the feed (items after grouping). */
  FEED_LIMIT: 60,
  /** Guards: the sidebar narrates the recent past; older detail lives on the People page. */
  FEED_WINDOW_MS: 7 * MS_PER_DAY,
  /** Feed grouping horizon = one session boundary (fundamental). Derived. */
  GROUP_WINDOW_MS: EMPIRICAL.HUMAN_SESSION_BOUNDARY_MS.value,
  /** Guards: a grouped row lists at most this many people before "+N more". */
  GROUP_PEOPLE_MAX: 20,
} as const;
export const DIAGNOSTICS = {
  /** Guards: memory of the in-process log ring served to the Diagnostics panel. */
  LOG_RING: 500,
} as const;
```

Laws (`tests/kernel/boot-policy.test.ts`):
- `SHOW_FALLBACK_MS < DATA_DEADLINE_MS < IG_READY_DEADLINE_MS < SETTLE_DEADLINE_MS`;
- `CURTAIN_PAINT_MAX_MS ≥ 2 × frameMs`;
- every derived value equals its formula.

### C.3 Main

```ts
// ── src/main/modules/boot-sequencer.ts (≤ 240 lines) ─────────────────────────────────────────
export interface StartupStep {
  readonly name: StartupStepName;
  when(): boolean;                                 // evaluated just before the step runs
  run(signal: AbortSignal): Promise<void>;         // owns its bounds; rejects only on unexpected failure (logged)
}
export type OpenResult = { kind: 'open' } | { kind: 'signed-out' } | { kind: 'failed'; problem: BootDataProblem; detail: string };
export interface BootPorts {
  clock: { now(): number };
  after(ms: number, fn: () => void): () => void;   // injected timers (tests use fake time)
  openData(): Promise<OpenResult>;                 // cookie → GraphSession.openFromStore(); no tab work
  tabFirstLoad: Promise<'ready' | 'failed'>;       // shell.igFirstLoad
  retryTabLoad(): Promise<'ready' | 'failed'>;     // one home load after a failed launch load, on online
  claimStartup(): (() => void) | null;             // TabLease 'startup', claimed at R3; null when a driver already holds the tab
  tourHeld(): boolean;
  onTourReleased(cb: () => void): () => void;
  pushStatus(): void;                              // boot rides EpoStatus: re-push on every transition
  steps: readonly StartupStep[];
  afterStartup(): void;                            // seedCheck.onTabFree() (the scheduled-prune watcher is retired, C14)
}
export declare class BootSequencer {
  constructor(ports: BootPorts);
  start(): Promise<void>;                          // R2 → R3 (lease; steps 1–2 behind the splash) → 'ready'; R5 → ig; arms SETTLE_DEADLINE
  view(): BootView;                                // pure snapshot
  revealed(): void;                                // idempotent → 'live' → steps 3–4 (catch-up, resume) under the lease
  whenStartupDone(): Promise<void>;                // queued Start awaits this
  noteStartQueued(queued: boolean): void;
  runIdentitySteps(): Promise<void>;               // login(): open-own-profile + confirm-account under the lease
  cancelStartup(): void;                           // Stop: abort the running step, skip the rest
  onOnline(online: boolean): void;                 // retries a failed first load once per online transition
  dispose(): void;
}

// ── src/main/modules/startup-steps.ts (moved bodies + the confirm step; ≤ 200 lines) ─────────
export interface StartupDeps {
  runtime: Pick<RuntimeCoordinator, 'ready' | 'wantsRun' | 'token' | 'snapshot' | 'record'>;
  session: Pick<GraphSession, 'current' | 'rebuildWith'>;
  tab: { currentUrl(): string };
  readOwnUsernamePassively(signal: AbortSignal): Promise<string | undefined>;   // identity strategies 1–2 only
  clickOwnProfileLink(): Promise<boolean>;          // graph.actor.clickOwnProfileLink (today's landing press)
  withHold<T>(name: 'open-profile' | 'startup', run: () => Promise<T>): Promise<T>;   // TabActivity veil hold
  readCookie(): Promise<string | null>;
  block(reason: string): void;                      // Foundation.blockRuntime
  startEngine(o: { automaticToken: number }): Promise<unknown>;
  setAccountConfirmed(username: string | null): void;
}
export declare function openOwnProfileStep(d: StartupDeps): StartupStep;   // today's landOnOwnProfile body
export declare function confirmAccountStep(d: StartupDeps): StartupStep;
export declare function resumeRunStep(d: StartupDeps): StartupStep;        // today's restoreRuntimeIntent body
// The catch-up step comes from RO: catchUpStep(sweep, admit): StartupStep (src/main/modules/catch-up.ts), returned in
// BuiltGraph.startupSteps by reopen-wiring.ts.

// ── src/main/modules/session.ts (changed; see §12.8) ─────────────────────────────────────────
//   openFromStore(): Promise<boolean>              no tab work; memoized; replaces buildResolved's tab path
//   rebuildWith(username: string): Promise<boolean> the confirm-account rebuild (engine active → defer + log)
//   GraphSessionDeps loses resolveUsername and withBuildHold; ensureBuilt() delegates to openFromStore()

// ── src/main/modules/activity-relay.ts (≤ 110 lines) ─────────────────────────────────────────
export interface ActivityRelayDeps {
  veil: { setActivity(info: VeilInfo | null): void };
  push(tab: LiveTab): void;                        // PUSH.activity
  clock: { now(): number };
  after(ms: number, fn: () => void): () => void;
  throttleMs: number;                              // POLL.GRAPH_PUSH_THROTTLE_MS (count-only changes)
  nullHoldMs: number;                              // BOOT.ACTIVITY_NULL_HOLD_MS
}
export interface ActivityRelay extends ActivityReporter {
  onHolds(active: boolean, holds: readonly string[]): void;   // fed from Foundation's TabActivity callback
  current(): LiveTab;                              // the `activityNow` pull backstop
}
export declare function createActivityRelay(d: ActivityRelayDeps): ActivityRelay;
// Op change → push now; count-only change → trailing throttle; clear() → push null only if no op arrives
// within nullHoldMs; holds change → push now. The veil always gets toVeilInfo(info) immediately.

// ── src/main/modules/feed-projection.ts (≤ 220 lines; pure over its ports) ───────────────────
export interface FeedReads {                       // = KnowledgeStore.feed (src/store/repos/feed-reads.ts)
  settledEffects(since: number, limit: number): readonly EffectFeedRow[];
  followBacks(since: number, limit: number): readonly FollowBackFeedRow[];
  newFollowers(ownPk: string, since: number, limit: number): readonly EdgeFeedRow[];
  lostFollowerCount(ownPk: string, since: number): readonly { at: number; count: number }[];   // per check
}
export interface FeedContext {
  now: number;
  ownPk: string;
  baselineAt: number | null;                       // followers baseline: the first census is stock, not news
  boost: BoostWindowLite | null;                   // from T7/T1 (startedAt, endsAt, endedAt, endReason)
  incidents: readonly { at: number; reason: string }[];       // runtime incidents (resumed after restart)
  recoveryIncident: { at: number; resumeAt: number | null } | null;   // store meta recovery_last_incident
  away: AwaySummaryLite | null;                    // T5 (persisted last catch-up)
  awayFrom: number | null;                         // T5 catchUp.awayFrom, else the last 'intentional-shutdown' incident
  kept: readonly { pk: string; username: string | null; reason: string; keptAt: number }[];   // T2 keptPage rows
}
export interface BoostWindowLite { startedAt: number; endsAt: number; endedAt: number | null; endReason: string | null }
export declare function shapeFeed(reads: FeedReads, ctx: FeedContext): FeedView;
// Groups consecutive same-kind follows/unfollows/new followers within LIVE.GROUP_WINDOW_MS (group id = the
// OLDEST member's id, so the key is stable as the group grows); new followers exclude pks with a managed
// follow-back record or an accept intent; capped at LIVE.FEED_LIMIT; window LIVE.FEED_WINDOW_MS.
export declare function notBuiltFeed(now: number): FeedView;   // { items: [], awayFrom: null, … }

// ── src/main/modules/projections.ts (changed) ────────────────────────────────────────────────
export interface ProjectionSource {
  status(): EpoStatus; pruneStatus(): PruneStatus; chainList(): ChainTargetView[];
  settingsFacts(): SettingsFacts;                  // SC
  feed(): FeedView;                                // LD
  /** Earliest instant a shown verdict changes with no mutation (prune freshness …); null = none. */
  expiresAt?(): number | null;
}
export interface Projection<C extends PushMethod> {
  readonly channel: C;
  shape(source: ProjectionSource): PushContract[C];
  /** Push only when the shaped payload's JSON differs from the last push of this row. */
  readonly dedupe?: boolean;
}
// PROJECTIONS order (pinned, §15.2): status, pruneStatus, chainList, settingsFacts, feed (dedupe).
// After each pushAll(), one timer is (re)armed at expiresAt() (clamped ≥ now + throttle), which pushes all.

// ── src/main/modules/log-ring.ts ─────────────────────────────────────────────────────────────
export declare class LogRing {
  constructor(capacity: number);                   // DIAGNOSTICS.LOG_RING
  add(e: LogEntry): void;
  tail(): LogEntry[];
  setStreaming(on: boolean): void;                 // the log push runs only while a Diagnostics panel is mounted
  streaming(): boolean;
}

// ── src/main/window/stage-controller.ts (≤ 150 lines) ────────────────────────────────────────
export interface StageController {
  set(mode: StageMode, covered: boolean, reducedMotion?: boolean): Promise<void>;   // validates, serializes, cuts under reduced motion
  cover(): void;                                            // boot: tab under the dashboard from frame 1
  current(): { mode: StageMode; covered: boolean };
  onPosture(p: Posture): void;                              // window title + macOS Dock badge (posture.ts from F2b)
}
export declare function createStageController(d: {
  shell: Pick<AppShell, 'setStage' | 'win'>;
  veil: Pick<OverlayVeil, 'curtain'>;
  dock: { setBadge(text: string): void } | null;            // app.dock on macOS
  timing: { paintMaxMs: number; fadeMs: number };           // BOOT.CURTAIN_*
}): StageController;

// ── src/main/overlay/veil-view.ts (changed) ──────────────────────────────────────────────────
//   curtain(state: 'opaque' | 'clear' | 'off'): Promise<boolean>   // true when the page confirmed paint/fade
//   setActivity(info: VeilInfo | null)                               // the payload type moves to src/shared/live-op.ts
// veil.html: window.__curtain(state, ms) → Promise resolved after two rAFs ('opaque') or after the fade ('clear').

// ── src/main/window/app-menu.ts ──────────────────────────────────────────────────────────────
export declare function buildAppMenu(d: { onStage(mode: StageMode): void; isPackaged: boolean; isMac: boolean }): Electron.Menu;

// ── src/main/launch.ts (createWindow extracted from main.ts) ─────────────────────────────────
export declare function launchWindow(env: LaunchEnv): Promise<LaunchHandles>;   // returns win/tab/veil/foundation/composed/…
```

### C.4 Store

```ts
// ── src/store/knowledge-store-base.ts (split-first; pure move) ───────────────────────────────
// KnowledgeStoreBase: opens the DB, runs migrations + assertSchema, owns changed()/onMutation, constructs every
// repo as `protected readonly`, holds the ownPk anchor. `export class KnowledgeStore extends KnowledgeStoreBase`
// keeps every delegation method, so the public surface and the 22 consumers are untouched.

// ── src/store/repos/feed-reads.ts (≤ 200 lines; SQL; store → shared types only) ─────────────
export interface EffectFeedRow { id: string; pk: string; username: string; action: 'follow' | 'unfollow' | 'accept';
  channel: string; result: 'ok' | 'simulated' | 'fail' | 'external' | 'cancelled'; settledAt: number;
  unfollowReason: string | null }
export interface FollowBackFeedRow { pk: string; username: string | null; at: number; dated: boolean; followedAt: number | null }
export interface EdgeFeedRow { pk: string; username: string | null; at: number; dated: boolean }
export declare class FeedReadsRepo {
  constructor(db: SqliteDriver);
  settledEffects(since: number, limit: number): EffectFeedRow[];
  followBacks(since: number, limit: number): FollowBackFeedRow[];          // COALESCE(followed_back_at, followback_observed_at)
  newFollowers(ownPk: string, since: number, limit: number): EdgeFeedRow[];   // active edges into ownPk after the baseline,
                                                                             // NOT EXISTS managed follow-back / accept intent
  lostFollowerCount(ownPk: string, since: number): { at: number; count: number }[];   // removed edges, by detection time
  lastSettledMutationAt(): number | null;                                   // MAX(settled_at) WHERE result IN ('ok','simulated')
}
// KnowledgeStore gains: `readonly feed: FeedReadsRepo` (public field, the chronos/spans precedent) and
// `lastSettledMutationAt(): number | null` (delegation used by status-projection).

// ── src/store/open-error.ts ──────────────────────────────────────────────────────────────────
export declare function classifyOpenError(e: unknown): BootDataProblem;   // future user_version → 'future-version';
                                                                           // SQLITE_BUSY/LOCKED → 'locked'; else 'unreadable'

// ── src/store/schema/feed-index-migration.ts (id allocated centrally) ────────────────────────
// CREATE INDEX IF NOT EXISTS idx_edges_dst_status_first_seen ON edges(dst_pk, type, status, first_seen_at);
// CREATE INDEX IF NOT EXISTS idx_effect_state_settled ON effect_intents(state, settled_at);
```

### C.5 Engine

```ts
// ── src/engine/resume-target.ts (extracted pure pick; target-pipeline.ts −18 lines) ──────────
export interface ResumeTargetReads {
  getTarget(pk: string): Target | null;
  listTargets(): Target[];
}
/** The target the pipeline will adopt next, with NO writes (parity with adoptActiveTargetFromStore is a law). */
export declare function peekResumeTarget(
  store: ResumeTargetReads,
  frontier: { snapshot(): { currentTargetPk: string | null }; next(): { pk: string } | null } | undefined,
): { pk: string; via: 'current' | 'frontier' | 'chain' } | null;
// StatusFields.resumeTarget (§15.3), returned by LD's live-wiring.ts
// status-projection: lastActionAt = engine value ?? store.lastSettledMutationAt()
```

### C.6 Renderer (selected signatures)

```ts
// app/live-signals.ts — the shell's new single subscription points (ADR 1004)
export const feedSignal: Signal<FeedView | null>;
export const activitySignal: Signal<LiveTab | null>;
export const chainListSignal: Signal<ChainTargetView[] | null>;            // owned once (was ×3)
export const pendingControlSignal: Signal<'start' | 'pause' | 'stop' | null>;
export const postureSignal: ReadonlySignal<Posture>;                        // SB's; cached while kind/countdown/primary unchanged
export function resetLiveSignals(): void;                                   // called by resetShellSignals()

// app/clock.ts
export function useNow(granularity: 'second' | 'minute', enabled?: boolean): number;   // ref-counted, boundary-aligned

// app/motion-signal.ts
export const reducedMotionSignal: ReadonlySignal<boolean>;

// lib/play.ts · lib/deadline-anim.ts · lib/flip.ts
export function play(el: Element, frames: Keyframe[], opts: KeyframeAnimationOptions): Promise<void>;   // resolves at once in jsdom / reduced motion
export function armDeadline(el: SVGElement | HTMLElement, c: Countdown, now: number, prop: 'dashoffset' | 'scaleX'): Animation | null;
export function flipInsert(container: HTMLElement, mutate: () => void, opts?: { from?: DOMRect }): void;

// boot/BootGate.tsx
export function BootGate(p: { children: ComponentChildren }): JSX.Element;  // readiness R4, captions, intro, bootRevealed()

// app/StageHost.tsx · app/PopoverHost.tsx
export function StageHost(p: { mode: StageMode; active: boolean; mount: 'eager' | 'on-activation' | 'lazy';   // Graph eager; People/Prune on activation; Settings lazy
  children: ComponentChildren }): JSX.Element;
export interface PopoverRequest { anchor: Element; content: () => JSX.Element; labelledBy: string }
export function usePopover(): { open(r: PopoverRequest): void; close(): void };   // clamps to the sidebar rect on the Live stage

// design/motion-scale.ts
export const PERCEPTION_MS = 100;                       // pinned to EMPIRICAL.DISPLAY.perceptionMs by a test
export const DUR: { readonly 1: 120; readonly 2: 200; readonly 3: 320; readonly 4: 480; readonly 5: 900 };
export const BREATH_MS = 2600;
export const BOOT_UI: { readonly MIN_SPLASH_MS: 600; readonly CAPTION_DELAY_MS: 1200; readonly SLOW_COPY_MS: 2500 };   // 6P, 12P, 25P
```

### C.15 Copy deck

Neutral vocabulary: never "human", "natural", "bot", "emulate", "mimic", "stealth" or "detect" (memory
`neutral-naming-convention`; law L-COPY). Sentence case. Times use `Intl.DateTimeFormat(undefined, { hour:
'numeric', minute: '2-digit' })` (respects 12/24 h); plurals use `Intl.PluralRules`. Every number comes from a
projection, never a literal.

### C.15.1 Postures (`copy/posture-copy.ts`)

| Kind | Headline | Sentence (the now line when no live op) | Next line |
|---|---|---|---|
| `data-unavailable` | Can't open your data | `future-version`: "This data was saved by a newer Epo. Update Epo to open it." · `unreadable`: "Epo couldn't read its data file. Diagnostics has details." · `locked`: "Another copy of Epo may be open. Close it, then reopen Epo." | — |
| `signed-out` | Signed out | "Sign in to Instagram on the Live tab. Your login stays on this computer." | — |
| `needs-attention` | Needs attention | the attention sentence (C.15.2) | reason line: "Scheduled work waits until you press Start." |
| `sleeping` | Sleeping | "Your computer is asleep. Epo continues when it wakes." | — |
| `reconnecting` | Reconnecting | "Checking the Instagram page after sleep." · recovering: "Getting the Instagram page ready again." | — |
| `offline` | Offline | "Waiting for your internet connection. Epo picks up where it left off." | — |
| `cleaning-up` | Cleaning up · Clean-up paused | scanning: "Checking who follows you back · 1,200 of 1,450" · running: "Unfollowing people who don't follow back · 12 of 40" · paused: "Paused by you. Press Resume to continue." | "Next unfollow in 0:42" |
| `catching-up` | Catching up | the running step: "Opening your profile" · "Confirming your account" · T5's step names ("Checking your notifications", "Looking at your newest followers") | stopped: "You can press Start anytime." · queued: "Epo starts right after this check." |
| `starting` | Starting | "Getting the first step ready." | — |
| `paused` | Paused | "Paused by you. Press Resume to continue." · after a restart: "You paused Epo before it closed. Press Resume to continue." | — |
| `needs-seed` | Let's get set up | "Choose a starting account whose followers look like your audience." | — |
| `stopped` | Stopped | "Press Start when you're ready." · with history: "Last active Mon 11:20 PM." | when a plan exists: "Today's plan: about 40 actions in 4 sessions" |
| `taking-a-break` | Taking a break | "Instagram is limiting activity right now." | "Trying again at 4:10 PM · attempt 2 of 3" (`status.recovery`) |
| `day-off` | Day off | "Epo takes today off. Back tomorrow." — only on a day **you** set off (`plan.day.dayOff`) | "Next session tomorrow at 9:04 AM" |
| `done-for-today` | Done for today | "Today's plan is done." · ceiling: "Today's limit is reached." · late start: "Today's sessions had already passed when Epo opened." · zero-volume light day: "Light day — no actions planned today." | "Next session tomorrow at 9:04 AM" |
| `pacing` | Pacing | velocity: "Keeping an even pace this hour." · read-budget: "Saving profile visits for later." | "Continuing at 3:40 PM" |
| `retrying` | Retrying soon | enrich: "Couldn't look at profiles just now." · reconcile: "Couldn't check follow-backs just now." | "Trying again at 3:05 PM" |
| `resting` | Resting | "Between sessions." | "Next session at 2:40 PM" |
| `working` | Working | the live op sentence; else "Finding people through @studio.lumen's followers" (source); Boost: "Finding and following new people"; careful: "Checking that Instagram's limit has lifted" | "Next step in 1:12" |

- **Primary labels:** Start · Starting… · Pause · Resume · Sign in · Set up · Pause pruning · Resume pruning ·
  Open Live · Choose account · Check for updates · Open Prune · Diagnostics.
- **Secondary labels:** Stop · Stop pruning · Start.
- **Stop toast:** "Stopped. Today's progress is kept. [Undo]".
- **Pills** (indicators only): "⚡ Boost" · "Practice".

### C.15.2 Attention (`copy/attention-copy.ts`; exhaustive over `KnownBlockKey`)

| Key(s) | Sentence | Action |
|---|---|---|
| `account-changed`, `identity-changed` | A different Instagram account is signed in. Switch back on the Live tab, or press Start to continue with this one. | show-live |
| `login-required`, `sentinel:logged-out` | Instagram signed you out. Sign in on the Live tab, then press Start. | show-live |
| `account-identity-unavailable` | Epo couldn't confirm which account is signed in. Check the Live tab, then press Start. | show-live |
| `sentinel:challenge` | Instagram wants to confirm it's you. Follow its steps on the Live tab, then press Start. | show-live |
| `sentinel:action-blocked` | Instagram has paused some of your account's actions. Check the Live tab. Epo waits until you press Start. | show-live |
| `sentinel:ok` | Epo stopped to check your session. Press Start to continue. | start |
| `rate-limited`, `blocked-repeatedly` | Instagram refused several actions in a row. Giving it time usually helps. Press Start when you're ready. | start |
| `recovery-exhausted` | Instagram kept limiting actions, even after {maxAttempts} breaks. Check the Live tab, then press Start. ({maxAttempts} from `status.recovery`, else the clause is omitted) | show-live |
| `actions-failing` | Several actions in a row didn't go through. Check the Live tab, then press Start. | show-live |
| `adapter-drift` | Instagram changed something Epo doesn't recognise yet. An Epo update may fix this. | check-update |
| `chain-exhausted`, `no-current-target` | Epo ran out of new people to find from your starting account. Choose a new one. | choose-seed |
| `seed-missing` | Choose a starting account so Epo knows where to find people. | choose-seed |
| `seed-unresolved` | Epo couldn't open your starting account. Check the spelling, or choose another. | choose-seed |
| `runtime-error` | Something unexpected stopped Epo. Press Start to try again. | start |
| `scan-failed`, `run-failed` | Pruning stopped early. Your previous check is kept. Try again from the Prune page. | open-prune |
| `actions-unconfirmed` | Epo couldn't confirm its last {n} {unfollows/follows}, so they wait until the next session. If it happens again, Epo takes a break. | wait |
| `runtime-recovery-exhausted` | The Instagram page needed several repairs in a short time. Check the Live tab, then press Start. | show-live |
| `tab-recovery-failed`, `wake-recovery-failed`, `wake-sentinel-failed`, `wake-reconciliation-failed` | The Instagram page didn't recover by itself. Check the Live tab, then press Start. | show-live |
| `automatic-resume-failed` | Epo couldn't pick up where it left off. Press Start to continue. | start |
| `runtime-state-persist-failed` | Epo couldn't save its progress. Check that your disk has free space, then restart Epo. | restart-app |
| `runtime-state-unreadable` | Epo couldn't read its saved progress. Your data is safe. Press Start to continue. | start |
| `startup-failed`, `dashboard-recovery-exhausted` | Epo had trouble starting and stopped its work. Diagnostics has details. | diagnostics |
| `data-clear-in-progress` | Clearing your data… | wait |
| unknown | Something needs a look before Epo continues. Diagnostics has details. · (muted) Code: {raw} | diagnostics |

These replace the hard-coded "after 3 long backoffs (~4h)" (`live-status-copy.ts:170`) and "Three device
repairs … within an hour" (`runtime-copy.ts:14`).

### C.15.3 "Why?" (`copy/explain-copy.ts`)

| Topic | Text |
|---|---|
| resting | Epo works in a few sessions spread across the day instead of all at once. Today's plan has {n}. Their times and sizes change from day to day. |
| pacing-hour | Epo keeps an even pace within each hour and continues as soon as the hour has room again. |
| pacing-visits | Epo looks at a limited number of profiles each day to stay within safe limits. More become available at {time}. |
| retrying | A read didn't work just now. Epo waits a little and tries again. |
| taking-a-break | Instagram declined recent actions. Epo waits before trying again, a little longer each time (attempt {n} of {max}). If it still can't act after the last attempt, it stops and tells you. |
| done-for-today | Each day has a plan. When it's done, Epo rests until tomorrow's first session. |
| day-off | You chose to keep today free. Epo does no automatic work on your days off and picks up tomorrow. |
| done-for-today (late start, light day) | When Epo opens after today's sessions have passed, or on a light day with nothing planned, it rests until tomorrow's first session. Missed sessions are not made up later. |
| catching-up | Things changed while Epo was closed. It checks only what changed since it last ran: your profile, your notifications and your newest followers. + T5's step checklist |
| boost | from T2's `copy/boost.ts` ("Boost has Epo spend the next hours finding and following new people…") |
| practice | Practice mode: follows and unfollows are simulated, so nothing changes on your account. Epo still reads Instagram. |

### C.15.4 Refusals (the Now reason line; `copy/refusal-copy.ts`)

| Reason | Text |
|---|---|
| `prune-running` | Pruning is using Instagram. Epo starts when it finishes. |
| `manual-running` | Epo is finishing a quick task. Try again in a moment. |
| `starting` | One moment — Epo is finishing starting up. |
| `runtime-not-ready` | Epo needs your attention first (see above). |
| `offline` | You're offline. Epo starts when you're back online. |
| `not-logged-in` | Sign in to Instagram first. |
| `engine-running` | Epo is busy. Pause it first. |
| `boost-active` | Boost is on. End Boost to run Prune now. |
| `nothing-to-shift` | Today has no unfollows to swap for follows, and Epo is already working. |
| `backlog` | Too many unfollows are still waiting from earlier Boosts. Boost is available again in about {d} days. |
| any other | That didn't work. Diagnostics has details. |

### C.15.5 Today, Results, Get started, Footer

- **Today:**
  - "Today's plan" · "{a} of {b} follows · {c} of {d} unfollows";
  - "This session until about {t}" · "Next session at {t}" · "Today's plan is done · next session tomorrow at {t}";
  - T1's plan notes ("Light day — about {n} actions.", "Opened later today — the plan covers the rest of the day
    (about {n} actions).");
  - no plan: "Your plan for today appears once Epo has made it.";
  - block popover: "Session {i} · {start}–{end} · {done} of {planned} · {relaxed|normal|quick} pace" · "Skipped —
    Epo wasn't running" · "Before Epo opened".
- **Results:**
  - "{±n} followers today" with the tooltip "Followers gained minus followers lost since today's plan began at
    {t}.";
  - "{n} followers · checked {t}" · "· checking now…" · "Epo shows your follower count after it opens your
    profile.";
  - "{n} follow-backs today · {m} waiting";
  - "· updating…" while catching up;
  - signed out: "Your numbers appear after you sign in.";
  - deadline reveal: "Loading your numbers…".
- **Get started:** "Get started" · "{k} of 3" · "Sign in to Instagram" · "Choose a starting account" · "Press
  Start" · [Choose →].
- **Footer:** "Epo {version}" · "Update ready · Restart" · "Update available · View" · "Diagnostics".
- **Boost:** the Appendix B copy (`src/renderer/copy/boost.ts`, F2b → SU).

### C.15.6 Feed (`copy/feed-copy.ts`)

| Kind | Copy |
|---|---|
| followed | "Followed @jane" · grouped "Followed 6 people · @a, @b +4" · Boost suffix "· Boost" · you: "You followed @jane" · practice: "Practice: would follow @jane" |
| unfollowed | "Unfollowed @carl · didn't follow back" · "· after following back" · "· Pruned" · "You unfollowed @carl" · practice: "Practice: would unfollow @carl" |
| followed-back | "@bob followed you back" (+ "· 2 days after you followed" when dated) |
| new-followers | dated: "@dana started following you" · grouped "3 new followers · @a, @b +1" · undated: "Found 3 new followers" |
| lost-followers | "2 people stopped following you" (a count only; owner Q30) |
| request-accepted | "Accepted @erin's follow request" |
| not-done | "Couldn't follow @jane — Instagram didn't confirm it" · "@jane's profile isn't available — skipped" · "Instagram didn't let Epo follow @jane — trying later" |
| kept | "Kept @friend · protected" (+ T2's reason copy) |
| boost | "Boost started — focusing on new people until 9:40 PM" · "Boost ended" (by you) · "Boost finished" (expired) · "Boost ended — your computer's clock changed" (clock) |
| slowed-down | "Instagram asked Epo to slow down — trying again at 4:10 PM" |
| resumed | "Epo picked up where it left off after closing unexpectedly" |
| caught-up | "While you were away: 14 new followers · 6 follow-backs · 2 left" · or "While you were away: nothing new" |
| divider | "Since you left · Mon 11:20 PM" |
| group headers | "Today" · "Yesterday" · weekday · date |
| empty | "Nothing yet today. Activity shows up here as Epo works." |
| null username | "someone" |

### C.15.7 Live ops, boot, stage bar, People, tour

- **`liveOpText`:**
  - "Following @jane" · "Unfollowing @carl" · "Accepting @dana's follow request";
  - "Opening @studio.lumen's followers" · "Scrolling @studio.lumen's followers · 120" · "Reading @studio.lumen's followers · 120 of 250" ·
    own lists: "Reading your followers · 1,200";
  - "Looking at profiles · 3 of 20";
  - "Checking whether @bob follows you back" · "Double-checking @bob before acting" · "Confirming what happened
    with @bob" · "Checking @bob";
  - "Checking your notifications" · "Opening your profile" · "Confirming your account".
  - the veil chip shows the same sentence (SB rewrites the Phase F `toVeilInfo` identity test).
- **Splash:** "Opening your data…" · "Opening Instagram…" (while the landing runs behind the splash) · "Almost there…" ·
  "Still loading — this can take a moment.".
- **Live placeholder:** "Opening Instagram…" · "Instagram can't load while you're offline. Epo reloads it when
  you're back online. [Try again]".
- **Stage bar:** the tab labels and tooltips of §12.4. Context: "Epo is using this page" · "Epo uses this page
  again in {m:ss}" · "You can browse freely".
- **People:** "Your followers over time" · "Where Epo finds people" · "In progress" · lanes "Up next", "Waiting",
  "Following back", "Leaving soon", "Kept".
  - One empty state replaces today's three phrasings (U05 §7.15): "No sources yet. Choose a starting account in
    Settings and press Start."
- **Tour** (anchors: `now`, `today`, `results`, `feed`, `stageseg`, T2's `seed`, `stagebody`):
  1. **Welcome** (Graph stage): "Epo grows your Instagram audience a little every day, following a plan it makes
     for you. Here's a one-minute tour."
  2. **Now:** "This always says what Epo is doing and why: the step happening now, what's next, and when."
  3. **Today:** "Each day Epo plans a few sessions. The strip shows them; the bright one is now. Boost puts the
     rest of today into finding new people."
  4. **Results:** "Your results: followers gained today, your follower count, and who followed back."
  5. **Activity:** "Everything Epo did, including what happened while you were away."
  6. **Stage bar** (Live stage, card docked over the sidebar): "Live shows Instagram as Epo uses it; sign in
     there first. People, Graph and Prune show who Epo works with. Settings is where you choose how Epo works.
     ⌘1–⌘5 switch pages."
  7. **Settings:** T2's step.
  8. **Done:** "Sign in on the Live tab, choose a starting account, and press Start. You can replay this tour
     from Settings."
- **New-look tour** (once after updating; steps 2, 3, 5, 6): toast "Epo has a new look. [Take the tour]" (owner Q30).

---

## Appendix D — Parse-resilience contracts, guard lines and copy (normative)

Reconciled from T4 §11 and §16 with §14 (C20, C24) and revision 2 (`source-rows`, `exploration`, `maxWalkPages`, the
one `PlanDayClock`, `errors[]` as evidence, `confirm-unrecognized`). The `SURFACE_BOUNDS` and `CENSUS_POLICY` doc
comments below are their guard lines. Where a line here and §1–§24 disagree, §1–§24 win.

### D.1 Interfaces

```ts
// ── src/kernel/surface-policy.ts (tier-1 guardrails; imports nothing; none is an IG-facing timing) ──
export const SURFACE_BOUNDS = {
  /** Guards the structural search against pathological bodies. */           searchMaxNodes: 20_000,
  /** Guards recursion on hostile JSON (profile records nest ≤ 4 today). */   searchMaxDepth: 12,
  /** Bodies above this read canonically or fail; never searched. */          searchMaxBytes: 4_000_000,
  /** Share of sampled elements that must be rows; share of a page's rows that must read. */ rowMajority: 0.9,
  /** Identity-continuity conflict share that rejects a location (renames are legitimate). */ identityConflictMax: 0.05,
  /** Unrouted GraphQL refs buffered per armed context (references, not bodies). */ fallbackCandidates: 8,
  /** Array elements sampled by novelty and the locator (rows share a shape). */ sampleRows: 8,
  /** Novelty walk depth (moved from lab/shape.ts). */                        noveltyMaxDepth: 6,
  /** Drift signatures kept per endpoint; informational ones evicted first. */ maxSignaturesPerEndpoint: 200,
  /** One scrubbed sample's size cap. */                                       sampleMaxBytes: 16_384,
  /** Samples written per plan-day across all signatures. */                   samplesPerDay: 12,
  /** Plan-days of health rows kept. */                                        healthRetentionDays: 30,
  /** Days a resolved drift signature is kept. */                              driftRetentionDays: 90,
  /** Latency samples per metric (moved from surface/meter.ts). */            meterReservoir: 128,
  /** Unmatched POSTs a mutation window keeps (moved from mutation-watch.ts). */ unmatchedPostsKept: 12,
  /** Non-JSON head kept in a log line / an envelope (moved from 2026-08-12.ts, fetch-json.ts). */
  logHeadChars: 80, envelopeHeadChars: 256,
  /** Request-body capture cap (owner Q31 only). */                                   requestBodyMaxBytes: 65_536,
  /** Scrubbed counts: keep this many significant digits at or above the floor. */ scrubCountDigits: 2, scrubCountFloor: 100,
} as const;
// Every streak / consistency / auto-resolve count reuses driftConfirmThreshold() (kernel/derive.ts) — no new number.

// ── src/kernel/census-policy.ts ──────────────────────────────────────────────────────────
export const CENSUS_POLICY = {
  /** Headers below this skip the scan-coverage net: tiny accounts are ghost-dominated (was prune-engine.ts:1163). */
  coverageFloor: 50,
  /** Share of the refreshed header a census walk must list or the scan aborts (was prune-engine.ts:1164). */
  scanCoverageMin: 0.85,
  /** r2: five runaway bounds (5 × LIST_WALK_MAX_PAGES); a census longer than this is never one uninterrupted walk. */
  maxWalkPages: 1_000,
} as const;

// ── src/surface/schema/projection.ts (moved + extended) ──────────────────────────────────
export type Tier = 'canonical' | 'normalized' | 'recovered';
export type JsonType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null' | 'absent';
export type FieldIssueKind = 'expected-absent' | 'unexpected-null' | 'invalid' | 'counts-partial' | 'id-conflict'
  | 'id-space' | 'unsafe-number' | 'time-range' | 'enum-novel';
export interface FieldIssue { readonly path: string; readonly kind: FieldIssueKind; readonly got?: JsonType }
export interface RowIssue { index: number; path: string; message: string }               // unchanged
export interface RelationshipFact {                                                       // booleans NULLABLE: absent = unknown
  pk: string; following: boolean | null; outgoingRequest: boolean | null;
  followedBy: boolean | null; incomingRequest: boolean | null; isPrivate?: boolean;
}
export type Presence = 'read' | 'absent' | 'null' | 'invalid' | 'partial' | 'withheld';
export interface ProfilePresence {
  readonly counts: Presence;        // 'read' only for a valid pair
  readonly bio: Presence;           // 'read' covers '' and text; explicit null remains unread (§7.3)
  readonly isPrivate: Presence; readonly isVerified: Presence;
  readonly relationship: Presence | 'self';
}
export type Continuation =
  | { readonly kind: 'next'; readonly cursor: string; readonly form: 'offset' | 'opaque' }
  | { readonly kind: 'end'; readonly evidence: 'flags-false' | 'no-flags'; readonly vetoKey?: string }
  | { readonly kind: 'drift'; readonly reason: 'more-without-cursor' | 'incomplete-stream'; readonly key?: string };
export interface Projection {
  facts: Observation[]; relationships: RelationshipFact[]; events: FollowEvent[];
  cursor: string | null; hasMore: boolean;            // derived from continuation (manifest compatibility)
  continuation: Continuation | null;                  // list-shaped endpoints only
  absent: boolean | null; rowIssues: RowIssue[]; fieldIssues: FieldIssue[];
  presence: ProfilePresence | null;                   // profile endpoints only
  pendingPreview: Observation[];                      // activity-feed side list (never complete)
  viewerPk: string | null;                            // profile-graphql only (I10)
}

// ── src/surface/read/types.ts ───────────────────────────────────────────────────────────
export type StepKind = 'framing' | 'alternate-container' | 'alias-key' | 'retype' | 'root-field-route';
export interface NormalizeStep { readonly kind: StepKind; readonly at: string; readonly detail?: string }
export type RouteVia = 'url' | 'header' | 'form' | 'root-field' | 'learned' | 'candidate';
export interface RequestFacts { readonly subjectId?: string; readonly feedFilter?: string }   // owner Q31 only
export interface RouteMatch {
  readonly kind: EndpointKind; readonly defIndex: number; readonly via: RouteVia;
  readonly op: string | null; readonly request?: RequestFacts;
}
export type WallFamily = 'rate-limited' | 'auth' | 'server-error';
export type ReadFailure =
  | { readonly ok: false; readonly kind: 'wall'; readonly family: WallFamily; readonly via: 'http' | 'html' | 'graphql';
      readonly status: number; readonly detail: string }
  | { readonly ok: false; readonly kind: 'http-absent'; readonly status: 404 }
  | { readonly ok: false; readonly kind: 'not-data'; readonly status: number; readonly mime: string }
  | { readonly ok: false; readonly kind: 'transport'; readonly reason: 'empty' | 'invalid-json' | 'bad-frame' }
  | { readonly ok: false; readonly kind: 'mismatch'; readonly issues: ReadonlyArray<{ path: string; message: string }>;
      readonly keys: readonly string[] }                                    // keys of the DECODED body, never values
  | { readonly ok: false; readonly kind: 'ambiguous'; readonly candidates: number }
  | { readonly ok: false; readonly kind: 'rows-unreadable'; readonly rows: number; readonly quarantined: number };
export interface ReadMeta {
  readonly endpoint: EndpointKind; readonly tier: Tier; readonly partial: boolean;
  readonly steps: readonly NormalizeStep[]; readonly route: RouteVia; readonly novelKeys: readonly string[];
  readonly located?: { readonly role: RecoveryRole; readonly pattern: string; readonly via: 'hint' | 'search' };
}
export type SurfaceRead = ({ readonly ok: true; readonly projection: Projection } & ReadMeta)
  | (ReadFailure & { readonly endpoint: EndpointKind });
export type BodyInput = { readonly text: string; readonly status?: number; readonly mime?: string }
  | { readonly decoded: Decoded; readonly status?: number; readonly mime?: string };
export interface Anchor { readonly username?: string; readonly pk?: string }
export type Arm = 'visit' | 'drawer' | 'requests-panel' | 'acquisition';   // 'acquisition': the source-rows role only (r2)
export interface ReadCtx {
  readonly at: number; readonly source: Source; readonly pk?: string;   // pk: friendship-show subject from the URL
  readonly route?: RouteMatch; readonly anchor?: Anchor; readonly arm?: Arm;
}
export interface ReadEnv { readonly doc: SurfaceDocument; readonly sink: SurfaceSink; readonly hints: HintBook; readonly identity?: IdentityOracle }

// ── src/surface/read/read.ts — THE parser ──────────────────────────────────────────────
/** Never throws (L-TOTAL). Counts and drift go to env.sink. `kind` + optional ctx.route select the definition. */
export function readBody(kind: EndpointKind, input: BodyInput, ctx: ReadCtx, env?: ReadEnv): SurfaceRead;
/** C2 recovery on an already-decoded body for a role; requires the role's anchor/arm. */
export function recoverBody(kind: EndpointKind, decoded: Decoded, ctx: ReadCtx, env?: ReadEnv): SurfaceRead;
export function admits(sink: SinkClass, m: Pick<ReadMeta, 'tier' | 'partial'>): boolean;      // read/admission.ts

// ── src/surface/read/{relationship,continuation,fields,gate,route}.ts ───────────────────
export function readRelationship(record: Record<string, unknown>, keys: RelationshipKeys, pk: string): RelationshipFact;
export function weFollowOf(r: Pick<RelationshipFact, 'following' | 'outgoingRequest'>): boolean | null;
export function mintObserved(read: SurfaceRead, facts: readonly RelationshipFact[]): ObservedRelation[]; // the ONLY mint
export function continuationOf(page: Record<string, unknown>, decl: ContinuationDecl, opts: { final: boolean | null })
  : { continuation: Continuation; steps: NormalizeStep[] };
export function readId(record: Record<string, unknown>, decl: IdDecl): { pk: string; step?: NormalizeStep } | { issue: FieldIssue };
export function readCountPair(record: Record<string, unknown>, keys: CountKeys)
  : { followers: number; following: number; mutuals?: number; steps: NormalizeStep[] } | { issue: FieldIssue } | null;
export function readBool(record: Record<string, unknown>, key: string): { value: boolean } | { presence: Presence };
export function readEpochSeconds(v: unknown, atMs: number): { ms: number } | { issue: FieldIssue };
export type Gate =
  | { readonly kind: 'data' }
  | { readonly kind: 'wall'; readonly family: 'rate-limited' | 'auth'; readonly via: 'http' | 'html'; readonly status: number }
  | { readonly kind: 'http-absent' }
  | { readonly kind: 'not-data'; readonly status: number; readonly mime: string };
export function gateObserved(status: number, mime: string, parseableMime: RegExp, head?: string): Gate;
export interface ObservedRequest { readonly url: string; readonly method?: string;
  readonly requestHeaders?: Record<string, string>; readonly requestBody?: string }
export function routeObserved(req: ObservedRequest, env?: Pick<ReadEnv, 'doc' | 'hints'>): RouteMatch | null;
export function opNameOf(req: ObservedRequest, decl: TransportDecl): string | null;
export function opFamilyOf(op: string, decl: RecoveryDecl): EndpointKind | null;

// ── src/surface/transport/{decode,graphql}.ts ──────────────────────────────────────────
export interface TransportDecl {
  readonly jsonGuards: readonly string[]; readonly finalFlagPath: string | null;
  readonly incremental: { readonly path: string; readonly data: string; readonly items: string; readonly list: string };
  readonly formOpKey: string; readonly rootFieldHeader: string; readonly friendlyNameHeader: string;
}
export type Decoded =
  | { readonly ok: true; readonly json: unknown; readonly format: 'json' | 'guarded' | 'ndjson' | 'multipart';
      readonly payloads: number; readonly final: boolean | null }
  | { readonly ok: false; readonly reason: 'empty' | 'invalid-json' | 'bad-frame'; readonly head: string };
export function decodeBody(text: string, decl: TransportDecl): Decoded;
export interface GraphqlDecl { readonly errorsKey: string; readonly dataKey: string; readonly errorTextKeys: readonly string[] }
export type GraphqlOutcome =
  | { readonly kind: 'not-graphql' } | { readonly kind: 'data'; readonly errors: number }
  | { readonly kind: 'wall'; readonly status: 'action-blocked' | 'challenge' | 'logged-out'; readonly text: string }
  | { readonly kind: 'error'; readonly text: string };
export function graphqlEnvelope(json: unknown, rootPresent: (data: unknown) => boolean, decl: GraphqlDecl,
  signatures: ReadonlyArray<{ pattern: RegExp; status: string }>): GraphqlOutcome;
export function graphqlErrorText(json: unknown, decl: GraphqlDecl): string | null;   // all errors × text keys

// ── per-version declarations (src/surface/versions/2026-08-12/*.ts; IG literals live ONLY here) ──
export interface ContainerDecl {
  readonly at: string;                       // '' = the body itself
  readonly kind: 'object' | 'connection';
  readonly connection?: { readonly edges: string; readonly node: string; readonly cursor: string; readonly hasNext: string };
  readonly absentWhenNull?: true;
  readonly evidence: string;                 // e.g. '2026-11-02 verify: 11/11'
}
// EndpointDef gains: containers: readonly [ContainerDecl, ...ContainerDecl[]]; rootFields?: readonly string[];
//   sideLists?: { readonly pendingPreview: string }. `mode` is removed in S8.
export interface ContinuationDecl {
  readonly cursorKeys: readonly string[]; readonly moreFlags: readonly string[]; readonly offsetCursor: RegExp;
  readonly explainedPageKeys: readonly string[]; readonly cursorName: RegExp; readonly moreFlagName: RegExp;
  readonly composedForm: { readonly followers: 'paged'; readonly following: 'whole-list' };
}
export interface RecoveryDecl {
  readonly idKeys: readonly string[];                 // ['pk','pk_id','id','strong_id__']
  readonly foreignIdKeys: readonly string[];          // ['fbid_v2','fbid','interop_messaging_user_fbid']
  readonly handleKey: string; readonly handleRe: RegExp;          // 'username', USERNAME_RE (1–30)
  readonly profileCountKeys: { readonly followers: string; readonly following: string; readonly mutuals: string };
  readonly relationshipKeys: RelationshipKeys;        // following, outgoing_request, followed_by, incoming_request
  readonly foreignContainers: Readonly<Partial<Record<EndpointKind, readonly string[]>>>;
  readonly followStoryTypes: readonly number[]; readonly knownStoryTypes: readonly number[];   // [101], [101, 651]
  readonly storyActorKey: string; readonly storyActorAliases: readonly string[];               // profile_id; inline_follow…, users.0.pk
  readonly followText: RegExp; readonly requesterMarker: string;  // 'friendship_status.incoming_request'
  readonly opFamilies: ReadonlyArray<{ readonly kind: EndpointKind; readonly pattern: RegExp }>; // ordered: requests, feed, profile
  readonly mutationFamily: RegExp;                    // /follow|friend|relationship/i
}
export const EXPECTED_KEYS: Readonly<Partial<Record<EndpointKind, readonly string[]>>>;   // expected.ts
export const NOVELTY_BASELINE: Readonly<Partial<Record<EndpointKind, readonly string[]>>>; // expected.ts (freshness-tested)

// ── src/surface/recovery/{locate,signatures,hints}.ts ──────────────────────────────────
export type RecoveryRole = 'profile-user' | 'username-field' | 'feed-stories' | 'request-rows'
  | 'source-rows';   // r2: a source's followers page in an ACQUISITION walk only; rows → candidate pool; continuation never recovered
export interface HintBook {
  patterns(endpoint: EndpointKind, role: RecoveryRole): readonly string[];      // consistent first, then open
  learnedOps(): ReadonlyArray<{ readonly op: string; readonly kind: EndpointKind }>;   // consistent only
}
export interface IdentityOracle { usernameOf(pk: string): string | undefined }
export const NO_HINTS: HintBook;
export interface LocateInput {
  readonly role: RecoveryRole; readonly endpoint: EndpointKind; readonly body: unknown; readonly bodyBytes: number;
  readonly anchor?: Anchor; readonly arm?: Arm; readonly decl: RecoveryDecl;
  readonly hints: readonly string[]; readonly identity?: IdentityOracle;
}
export type Located =
  | { readonly ok: true; readonly path: string; readonly pattern: string; readonly via: 'hint' | 'search';
      readonly value: unknown; readonly contradictedHint?: string }
  | { readonly ok: false; readonly reason: 'not-found' | 'ambiguous' | 'anchor-required' | 'arm-required'
      | 'identity-conflict' | 'budget' | 'too-large'; readonly candidates: number };
export function locate(input: LocateInput): Located;
export function usernameFieldOf(record: Record<string, unknown>, anchor: Anchor): string | null; // exactly one top-level match

// ── src/surface/sink.ts ────────────────────────────────────────────────────────────────
export type DriftEndpoint = EndpointKind | 'mutation' | 'route';
export type DriftClass = 'normalized' | 'recovered' | 'unrouted' | 'expected-absent' | 'unexpected-null'
  | 'more-without-cursor' | 'cursor-veto' | 'end-claim-false' | 'no-continuation-evidence' | 'rows-unreadable'
  | 'row-issue' | 'mismatch' | 'ambiguous' | 'transport' | 'graphql-error' | 'graphql-partial' | 'incomplete-stream'
  | 'wall' | 'novel-key' | 'enum-novel' | 'shadow-disagreed'
  | 'confirm-unrecognized';   // r2: a later confirm layer whose text pass missed; nothing is pressed (§11.1 F3)
export interface DriftSignal {
  readonly endpoint: DriftEndpoint; readonly cls: DriftClass;
  readonly path: string;                                         // pattern; never a value
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;  // types, op names, counts
  readonly hint?: { readonly role: RecoveryRole; readonly pattern: string; readonly subject: string | null; readonly agreed: boolean };
  readonly sample?: () => unknown;                               // decoded body; scrubbed by the sink, first sighting only
}
export type ReadTally = 'canonical' | 'normalized' | 'recovered' | 'failed' | 'wall' | 'shadow-disagreed';
export interface SurfaceSink {
  read(endpoint: DriftEndpoint, tally: ReadTally, issues: { readonly rows: number; readonly fields: number }, at: number): void;
  drift(signal: DriftSignal, at: number): void;
}
export class MemorySink implements SurfaceSink, HintBook { snapshot(): SurfaceHealthSnapshot /* … */ }

// ── src/surface/health-view.ts (pure) ──────────────────────────────────────────────────
export function areaOf(endpoint: DriftEndpoint): SurfaceArea;
export function deriveAreas(rows: readonly DriftRowView[], health: readonly HealthRowView[], today: string,
  threshold: number): ReadonlyArray<{ area: SurfaceArea; state: AreaState; paused: readonly PausedActivity[]; since: number | null }>;

// ── src/shared/observed-relation.ts ────────────────────────────────────────────────────
declare const observed: unique symbol;
/** A relationship read with EVERY key it depends on present, from a C0/C1 non-partial read. */
export type ObservedRelation = { readonly pk: string; readonly weFollow: boolean; readonly [observed]: true };

// ── src/shared/surface-health.ts (renderer-safe; pure) ─────────────────────────────────
export type SurfaceArea = 'profiles' | 'notifications' | 'follow-requests' | 'lists' | 'relationship-checks' | 'follow-actions';
export type AreaState = 'ok' | 'adapting' | 'paused' | 'unreadable' | 'limited' | 'unseen';
export type PausedActivity = 'unfollows' | 'relationship-reads' | 'cleanup' | 'follow-back-decisions'
  | 'exploration';           // r2: lists drifted on driftConfirmThreshold() source pages → no composed acquisition requests
// SurfaceGate and NEVER_PAUSED land in F2a's src/shared/surface-gate.ts and are re-exported here.
export interface SurfaceSummary {
  readonly revision: number;
  readonly worst: AreaState;                               // worst area
  readonly areas: Readonly<Record<SurfaceArea, AreaState>>;
  readonly paused: readonly PausedActivity[];
  readonly adapting: boolean;
  readonly attention: ReadonlyArray<{ readonly area: SurfaceArea; readonly state: AreaState;
    readonly paused: readonly PausedActivity[]; readonly since: number }>;
}
export interface SurfaceReport {
  readonly surfaceId: string; readonly generatedAt: number;
  readonly areas: ReadonlyArray<{ area: SurfaceArea; state: AreaState; paused: readonly PausedActivity[];
    lastReadAt: number | null; today: { canonical: number; normalized: number; recovered: number; failed: number;
    walls: number; rowIssues: number; fieldIssues: number } }>;
  readonly changes: ReadonlyArray<{ area: SurfaceArea; endpoint: string; cls: string; field: string | null;  // FIELD_LABEL key
    path: string; firstSeenAt: number; lastSeenAt: number; seen: number;
    state: 'open' | 'consistent' | 'contradicted'; witnesses: number; hint: string | null; hasSample: boolean }>;
  readonly meter: Readonly<Record<'hydration' | 'mutation-arrival' | 'list-page' | 'body-read' | 'scroll-settle',
    { n: number; p50: number | null; p95: number | null }>>;
  readonly copyText: string;             // main-built; no usernames, pks or values; samples included (scrubbed)
}
export const AREA_LABEL: Readonly<Record<SurfaceArea, string>>;
export const STATE_LABEL: Readonly<Record<AreaState, string>>;
export const PAUSED_LABEL: Readonly<Record<PausedActivity, string>>;
export const FIELD_LABEL: Readonly<Record<string, string>>;      // path pattern → friendly name (D.2)

// ── src/main/services/surface-{health-sink,report,gate}.ts ─────────────────────────────
// PlanDayClock is the one port of §5.15 / Appendix A (window(t), dayKey(t), onRoll(fn)); the sink keys health rows by
// dayKey(at) and flushes on onRoll.
export function createSurfaceHealthSink(d: { store: KnowledgeStore; surfaceId: string; day: PlanDayClock; clock: Clock;
  scrub: (endpoint: DriftEndpoint, decoded: unknown) => string | null }): SurfaceSink & HintBook & IdentityOracle
  & { flush(): void; dispose(): void };
export function createSurfaceReport(d: { store: KnowledgeStore; surfaceId: string; day: PlanDayClock; clock: Clock;
  threshold: number }): { summary(): SurfaceSummary; report(): SurfaceReport; gate: SurfaceGate };
export interface SurfaceGate { paused(activity: PausedActivity): boolean }

// ── src/store/repos/surface-drift.ts (imports only store + shared; structural port) ─────
export class SurfaceDriftRepo {
  upsertSignal(s: { signature: string; surfaceId: string; endpoint: string; cls: string; path: string; detail: string;
    at: number; sample?: string | null; hintPattern?: string | null }): { firstSighting: boolean; row: DriftRow };
  witness(signature: string, subject: string, agreed: boolean, at: number, consistentAfter: number): DriftRow;
  noteCleanRead(surfaceId: string, endpoint: string, path: string | null, at: number, resolveAfter: number): number;
  addHealth(day: string, surfaceId: string, endpoint: string, delta: HealthDelta, at: number): void;
  openSignatures(surfaceId: string): DriftRow[];
  health(surfaceId: string, sinceDay: string): HealthRow[];
  resolveOtherSurfaces(activeSurfaceId: string, at: number): number;
  prune(now: number, keep: { healthDays: number; driftDays: number; maxPerEndpoint: number }): void;
}

// ── src/adapter/observed-reads.ts ──────────────────────────────────────────────────────
export interface ObservedRead { readonly route: RouteMatch; readonly decoded: Decoded | null; readonly read: SurfaceRead }
export class ObservedReads {
  constructor(reader: Reader);
  /** Gate + decode + C0/C1 read, memoized per TabResponse (WeakMap): ONE body read, ONE decode, health counted once. */
  read(resp: TabResponse): Promise<ObservedRead> | null;                  // null when unrouted
  /** Buffer unrouted GraphQL refs for an armed context; recover() reads them only when called (at the deadline). */
  arm(arm: Arm): { recover(anchor?: Anchor): Promise<SurfaceRead | null>; ops(): readonly string[]; dispose(): void };
}

// ── src/adapter/reader.ts (after S4) ───────────────────────────────────────────────────
export class Reader {
  constructor(env?: Partial<ReadEnv>);
  route(req: ObservedRequest): RouteMatch | null;
  kindOf(req: ObservedRequest): EndpointKind | null;                     // kept for callers
  parseableBody(mime: string): boolean;                                  // kept
  read(kind: EndpointKind, input: BodyInput, ctx: ReadCtx): SurfaceRead;
  readListPage(which: 'followers-list' | 'following-list', decoded: Decoded, at: number): SurfaceRead;
  recover(kind: EndpointKind, decoded: Decoded, ctx: ReadCtx): SurfaceRead;
  relationshipFacts(read: SurfaceRead): ObservedRelation[];              // presence-complete + admitted only
  profileSeen(read: SurfaceRead, ownPk: string | null): ProfileSeen | null;   // own counts dropped at C2/partial
}

// ── src/rim/list-walk-end.ts (pure) ────────────────────────────────────────────────────
export interface WalkCursorState { readonly lastForm: 'none' | 'offset' | 'opaque'; readonly probing: boolean }
export type StopDetail = 'more-without-cursor' | 'incomplete-stream' | 'cursor-veto' | 'no-continuation-evidence'
  | 'end-claim-false' | 'rows-unreadable';
export type StepDecision =
  | { readonly act: 'continue'; readonly cursor: string; readonly form: 'offset' | 'opaque' }
  | { readonly act: 'probe'; readonly cursor: string; readonly plainForm: boolean }
  | { readonly act: 'complete'; readonly endEvidence: 'probe' | 'server-flags' }
  | { readonly act: 'stop'; readonly reason: 'shape-mismatch'; readonly detail: StopDetail };
export function decideStep(page: { readonly continuation: Continuation; readonly newRows: number },
  state: WalkCursorState, form: 'paged' | 'whole-list', rowsFetched: number,
  probeCursor: (rows: number) => string): StepDecision;
// WalkResult gains: quarantined: number; endEvidence?: 'probe' | 'probe-rejected' | 'server-flags'; stopDetail?: StopDetail.
// PruneScanFetch gains: quarantined?: number.

// ── src/rim/profile-visit-port.ts / profile-observer.ts / profile-visit.ts ─────────────
export interface ProfileViewer { following: boolean | null; requested: boolean | null; followsUs: boolean | null;
  incomingRequest: boolean | null }                                      // (surface-types.ts) + incomingRequest
export interface ProfileSeen { obs: Observation; viewer: ProfileViewer; presence: ProfilePresence; tier: Tier; partial: boolean }
export interface ProfileVisitor { visit(username: string, opts?: { pk?: string }): Promise<ProfileVisit> }
// ProfileVisit failure details: walled{via:'page'|'body', family?, status?}; unanswered{drift?: DriftClass, ops?: string[]}.
export type ExpectationEvent = { kind: 'seen'; seen: ProfileSeen }
  | { kind: 'wall'; family: WallFamily; status: number } | { kind: 'drift'; cls: DriftClass };
// ProfileObserver.expect(username, opts?: { pk?: string }) → next(timeoutMs, signal) resolves ExpectationEvent | null;
// ProfileObserver.recoverArmed(): Promise<void> reads the visit's candidate buffer (called by the visitor at its deadline).

// ── src/rim/follow-notifications.ts (result extended) ──────────────────────────────────
// r2 note: RO-b replaces this result with FeedSource.fetchSince (Appendix E); the fields below stay meaningful for PP-a.
export interface FollowNotificationsResult {
  ok: boolean; events: FollowEvent[]; accepted: AcceptedFollowRequest[];
  reason?: string;                      // + 'feed-walled' | 'requests-walled' | 'requests-unreadable'
  retryAt?: number; pendingRequestPks?: string[];
  pendingComplete?: boolean;            // §10.4
  pendingPreviewPks?: string[];         // feed side list (never complete)
  feedTier?: Tier;                      // worst tier among feed bodies read
  feedFiltered?: boolean | null;        // owner Q31: variables.selected_filters === 'follows'; null without Q31
}

// ── own header + coverage (engine) ─────────────────────────────────────────────────────
export interface OwnHeader { readonly followers: number; readonly following: number; readonly observedAt: number }
export type OwnStatsRefresh = { ok: true; header: OwnHeader } | { ok: false; reason: 'read-budget' | 'fresh-header-unavailable'; retryAt?: number };
export type CoverageVerdict = { ok: true; ghosts: number }
  | { ok: false; reason: 'header-unknown' | 'short' | 'row-issues'; scraped: number; known: number | null };
export function coverageVerdict(scraped: number, known: number | null, quarantined: number): CoverageVerdict;
export function censusAuthority(listedFollowing: number, listedFollowers: number,
  header: { following?: number | null; followers?: number | null } | null,
  quarantined?: { following: number; followers: number }): Exclude<CensusAuthority, boolean>;

// ── mutations ──────────────────────────────────────────────────────────────────────────
export interface MutationVerdict { verdict: 'ok' | 'fail' | 'error'; result: string | null; message: string | null;
  feedbackText: string | null; spam: boolean }                 // 'error' = GraphQL errors[]; message = all texts joined
// r2: 'error' is Instagram evidence — never 'unverified'; the DOM and block probe pick its class and it always counts as
// a refusal toward the ladder (§10.5).
export interface MutationRequest { url: string; method?: string; requestHeaders?: Record<string, string>; requestBody?: string }
// MutationObservation gains via?: 'match' | 'candidate' (candidate observations are walls only).

// ── IPC ────────────────────────────────────────────────────────────────────────────────
// contract.ts: CHANNELS.surfaceReport = 'surface:report'; IpcContract.surfaceReport: { req: []; res: SurfaceReport }.
// EpoStatus.surface?: SurfaceSummary is a StatusFields member (§15.3), returned by surface-wiring.ts.
```

### D.2 Copy

**Settings › Advanced › "Instagram compatibility"** (placed by T2)

- **Lead:** "Instagram sometimes changes how its app sends information. Epo checks every response it reads and only
  acts on what it can read with certainty."
- **Area names:** Profiles · Notifications · Follow requests · Follower and following lists · Follow status checks ·
  Follow and unfollow results.
- **State pills:** Working normally · Adapted to a change · Paused · Can't read right now · Instagram is slowing things
  down · Not checked yet.

**Explanations:**

| State | Copy |
|---|---|
| Adapted | "Instagram changed how it sends {area}. Epo found the information in its new place and keeps learning from it. It won't unfollow anyone based on it until an Epo update confirms the change." |
| Paused · unfollows | "Epo can't confirm who follows you back right now, so unfollows wait. Following and learning continue." |
| Paused · cleanup | "Epo can't confirm your full follower list right now, so cleanup waits. Nothing is removed until it can." |
| Paused · follow-back decisions | "Epo can't read all of your follow requests, so it holds off deciding who didn't follow back." |
| Paused · exploration (r2) | "Instagram changed how follower lists look. Epo keeps following the people it already found and pauses finding new ones until an update confirms the change." |
| Can't read | "Epo hasn't been able to read {area} since {time}. It keeps trying at its normal pace. An Epo update may be needed." |
| Slowing down | "Instagram is asking Epo to slow down here. Epo waits it out on its own." |

**Recent changes:**
- "{Area}: information arrives in a new place · since {date} · seen {n} times". When consistent, it adds "· confirmed on
  {k} accounts · ready for an update".
- "{Area}: {field} is missing · since {date}"
- "{Area}: {field} arrives in a new format · Epo understood it"
- "{Area}: Instagram renamed the request it uses · Epo recognized it by its content"
- "{Area}: the next-page marker changed · scans stop early instead of guessing"
- "{Area}: {n} entries couldn't be read and were skipped"
- "{Area}: a new kind of notification · follow-backs from it aren't counted"
- "{Area}: Instagram started sending new details ({n}) · nothing to do"
- "Follow and unfollow results: a confirmation step looked different · Epo cancelled instead of guessing" (`confirm-unrecognized`)

**Friendly field names** (`FIELD_LABEL`):

| Path | Shown as |
|---|---|
| `friendship_status.outgoing_request` | follow request sent |
| `.following` | you follow them |
| `.followed_by` | they follow you |
| `.incoming_request` | they asked to follow you |
| `follower_count` | follower count |
| `following_count` | following count |
| `biography` | bio |
| `is_private` | private account |
| `is_verified` | verified badge |
| `username` | username |
| `pk` | account ID |
| `next_max_id`, `has_more`, `big_list` | next-page marker |
| `story_type` | notification type |
| `args.profile_id` | who followed you |
| anything else | "a detail Instagram renamed" |

**Other elements:**
- **Disclosure:** "Show technical details" reveals paths, operation names, tiers, per-day counts and response times
  ("Typical load: profiles {p50}, lists {p50}").
- **Button:** **Copy report** → toast "Report copied. It contains no usernames, names or account IDs."
- **Easy mode:** one line, "Instagram compatibility: {state}", plus **Details** (which opens Advanced).

**Live sidebar line** (placed by T3; one line; calm tone for *adapted*, attention tone for *paused* and *can't read*;
it hides when the area returns to normal or the plan-day ends):
- "Adapted to an Instagram change in {area}. {What still runs}."
- "Unfollows paused: Instagram changed how it sends {area}. Following continues." **Details**
- "Finding new people paused: Instagram changed how follower lists look. Epo keeps following the people it already found." **Details**
- "Epo can't read {area} right now. {What still runs}." **Details**

**Engine and status copy:**
- `feed-walled`: "Instagram is limiting notifications right now; follow-backs are checked again later."
- `requests-unreadable`: "Couldn't read your follow requests; accepting and follow-back decisions wait."
- Prune fails closed: "Couldn't confirm your follower count, so this cleanup waits until it can be read."
- The adapter-drift attention (`copy/attention-copy.ts`, SB) gains "See Settings › Advanced › Instagram compatibility."

The vocabulary audit is clean: no "bot", "human", "emulate", "stealth", "mimic" or "spoof".

---

## Appendix E — Reopen contracts and copy (normative)

Reconciled from T5 §4 and §10 with §14 (C9, C11, C12, C19, C21) and revision 2 (step G, `FRONTIER_PAGES_MAX`, the
upward-only outside charge, probation). Where a line here and §1–§24 disagree, §1–§24 win.

### E.1 Interfaces

```ts
// ── src/kernel/derive-reentry.ts  (D10; kernel-pure: plain-number inputs, imports only kernel siblings) ──────────
export interface HeadNeed {
  readonly identifiedSinceFrontier: number;   // G
  readonly unexplainedGains: number;          // R⁺ (≥ 0)
  readonly rowsPerPage: number | null;        // measured; null before the first walk
  readonly pagesAvailable: number;
}
export declare function headWalkPages(n: HeadNeed): number;                        // min(avail, ⌈(G+R⁺)/max(rpp,MIN)⌉ + 2, FRONTIER_PAGES_MAX)
export declare function headPageAllowance(d: { readonly gainsHint: number; readonly rowsPerPage: number | null }): number; // T1 catchUp.pages / per-session check pages
export declare function censusFollowerPages(followers: number, rowsPerPage: number | null): number;   // bounded by CENSUS_POLICY.maxWalkPages in D6
export declare const WEEKLY_CYCLE: number;              // = HUMAN_CIRCADIAN.dayOfWeek.length (7): revisit/freshness windows in plan-days
export declare function measuredRowsPerPage(walk: { readonly rows: number; readonly fullPages: number }, prior: number | null): number | null;
export declare function frontierRun(): number;          // = driftConfirmThreshold() (2)
export declare function goneConfirmations(): number;    // = driftConfirmThreshold() (2)
export declare function orderAgreementRequired(): number; // = POLICY.CENSUS_ABSENCE_COVERAGE (0.98)
export declare function minOrderPairs(): number;        // = ⌈1 / (1 − orderAgreementRequired())⌉ (50)
export declare function orderVerdict(pairs: number, ordered: number, prior: 'newest-first' | 'unverified'): 'newest-first' | 'unverified';
export type ParkKind = 'unreachable' | 'unreadable';
export interface ParkSlots {
  readonly nextSessionAt: number | null;                  // T1 PlanView
  planDayStartAfter(k: number): number;                   // start of plan-day today + k (T1 windows)
}
export declare function parkUntil(kind: ParkKind, k: number, slots: ParkSlots): number;
export declare function parkTerminal(kind: ParkKind, k: number): boolean;   // unreachable: k ≥ gone; unreadable: k > retryLimit()
export declare function probationOwed(lastMutationAt: number | null, sessionStartAt: number,
  windowOf: (t: number) => { readonly startsAt: number; readonly endsAt: number }): boolean;
  // lives in src/kernel/plan/probation.ts (PC, C21); owed ⇔ ≥ one plan-day length OR a complete plan-day between (§9.11)

// ── src/kernel/reentry-policy.ts  (tier 1; created in F2a, owned by RO) ──────────────────────────────────────────
export const BOUNDS_REENTRY = {
  /** A walk averaging fewer rows per page than this is a parse or server fault, never a census to size by. */
  MIN_ROWS_PER_PAGE: 10,
  /** r2: about a week of gains at measured page sizes; a longer gap stops with `gap` and waits for the census. */
  FRONTIER_PAGES_MAX: 5,
} as const;

// ── src/engine/sweep-plan.ts  (pure) ──────────────────────────────────────────────────────────────────────────────
export type SweepMode = 'launch' | 'session' | 'check';
export type SweepStepId = 'profile' | 'notifications' | 'followers-head' | 'following' | 'consistency';   // 'following' = step G (r2)
export type SkipWhy = 'fresh' | 'not-needed' | 'boost' | 'mode' | 'no-budget' | 'no-header';
export interface StepInputs {
  readonly now: number; readonly mode: SweepMode; readonly light: boolean; readonly launchAt: number;
  readonly checkSpacingMs: number; readonly clockToleranceMs: number;
  readonly state: ReopenState;                               // §16.3
  readonly lastHeaderAt: number | null;
  readonly headerThisSweep: boolean;
  readonly need: HeadNeed | null;                            // R⁺ = 0 when this sweep has no header; null before N ran
  readonly budget: { readonly profiles: number; readonly notifications: number; readonly pages: number;
    readonly followingPages: number };                       // the census term's following share, unspent today
  readonly followingResidual: number;                        // |ΔG − epoNet| − lag since state.following.checkedAt
}
export type StepDecision =
  | { readonly id: SweepStepId; readonly run: true; readonly maxPages?: number; readonly panel?: 'accept' | 'verify' | null }
  | { readonly id: SweepStepId; readonly run: false; readonly why: SkipWhy };
export declare function stale(t: number | null, now: number, spacingMs: number, toleranceMs: number): boolean;
export declare function decideStep(id: SweepStepId, i: StepInputs): StepDecision;

// ── src/engine/frontier-sweep.ts  (orchestration over ports; engine layer, no rim/main imports) ───────────────────
export interface SweepPorts {
  readonly clock: { now(): number };
  readonly plan: {
    view(now: number): { checkSpacingMs: number; clockToleranceMs: number; light: boolean;
      catchUp: { profiles: number; notifications: number; pages: number };
      sessionPagesLeft: number | null; sessionStartAt: number | null; acceptsAllowed(pending: number): number;
      planDayKey: string; planDayStartAfter(k: number): number; nextSessionAt: number | null };
  };
  readonly header: {
    observedSince(t: number): OwnHeader | null;
    land(signal: AbortSignal): Promise<boolean>;               // BL's landing, if it has not run behind the splash
    visit(use: 'catch-up' | 'check', signal: AbortSignal): Promise<'ok' | 'read-budget' | 'failed'>;
  };
  readonly feed: FeedSource;                                   // rim
  readonly head: (a: HeadWalkArgs) => Promise<HeadWalkResult>; // rim
  readonly following: (a: { ownPk: string; signal: AbortSignal }) => Promise<FollowingCheckResult>;   // rim (step G, session mode only)
  readonly facts: SweepFacts;                                  // store port
  readonly autoAccept: () => boolean;
  readonly report: (v: CatchUpView) => void;                   // status push
  readonly onCaughtUp?: (s: AwaySummary) => void;              // T3 History hook
}
export interface SweepResult { readonly mode: SweepMode; readonly steps: CatchUpView['steps']; readonly summary: AwaySummary | null }
export declare class FrontierSweep {
  constructor(ports: SweepPorts);
  run(mode: SweepMode, signal: AbortSignal): Promise<SweepResult>;
  view(): CatchUpView;                                         // pure
  lastSweepEndedAt(): number | null;                           // T1 checkDue anchor
}

// ── src/rim/feed-watermark.ts  (pure) ─────────────────────────────────────────────────────────────────────────────
export interface FeedWatermark { atMs: number; keysAtMs: string[]; readAt: number; filteredAt: number | null;
  gap: { fromAtMs: number; toAtMs: number } | null }
export declare function eventKey(e: FollowEvent): string;                         // `${pk}|${atMs ?? ''}`
export declare function classifyBody(events: readonly FollowEvent[], w: FeedWatermark | null, now: number,
  toleranceMs: number): { fresh: FollowEvent[]; undated: FollowEvent[]; oldestAtMs: number | null; newestAtMs: number | null };
export declare function reached(w: FeedWatermark | null, oldestAtMs: number | null): boolean;
export declare function advanceWatermark(w: FeedWatermark | null, seen: readonly FollowEvent[], readAt: number,
  filtered: boolean, gap: FeedWatermark['gap']): FeedWatermark;

// ── src/rim/follow-notifications.ts  (orchestration; capture split into feed-capture.ts in S0) ──────────────────────
export interface FeedSource {
  fetchSince(w: FeedWatermark | null, o: {
    use: 'catch-up' | 'check'; signal: AbortSignal;
    panel: { mode: 'accept'; allowed: number } | { mode: 'verify' } | null;
    onEvent(e: FollowEvent): void;                             // fresh events, per event, as each body parses (PRINCIPLES §1)
    onUndated(e: FollowEvent): void;
    onRequester(r: { pk: string; username: string }): void;    // sibling rows, per row
  }): Promise<FeedReadResult>;
}
export type FeedFailure = 'read-budget' | `sentinel:${string}` | 'control-not-located' | 'no-response'
  | 'body-unreadable' | 'feed-shape-drift' | 'walled' | 'aborted';
export type FeedReadResult =
  | { ok: true; next: FeedWatermark; bodies: number; filtered: boolean; fresh: number;
      requesters: { count: number; source: 'sibling' | 'panel' | 'none'; complete: boolean };
      accepted: number }
  | { ok: false; reason: FeedFailure; retryAt?: number };

// ── src/rim/followers-head.ts ────────────────────────────────────────────────────────────────────────────────────
export interface HeadFrontier { walkedAt: number; rowsPerPage: number | null;
  order: { verdict: 'newest-first' | 'unverified'; pairs: number; ordered: number; at: number }; contiguous: boolean }
export interface HeadFacts {                                   // narrow store port
  wasFollowerAt(pk: string, t: number): boolean;               // active edge ∧ latest gain hi ≤ t (or stock)
  isActiveFollower(pk: string): boolean;
  exactFollowAt(pk: string): number | null;                    // latest gain row with lo = hi
  observeMembership(obs: Observation, dating: { lo: number; hi: number; source: 'head-walk' }): number | null; // change row id
  narrow(changeId: number, lo: number, hi: number): void;      // only tightens
}
export interface HeadWalkArgs { ownPk: string; frontierAt: number | null; floor: number; maxPages: number;
  use: 'catch-up' | 'check'; prior: HeadFrontier | null; signal: AbortSignal }
export interface HeadWalkResult {
  outcome: 'reached-frontier' | 'gap' | 'initialized' | 'read-budget' | 'shape-mismatch' | 'fetch-failed' | `sentinel:${string}` | 'stopped';
  pages: number; newRows: number; next: HeadFrontier | null; retryAt?: number;
}
export declare function walkFollowersHead(d: { walker: Pick<ListPageWalker, 'walkAll'>; facts: HeadFacts;
  clock: { now(): number } }, a: HeadWalkArgs): Promise<HeadWalkResult>;

// ── src/rim/list-walk-types.ts (amended; list-page-walker.ts gets 3 lines, offset) ──────────────────────────────────
//   WalkArgs.stopAfterPage?: (page: readonly Observation[]) => boolean;   // true ends the walk, reason 'caller-stop'
//   WalkArgs.readUse?: ReadUse;                                            // T1 `use` tag, passed to consume()

// ── src/rim/following-check.ts (r2; step G) ────────────────────────────────────────────────────────────────────────
export type FollowingCheckResult =
  | { readonly ok: true; readonly complete: true; readonly count: number; readonly removed: number; readonly added: number }
  | { readonly ok: false; readonly reason: 'read-budget' | 'shape-mismatch' | 'fetch-failed' | `sentinel:${string}` | 'stopped' };
// verified-complete through the walker's whole-list rule; removed own→pk edges on managed records → external; new edges →
// outside follows (excluded from Epo tallies); the exact count replaces the header estimate in the ceiling charge.

// ── ClickVerdict: the spec's union in src/shared/click-verdict.ts (§9.7, C19) — incl. 'protected' {by, match},
//    'protection-unknown' {missing}, 'protection-paused' {state}; applyClickVerdict lives in src/engine/click-verdict.ts:
export declare function applyClickVerdict(rec: FollowRecord, v: ClickVerdict, ctx: {
  now: number; holdMs: number; followbackAfter: number; slots: ParkSlots }): FollowRecord;
// adapter/errors.ts:  class ActionReviewedError extends Error { constructor(readonly verdict: ClickVerdict) }

// ── src/engine/journal.ts  (pure gate + settlement table) ──────────────────────────────────────────────────────────
export interface IntentObservation {
  readonly kind: 'ok' | 'absent' | 'renamed' | 'unreadable' | 'walled' | 'read-budget';
  readonly following?: boolean | null; readonly requested?: boolean | null; readonly followsUs?: boolean | null;
  readonly at: number; readonly resumeAt?: number | null;
}
export type Settlement =
  | { readonly settle: EffectSettlement }
  | { readonly park: { attempts: number; nextAttemptAt: number }; readonly recordPark: ParkKind | null }
  | { readonly expire: EffectSettlement; readonly recordTerminal: 'external' | 'abandoned' | null }
  | { readonly ladder: true };
export declare function journalBlocks(pk: string, unsettled: readonly EffectIntent[], exceptIntentId?: string): boolean;
export declare function journalDue(i: EffectIntent & { nextAttemptAt: number | null }, now: number): boolean;
export declare function settlementFor(intent: EffectIntent & { attempts: number }, o: IntentObservation,
  rec: FollowRecord | null, slots: ParkSlots): Settlement;

// ── src/rim/journal-settlement.ts  (replaces effect-reconciliation.ts) ───────────────────────────────────────────────
export declare function settleNextIntent(d: { store: KnowledgeStore; profiles: ProfileVisitor; ownPk: string;
  clock: Clock; readBudget: Pick<ReadBudget, 'consume'>; slots: () => ParkSlots; signal: () => AbortSignal | undefined }):
  Promise<{ outcome: 'settled' | 'parked' | 'expired' | 'none' | 'aborted' | 'walled' }>;
export declare function settleFromChannels(d: { store: KnowledgeStore; ownPk: string; now: number },
  e: { follower?: { pk: string; atMs: number }; stillRequesting?: { pk: string; at: number } }): number;

// ── src/store/repos/growth.ts ──────────────────────────────────────────────────────────────────────────────────────
export interface FollowerChange { id: number; accountPk: string; delta: 1 | -1; lo: number; hi: number;
  source: 'feed' | 'accept' | 'head-walk' | 'census' | 'visit' | 'list' | 'migrated'; foundAt: number }
export interface OwnHeader { at: number; followers: number; following: number }
export declare class GrowthRepo {
  noteOwnHeader(h: OwnHeader): void;                                      // every observation (facts stream)
  latestOwnHeader(): OwnHeader | null;
  onTransition(pk: string, delta: 1 | -1, lo: number, hi: number, source: FollowerChange['source'], at: number): number | null;
  narrow(id: number, lo: number, hi: number): void;
  narrowLatestGainContaining(pk: string, exactAt: number): boolean;
  latestGain(pk: string): FollowerChange | null;
  ensureBackfilled(ownPk: string, baselineAt: number | null): { inserted: number } | null;   // set-once
  accounting(fromAt: number): FollowerAccounting;                         // pure fold over rows since `fromAt`
  today(window: { startsAt: number; endsAt: number }): TodayCounts;
  series(days: readonly { startsAt: number; endsAt: number }[], baselineAt: number | null): GrowthPointV2[];
  netSince(since: number): number;                                         // the old netFollowersSince (identity at migration)
  outsideSince(since: number): number;   // per header window fully inside the window: max(0, ΔG − epoNet − resolvedEpoRequests)
                                         // — increases only; Epo's outstanding requests tracked until they resolve (§9.10)
}
// src/store/folds/growth.ts (pure): components, residuals, placement — FollowerAccounting
export interface FollowerAccounting {
  components: readonly { from: number; to: number; deltaHeader: number; identified: number; residual: number }[];
  placed(window: { startsAt: number; endsAt: number }): { gained: number; lost: number; residual: number };
  unplaced(window: { from: number; to: number }): { gained: number; lost: number; residual: number };
  seenSince(headerAt: number): { gained: number; lost: number };
}

// ── src/store/repos/reopen-state.ts  (meta JSON, validated parse; one writer: FrontierSweep) ──────────────────────
export interface ReopenState {
  v: 1;
  feed: FeedWatermark | null;
  head: HeadFrontier | null;
  requests: { observedAt: number; count: number; complete: boolean; verifiedDayKey: string | null } | null;
  lastSweep: { id: number; mode: SweepMode; startedAt: number; endedAt: number } | null;
  lastCatchUp: AwaySummary | null;
  following: { checkedAt: number; count: number; complete: boolean } | null;   // step G (r2)
}
export declare class ReopenStateRepo { get(): ReopenState | null; set(s: ReopenState): void; seedFromLegacy(lastActiveAt: number | null): void }

// ── src/shared/reopen-view.ts  (renderer-safe; no @/types, no kernel) ───────────────────────────────────────────────
export type CatchUpStepId = 'profile' | 'notifications' | 'followers-head';
export type CatchUpSkip = 'signed-out' | 'account-changed' | 'offline' | 'wall' | 'holding' | 'blocked' | 'no-budget';
export type StepState =
  | { readonly state: 'pending' } | { readonly state: 'running' }
  | { readonly state: 'done'; readonly found: number }
  | { readonly state: 'skipped'; readonly why: 'fresh' | 'not-needed' | 'boost' | 'mode' | 'no-budget' | 'no-header' }
  | { readonly state: 'failed'; readonly why: 'unreadable' | 'walled' | 'drift' | 'tab' | 'read-budget' | 'aborted' };
export interface AwaySummary {
  readonly sweepId: number; readonly from: number; readonly to: number; readonly isReturn: boolean;
  readonly followers: { readonly before: number | null; readonly after: number | null };
  readonly following: { readonly before: number | null; readonly after: number | null; readonly outsideEpo: number | null };
  readonly newFollowers: number; readonly followBacks: number; readonly lostIdentified: number; readonly unattributed: number;
  readonly requestsWaiting: { readonly count: number; readonly atLeast: boolean } | null;
  readonly gaps: { readonly feed: boolean; readonly head: boolean };
  readonly backfilled: number | null; readonly journalPending: number;
}
export interface CatchUpView {
  readonly state: 'idle' | 'running' | 'done' | 'skipped';
  readonly mode: 'launch' | 'session' | 'check' | null;
  readonly skipped: CatchUpSkip | null; readonly isReturn: boolean; readonly since: number | null;
  readonly startedAt: number | null; readonly finishedAt: number | null;
  readonly steps: readonly { readonly id: CatchUpStepId; readonly step: StepState }[];
  readonly summary: AwaySummary | null;
}
export interface OwnCountsView {
  readonly followers: { readonly count: number; readonly at: number; readonly seenSince: { readonly gained: number; readonly lost: number } } | null;
  readonly following: { readonly count: number; readonly at: number } | null;
}
export interface TodayCounts { readonly startsAt: number; readonly endsAt: number; readonly net: number; readonly gained: number;
  readonly lost: number; readonly unattributed: number; readonly followBacks: number; readonly outside: number }
export interface JournalView { readonly pending: number; readonly parked: number; readonly nextAttemptAt: number | null }
export interface RequestsView { readonly count: number; readonly complete: boolean; readonly observedAt: number | null }
export interface GrowthPointV2 { readonly dayStartMs: number; readonly cumulativeNet: number;
  readonly arrived?: { readonly gained: number; readonly lost: number; readonly fromMs: number } }

// ── src/shared/followback-outcome.ts  (the ONE classifier) ─────────────────────────────────────────────────────────
export type FollowbackOutcome = 'success' | 'failure' | 'censored' | 'pending' | 'excluded';
export interface OutcomeRow { state: string; followedAt: number | null; followedBackAt: number | null;
  followbackAfter: number | null; followbackObservedAt: number | null; reconciledAt: number | null;
  unfollowReason: 'no-followback' | 'hold-expired' | null }
export declare function followbackOutcome(r: OutcomeRow, windowMs: number, now: number): FollowbackOutcome;

// ── src/main/modules/catch-up.ts  (T3 StartupStep adapter) ────────────────────────────────────────────────────────
export type BlockKind = 'identity' | 'rate' | 'operational' | 'unknown';
export declare function blockKind(reason: string): BlockKind;      // operational = allow-list {chain-exhausted, seed-unresolved}
export type CatchUpAdmission = { run: true } | { run: false; why: CatchUpSkip };
export declare function catchUpAdmission(s: { identity: 'confirmed' | 'missing' | 'changed'; online: boolean;
  sentinel: 'ok' | string; recovery: 'idle' | 'holding' | 'probing'; block: string | null }): CatchUpAdmission;
export declare function catchUpStep(sweep: FrontierSweep, admit: () => CatchUpAdmission): {
  name: 'catch-up'; when(): boolean; run(signal: AbortSignal): Promise<void> };

// ── EngineStatus (src/engine/status.ts), optional fields; notBuiltStatus/idleStatus keep compiling ─────────────────
//   catchUp?: CatchUpView | null;  own?: OwnCountsView | null;  today?: TodayCounts | null;
//   journal?: JournalView | null;  requests?: RequestsView | null;
//   reentry?: deprecated-optional until the Phase I removal sweep;  netToday stays (= today.net) until the sidebar drops its readers.
//   These fields are StatusFields members (§15.3), returned by reopen-wiring.ts.
```

**Plan-contract amendments** (already folded into §5.15 and Appendix A; kept here for traceability):
- `viewPlan`/`PlanServiceDeps`: replace `reentryPhase()` with `lastMutationBefore(t): number | null`; the view calls
  `probationOwed` per session.
- `AdmitRefusal`: replace `'reconcile'` with `'journal'`; `MutationCadence.preflight(kind, writer, now, subject?: {
  pk: string; intentId?: string })` and `armAtDispatch(…, subject?)` consult `journalBlocks`.
- `PlanView.checkDue(lastCheckAt)` is called with `sweep.lastSweepEndedAt()`, not the newest `check` debit.
- `ReadPlan` gains per-session `checkPages` (from `headPageAllowance`); `catchUp.pages = headPageAllowance(…)`.
- `PlanDemand.evidenceDueByDayEnd` is dropped (always 0); `journalPending` = due intents; `census.rowsPerPage` =
  `reopen_state.head.rowsPerPage ?? the census measurement`.
- `censusPagesMax` = `censusFollowerPages(n_followers, rpp) + SURFACE.followingWalkPages`; `RECONCILE.BATCH_MAX` and
  `RECONCILE.HALT_FAILURES` are not added.

### E.2 Copy (the sidebar renders)

| Moment | Copy |
|---|---|
| Catch-up running | "Checking what changed since Epo last looked…" · steps: "Your profile numbers" · "Notifications since 9:00 PM" · "Newest followers" |
| Caught up (a return) | "While Epo was closed (5 days): +19 followers · 4 followed you back · 3 follow requests waiting" |
| Caught up (short) | "Up to date since 9:00 PM — nothing new." |
| Unattributed change | "Instagram's count moved by 2 more than Epo could match to people. Epo will name them at the next full check." |
| Outside following | "Your following count changed by about +6 outside Epo. It counts toward today's safety limit." · People lanes until step G runs: "Changed outside Epo · not yet verified" · after G: "Checked your following list: you followed 4 and unfollowed 2 accounts outside Epo." |
| Feed gap | "Older notifications weren't available, so Epo matched new followers from your followers list." |
| Header not checked | "Follower count not checked yet — it updates when Epo opens your profile." |
| Headline freshness | "3,960 followers · Instagram's count, checked 9:10 AM · +3 since" |
| First run after the update | "Updated your follower history with 64 follows Epo hadn't recorded." |
| Journal pending | "1 action from last time is waiting for confirmation. Epo checks it before touching that account again." |
| Up for review | "Up for review · 31" — tooltip: "Their follow-back window ended. Epo checks each profile right before deciding." |
| Re-hold | "@name follows you now, so Epo will keep following them a while longer." |
| Unavailable | "Couldn't open @name's profile — Epo will look again tomorrow." · terminal: "@name's account is no longer available, so Epo stopped managing it." |
| Requester | "@name asked to follow you. Epo won't unfollow them while the request is open." |
| Requests | "3 follow requests waiting" · "At least 5 follow requests waiting" · "Accepting follow requests in this session" |
| Probation (T1) | "Easing back in — this session runs at a gentler pace." |
| Catch-up skipped | "Catching up after Instagram's limit clears." · "Catching up when you're back online." |
| Net today tooltip | "Changes Epo can place on today. Changes from while Epo was closed that can't be placed on one day are under 'While you were away'." |
| Census does not fit today | "Your followers list is too long to check in one of today's sessions — Epo checks it in a longer session." |
| Census too large | "Your followers list is too long to check in full, so Epo won't prune people you followed yourself. Everything else works as usual." |

Avoid: "human", "bot", "mimic", "emulate", "stealth", "natural", "detect". The ADR 0212 amendment also neutralizes
its own "the bot cannot expire them".

---

## 25. Review notes (revision 2)

Every critique item of the 2026-11-02 integration review was folded into §1–§24, the appendices and the workplan. The
notes below record the items adopted **in a different form** than proposed, or where the critique was narrowed, with the
code evidence. Items adopted as proposed are not repeated here.

1. **Automatic-day bound (safety blocker).** Adopted, with the exact bound: today's maximum is the supremum of
   `cyclePlan`, `round(P0 · (0.85 + u·0.12))` with `u ∈ [0, 1)`, capped at `P0 − 1` (`cycle-plan.ts:16-24`), i.e.
   `min(P0 − 1, ⌈0.97·P0 − ½⌉)`. That equals ⌊0.97·P0⌋ at 15, 30, 50 and 100 but is **73** at P0 = 75 (⌊72.75⌋ = 72
   would under-state today by one), so the laws use `automaticDayMax(P0)`. Rather than re-centring a lognormal (which
   would either cut the mean day by 5–9 % or pile days on the bound), the plan keeps today's realized law
   `min(lognormal day, band day)` (seeded simulation: Typical mean 0.79·P0, identical to today) and therefore keeps the
   three `PATTERN.CYCLE_PLAN_*` keys instead of retiring them (§5.4, §5.12).
2. **Launch readiness.** Adopted for the IG first navigation, the landing and `confirm-account`, which now run behind
   the splash (bounded by the derived `IG_READY_DEADLINE_MS`). The catch-up's drawer pass stays **after** the reveal:
   its typical cost is 20–60 s (§9.6), which would turn the splash into a minute-long wait; the owner's "fully
   preloaded" is met by the data, the eager Graph, the preloaded People/Prune data and the already-landed profile.
   Q40 asks the owner about the longer splash.
3. **Boost volume.** The lead's decision ("reallocates, never adds") stays the default and is made honest (the
   `nothing-to-shift` and `light-day` reasons, a disabled Start, laws L13b/L14b). The A4-compatible alternative is put
   to the owner in Q5, bounded by `automaticDayMax(P0)` rather than `M`, because note 1 makes `M − V` manual and
   outside headroom only.
4. **Head walks vs the census term.** The critique offered "a D6 term or a census reservation". The reservation would
   starve head walks: the exploration share of today's list-page total is only `slices × 3` = 18 pages
   (`listPages = 200 + slices × 3`, §17.4) and is fully used on a normal day. A bounded frontier term (35 pages at
   Balanced) was chosen instead; it sizes a new read class, while verify-at-act deletes up to 276 profile pre-reads a
   day, so it is not a ceiling raised for convenience.
5. **Post-wall waits.** Rather than `NOT_TEMPO`, the three waits use a one-sided `pace-up` axis (`max(1, pace)`): they
   are never shorter than today's value at any tempo or override (law L10), and relaxed sessions still wait longer, so
   owner item 1 (every wait derives from the plan) keeps holding.
6. **Revisit and freshness windows.** Expressed through the one plan-day boundary as proposed, but `k` is the plan's
   weekly cycle (7 plan-days, the period of `HUMAN_CIRCADIAN.dayOfWeek`), not patience or census cadence: at Normal
   patience (4 days) `profileFreshMs` would drop from 7 d to 4 d and raise profile re-reads by ≈ 75 % — against
   account safety. The weekly cycle is an identity with today's 7 d and derives from a fundamental.
7. **List recovery.** C2 recovery was adopted narrowly: the `source-rows` role serves acquisition walks only (each row is
   re-read at C0 by its enrichment visit and by the click), its continuation is never recovered, and the exploration
   gate stops composed requests after `driftConfirmThreshold()` drifted pages (A5). Own-list walks stay unrecovered
   because they feed absence verdicts (§10.1).
8. **Following check.** Adopted in session mode only. The lead's launch list (own header, drawer since the watermark,
   followers head) does not include the following list, so launch use is owner Q38; meanwhile the People lanes mark
   outside changes "not yet verified".
9. **Overview cards' orphan window.** Instead of moving their deletion into the shell stream, `OverviewView` stays as the
   interim console column until the sidebar stream swaps `<Sidebar/>` in and deletes the view and its cards in one
   commit. Deleting it in the shell stream would leave the column empty for nine merges; either way no merge has an
   orphan.
10. **Posture vs the window title.** The first option was taken: `src/shared/posture.ts` lands in F2b, so the boot
    stream's stage controller uses the same pure function from its first commit (§12.3 "main calls the same function").
11. **Old-renderer typecheck.** Decoupling was chosen over reordering the merges: the frozen v1 `Settings`, the old
    `checkSeed` wire shape and deprecated-optional status fields keep the old UI compiling, and the Phase I removal
    sweep deletes them. Reordering would delay F6 and the other live preconditions behind the UI streams.
12. **Read backstop.** Recorded as an explicit, code-evidenced refinement of A1 (§3 deviation 3), not as a second day
    boundary.
13. **Static-timing scope.** All of `src` is scanned except `src/kernel` (the home of every allowed constant) and
    `src/renderer` (§3 deviation 1; its presentation constants are pinned to perception by their own tests). Harness
    directories are in scope, with `HARNESS` allow-list entries.
14. **Committed contracts.** The topic designs' contracts and copy decks are folded into this document as Appendices
    A–E rather than a separate committed file: revision 2 was limited to the spec and the workplan, and one file keeps
    one source of truth. They were reconciled with §14 and revision 2 while folding, and scrubbed (no account handles,
    ids or local paths; example handles are fictional).
