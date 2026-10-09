# 0605 — Constants derive from fundamentals

**Status:** accepted · **Area:** kernel (`src/kernel/{fundamentals,policy,derive,overrides}.ts`),
`src/timing/config.ts`, `src/settings/pattern-map.ts`

## Context

`src/timing/config.ts` held 119 leaf keys across 15 groups, and
`src/settings/pattern-map.ts` five hand-written level tables. Each carried a
one-line "why", which was genuinely better than nothing — but a comment cannot
be checked. Nothing said whether `{14, 22, 30}` actions per hour and
`{60, 45, 35}` second gap floors were consistent with each other, whether
`HOLD_SIGMA = 0.25` was wide enough to do the job it exists for, or what would
have to change if we re-measured Instagram's soft wall. Every number was
independently arguable, which in practice meant none of them were argued about.

Three of them were wrong, and nobody could see it, because "wrong" had no
definition.

## Decision

Three tiers. Nothing outside tier 2 may hold a magic number.

**Tier 0 — `fundamentals.ts` (`EMPIRICAL`).** What we believe about the world:
follow/unfollow walls per hour and per day (low and typical), soft-wall duration
p50/p90, the human session boundary, the within-session gap distribution,
sessions per day, day-volume CV, rest-day rate, the circadian shape — plus the
quantities the app will measure itself (hydration / mutation / nav / control and
six more latency percentiles, ordinary fail, block, drift and duplicate-page
rates). Every entry carries `src` and `rev`; a test fails when any `rev` is more
than twelve months behind a *fixed* review date (a wall-clock test would be a
time bomb, so bumping `REVIEWED_ON` is part of re-reviewing).

**Tier 1 — `policy.ts` (`POLICY`, `SCALES`, `BOUNDS`, `PREFERENCES`).** The five
numbers the owner argues about — `SAFETY_MARGIN`, `DESYNC_WIDTH_MS`,
`BURST_TOLERANCE`, `TIMEOUT_SLACK`, `CONFIDENCE` — plus the ladder's shape, the
ordinal scales, the genuine bounds no measurement produces (`HEAL_MAX_RECORDS`,
`LIST_WALK_MAX_PAGES`, `REQUEST_ACCEPT_CAP`, …), and the preference tables that
express product vocabulary rather than physics (cleanup, patience, the named
day/week shapes). A bound is *allowed* to be arbitrary — it is a guardrail, not
a measurement — but it still gets a line saying what it guards against.

**Tier 2 — `derive.ts`.** Pure functions, no literals except unit multipliers.
The five derivations:

- **D1 rate.** `hourlyCap = round(W_h.typical × margin × k_caution)` →
  14 / 22 / 30 exactly. `dailyPlan = round(W_d.typical × margin × k_activity)` →
  15 / 30 / 50 / 75 / 100 exactly. `effectiveMargin = dailyPlan / W_d.low` is now
  a reportable number.
- **D2 gaps.** `gapMedian = HUMAN_GAP.median × k_rhythm` → 180 / 95 / 55 s.
  `gapFloor = ceil(3600 s / (cap × BURST_TOLERANCE))` — rounded *up*, because
  rounding a floor down permits a faster burst than the policy sanctions.
  `gapCap = SESSION_BOUNDARY × 0.27` → 8 min, which also sizes the velocity park
  and the step watchdog.
- **D3 ladder and jitter.** `hold(n) = W_p50 × 0.33 × 1.5^(n-1)`; the rung COUNT
  falls out of a coverage requirement (`Σ hold ≥ p50` → 3 rungs; `'p90'` would
  give 7 — see open question 2). `HOLD_SIGMA` is the smallest σ whose rung-1
  10–90 spread covers `DESYNC_WIDTH_MS` → 0.25. The clamp factors are that
  draw's central 95% → 0.6 / 1.6. The same `DESYNC_WIDTH_MS` gives the
  daily-boundary jitter, the prune-launch jitter, and (through the clamp band)
  all three log-normal spreads. One dial replaced six constants.
- **D4 timeouts and polls.** `timeout = round(p99 × 1.5)`,
  `pollEvery = clamp(p50 / 4, 100 ms, 1 s)`. Six deadlines and four poll
  intervals, two formulas.
- **D5 breakers as posteriors.** `π/(1−π) × (1/q)^k ≥ CONFIDENCE/(1−CONFIDENCE)`
  gives cold 7, probing-after-a-hold 2, blocked 3, drift 2, stagnant pages 3 —
  four of which are exactly what the app already shipped.

**The escape hatch — `overrides.ts`.** There is no tolerance in this system. A
value either equals what the app ships or it is named in `OVERRIDES` with the
formula's answer beside it and a reason. Eighteen registry keys are pinned this
way; sixteen of them are the outer edges of uniform pacing bands whose *shape*
derives but whose *width* was hand-set.

`timing/config.ts` and `pattern-map.ts` became shims. Their public API — every
group name, every key, every exported function and type — is unchanged, because
27 files across every layer import them.

**Accounting of the 119 keys:** 49 derive exactly, 41 are policy bounds, 18 are
pinned overrides, 11 are the dev-only `HARNESS` group (documented as not derived
and slated for deletion when the harnesses move behind `surface-lab`). The
`PROVENANCE` map in `derive.ts` records the tier of every key, and a test asserts
it covers the registry exactly — a new key cannot be added without saying where
it came from.

## The gate

`tests/kernel/legacy-config.snapshot.ts` is a deep-frozen literal copy of the
registry and every pattern-map table as they stood at `864f6ba`. It was written
BEFORE anything changed. `derive-golden.test.ts` asserts key-for-key equality
against it — the whole registry, all five personas, all 31 ordinal-grid points,
all nine circadian profiles — and separately asserts that exactly one key moved
(see ADR 0606). Editing the snapshot to make a test pass is never the fix.

On top of the golden gate, `derive-laws.test.ts` holds the properties a hand
table cannot have: monotonicity in every ordinal knob; the envelope
(`plan ≤ ceiling ≤ wall`, `cap × waking hours ≥ ceiling`, the burst tolerance)
under ±20% perturbation of every empirical input; safety floors (`gapFloor ≥ 20 s`,
`hold(1) ≥ 30 min`, `timeout ≥ p99`) asserted against *derived* values; the
`AT_LEAST` / `AT_MOST` ordering pairs over all 540 knob combinations; and
coherence — `deriveOperatingPlan()` returns `Coherent | Conflict{binding}`, and
no shipped persona (nor any of 500 generated ones) conflicts.

## Consequences

- Re-measuring one quantity moves a whole family of constants together, and the
  golden diff shows the entire blast radius in one file.
- The residue is countable. "Eighteen numbers we cannot justify" is a backlog;
  "119 numbers someone tuned once" is not.
- `deriveOperatingPlan()` is a new seam for the UI: the Rate & Safety card can
  show the effective margin and, when a config is infeasible, which fundamental
  binds. Nothing consumes it yet.
- Cost: a derived constant is one indirection from its use site. The identity
  tests in `tests/timing/config.test.ts` and `tests/settings/pattern-map.test.ts`
  exist to pay that back — they say, in one line each, which sentence produced
  which number.

## Deferred to wave B

**Adaptivity.** The design's `hysteretic()` — measured percentiles feeding the
derivations once `n ≥ 64`, toward-safety free, toward-speed gated at `n ≥ 256`
and ≤1.35× per step, hard-clamped to `[seed × 0.5, seed × 2]`, frozen while the
ladder is engaged, and a definitive rate-limit refusal lowering the effective
margin by 0.6× for a soft-wall p50 — needs the `spans` table to read from. The
`LATENCY.*` and `ORDINARY_*` seeds and the `RateInputs` parameter on the
derivations are the shape it will plug into; the perturbation properties already
test that shape.

## Alternatives rejected

- **Leave the numbers where they are and write better comments.** A comment is
  not checkable. The three defects in ADR 0606 all survived several review passes
  in a file whose every key already had a rationale.
- **Tolerance-based equality ("within 10% of today").** It hides exactly the
  disagreements worth reading. Exact equality or a named override, nothing else.
- **Derive the `HARNESS` group too.** Those are the timings of a human watching a
  debug run. Fabricating a fundamental to explain a 4-second capture settle would
  be the failure this ADR exists to prevent.
