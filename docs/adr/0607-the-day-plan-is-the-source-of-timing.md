# 0607 — The day plan is the source of every Instagram-facing timing

**Status:** accepted (the plan core landed unwired; the runtime streams wired it, retired the legacy
pacer and finalized the ledgers below) · **Area:** kernel, governors, timing, settings
**Amends:** ADR 0605 (the golden), 0202 (pacing models), 0204, 0211, 0212, 0307 · **Executes:** ADR 0901

## Context

Epo paces Instagram work through three generations of mechanism at once: a legacy metronome
(minimum/maximum delay with jitter inside active hours), an organic `SessionPlanner` (circadian
sessions, log-normal gaps, a daily volume draw) and a cycle-plan gate (`cyclePlan`) that silently
caps the realized day below the planner's draw. Every wait, dwell, scroll and gesture beyond those
reads its own constant. Three day boundaries coexist (08:00 for the rate governor, local midnight
for the planner, a rolling 24 h for reads). Status reads run `sync()` and write planner state. The
owner's first rule: everything timing- or limit-shaped is derived from the plan, nothing is hardcoded.

## Decision

1. **One DayPlan per account per plan-day**, drawn by one writer (`PlanService`, the only writer of
   `meta.plan_state`) from live Settings intent (`toPlanIntent`), kernel fundamentals × dials, the
   Boost window and a counter-seeded rng; persisted; immutable except by named re-plan causes
   (`day-start`/`first-open`, `settings` on an intent-digest change, `demand`, `boost-start`/`-end`,
   `clock`, `repair`); read through a **pure** `PlanView`. Reads never write.
2. **Counter-based seeding.** Every draw is one mulberry32 step at `seed ^ fnv1a(coords)`
   (`seed = installEntropy ⊕ fnv1a('epo-plan|' + dayKey)`): order independent, restart stable, and a
   lost plan re-derives the same ideal plan. The circadian phase is install-seeded, never day-seeded.
3. **One plan-day boundary** at the install's quiet minute — the argmin of the weekday λ masked by
   quiet hours, ties to the centre of the longest run — read through the `PlanDayClock` port by every
   day counter. A boundary change runs a 12–36 h transition day; below 23 h every counter prorates.
4. **The day law is today's realized law**, `V = min(lognormal day, band day)` with the kept
   `PATTERN.CYCLE_PLAN_*` band, so `V ≤ automaticDayMax(P0)` always (14/29/48/73/97 at the five
   activity levels) and the distribution equals `min(planner volume, cyclePlan)` (two-sample KS).
   `M` is headroom for single manual actions and outside residuals, never a volume target.
5. **Kinds without randomness**: lifecycle first, cleanup at its share of the unfollow room, accepts
   up to half the rest, follows never above `P0` and yielding to a lifecycle backlog outside Boost.
6. **Sessions on the λ_eff strata** (λ masked by quiet hours), separated by the session boundary,
   merged when infeasible, prorated before the first open (missed sessions expire; one late-join rule).
7. **A per-session tempo** `{pace, motion = pace^½, depth = 1/pace}` from a day and a session latent,
   spread by consistency and clamped to the beat band. The gap is **rate-neutral and derived**: the
   target mean is `3600 s · CEILING_HEADROOM / H · pace / BEAT_MIN` and the reference shape is
   time-scaled by τ ≥ 1 (a memoized seeded estimate, closed form unless the cap binds). Overrides only
   lengthen. D4 deadlines and polls are never plan-derived.
8. **Reads in two layers**: D6 per plan-day with a trailing-24 h backstop (profiles + a verify
   reserve; pages = exploration + a header-relative census + the frontier term; notifications =
   sessions + checks), and the plan's own day and session buckets inside it. The census is a durable
   per-session predicate, never pinned at draw time.
9. **The golden invariant**: the snapshot is never edited; `registry-changes.ts` holds the `RETIRED`
   and `CHANGED` ledgers and every golden (registry, grid, personas, profiles) expects
   `snapshot − RETIRED ⊕ CHANGED`; the moved leaves equal `CHANGED` exactly; the tempo-identity and
   MOTION goldens and the plan laws (L1–L15) replace "exactly one moved key" (ledgers below).
10. **One activity clock per graph** (`src/rim/ig-activity-clock.ts`): every Instagram operation —
    a profile visit, a list walk, the notifications drawer — enters no sooner than one `dwell.visit`
    draw at the session tempo after the previous operation ended, whichever caller issued either.
    The spacing lives at the entry, so the pacers that callers stacked on top of it retire: the
    engine's beat after a task (`pause.after-task`, `ENGINE.REFILL_PACING_*`) and the enrich pace
    (`RIM.ENRICH_PACE_*`; a non-ok sentinel ends an enrichment pass instead).

## Consequences

- The plan core is pure and testable alone: laws L1–L15 (incl. L9 DST tiling, L13 for every re-plan
  cause), `plan-qc` (1 260 plan-days, zero breaches) and identity tests against today's code paths.
- Status projections become pure; bookkeeping never re-plans; a corrupt `plan_state` is repaired
  deterministically with a warning.
- No caller can burst Instagram operations: an enrichment pass, a click review's verify visit, a
  journal settlement and a sweep's walk share one rhythm, each entry at least the `dwell.visit`
  floor after the last end at any pace (a law). The tempo registry holds 27 keys.
- The registry holds 101 keys after the retirements; the reviewed provenance tally is derived 40 /
  policy 34 / override 16 / harness 11 (was 49/41/18/11 = 119).

## The ledgers (`src/kernel/registry-changes.ts`)

**RETIRED — 18 registry keys**, each recorded with `{adr: '0607', replacedBy, reason}`; their last
values stay readable in the frozen snapshot.

| Keys | Tier | Replaced by |
|---|---|---|
| `ENGINE.VELOCITY_PARK_{MEDIAN_MS,SIGMA,MIN_MS,MAX_MS}` | derived | the exact trailing-hour window (`MutationCadence.velocityParkUntil`) |
| `RIM.ENRICH_PACE_{MIN,MAX}_MS` | derived | the activity clock; a non-ok sentinel ends an enrichment pass |
| `NOISE.PRUNE_LAUNCH_JITTER_MAX_MS` | derived | nothing launches: cleanup is woven into sessions (C14) |
| `NOISE.CADENCE_SIGMA` | derived | the plan's check spacing (`check.spacing`, `PlanView.checkDue`) |
| `NOISE.DAILY_BOUNDARY_JITTER_MAX_MS` | derived | exact plan-day parks; the `daily-boundary` wait class and `jitterBoundary` went with it |
| `PRUNE.DELAY_FACTOR` | policy | the shared deadline armed at dispatch |
| `RIM.ACQUIRE_MAX_ROUNDS` | policy | dead; the slice shape bounds the dialog fallback |
| `SCHEDULER.AUTO_PRUNE_CHECK_MS` | policy | cleanup in sessions plus a manual Prune now (C14) |
| `PRUNE.SCAN_FRESH_MS` | policy | the plan's census rule (`intent.patienceWaitMs`, `PlanView.censusDue`) |
| `NOISE.CADENCE_{MIN,MAX}_FACTOR` | policy | the plan's check spacing; the `watcher-cadence` class retired |
| `SCHEDULER.USERNAME_REBUILD_BACKOFF_MS` | policy | the boot sequence's `confirm-account` step |
| `ENGINE.REFILL_PACING_{MIN,MAX}_MS` | override | the activity clock (their two `OVERRIDES` entries are gone) |

`POLICY.BACKOFF_BAND` (unused, a duplicate of the backoff clamp) is deleted with them. The frozen v1
settings rules keep the retired sweep factor's range as `BOUNDS.SETTINGS_V1.SWEEP_FACTOR_{MIN,MAX}`
(0.5 / 2, kernel, guard lines), so a v1 file still coerces verbatim: literal copies in
`src/settings/v1` would be static-timing findings the ratchet cannot list.

**CHANGED** — `{path, from, to, adr}` for every deliberate value change the snapshot pins:

| Path | From | To | ADR |
|---|---|---|---|
| `groups.RECOVERY.PRUNE_COOLDOWN_AFTER_RATE_HALT_MS` | 2 h | 3 h | 0606 §1 |

The Cautious gap floor 60 → 70 s (owner Q11, ADR 0606 §4) is decided and prepared as its own commit
(`grid.caution=cautious.gapFloorSeconds` and `personas.casual.gapFloorSeconds`, 60 → 70). It lands once
the frozen v1 pipeline resolves a named persona through `V1_DERIVED` instead of the live derivation:
`sanitizeSettings` re-derives through `resolvePattern`, so the migration would otherwise read 70 from a
v1 file that holds 60 and record a spurious `sessions.gapMinimum` override.

**Overrides outside the registry** (covered by the override tests, not the tally): the advisory
`ENGINE.ACTIONS_FAILING_HALT` entry and the advisory mechanism are gone — the loop reads
`coldFailingThreshold()` = 7 (owner Q11); the applied `PRUNE.CONSECUTIVE_FAIL_HALT` 4 (derived 7)
is new, read through `pruneFailingThreshold()`: a bulk run halts sooner than the loop so a broken
unfollow path cannot burn the list.

**Named factors** (spec §17.3, values unchanged): `POLICY.DRAW_DECILE_Z` (1.2816, shared with
`SETTINGS_POLICY.TYPICAL_DAY_Z`); in `derive.ts`, beside their derivations, the D4 poll bounds
`POLL_FRACTION_OF_P50`, `POLL_MIN_MS`, `POLL_MAX_MS` and the factors `WATCHDOG_CHECKS_PER_WINDOW` (8),
`CANARY_FRAMES` (30), `EXHAUSTED_REVERIFY_P90_WALLS` (2), `PUSH_THROTTLE_INSTANTS` (3). The numeric grids
stay GEOM.

**Moved to their consumers**: `EXPLORATION_POLICY.ownFollowersPickMax`, `skipPoolFactor` (× min(F,
`queuedPerSource`)), `maxCoverageFraction` and `maxEnrichPassesPerCycle`; an enrichment slice is
`min(profilesPerSlice, the open session's explore reads)` and the duplicate batch cap of 25 is
deleted. The engine's freshness windows run in plan-days (the weekly cycle through the one
boundary). Spec §17.8's `RIM.LIST_WALK_FETCH_RETRIES` landed as `SURFACE_BOUNDS.listWalkFetchRetries`.

## Alternatives rejected

- Re-drawing a lognormal day against `M`: 38 % of typical days above today's maximum.
- A rolling 24 h as the reset boundary: it lets catch-up reads spend twice D6 around the boundary.
- Plan-seeded micro-noise: the interactor is rebuilt every graph build, so it would replay paths.
- A day-seeded phase: circular with the day key, and a repair would move the current window.


## Remaining read consumers

Source profile freshness, failed-enrichment retries and ended-source revisits count seven plan-day
boundaries using the graph's `PlanDayClock`. Low-yield revisits start at the next plan boundary.
The four fixed exploration windows are retired. The unused live-test enrichment pace knobs and
their two HARNESS registry keys are retired too; the harness visitor uses the shared visit cadence.
The live registry consequently has 99 keys: 40 derived, 34 policy, 16 override and 9 harness keys.
