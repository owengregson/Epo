# 0606 — What the derivation found

**Status:** accepted · **Area:** kernel (`src/kernel/overrides.ts`), recovery,
pattern-map

## Context

ADR 0605 replaced 119 hand-written constants with derivations from twelve
empirical quantities and a handful of policy dials. The point of doing that is
not tidiness — it is that a derivation *disagrees* with you. This ADR records
every disagreement and what was done about each.

## 1. The prune cool-down was shorter than the wall it exists to sit out — FIXED

`RECOVERY.PRUNE_COOLDOWN_AFTER_RATE_HALT_MS` was **2 h**. Its own comment says
what it is for: "Scheduled prune stays off the tab this long after a
rate-limit-classified halt — a census walk into the same wall would deepen the
block."

The observed soft rate wall has a p50 of **3 h**. A scheduled prune therefore
came back, on the median, an hour before the wall came down — walked a census
into it, and deepened the block. The value that made it safe was never written
down anywhere; 2 h was a plausible-looking round number.

**Fixed.** The constant is now `SOFT_WALL_DURATION_H.p50` — 3 h. This is the ONE
key in the registry whose value changes in this wave, and the golden test asserts
both that it changed and that nothing else did.

It is worth noting how invisible this was. Two other constants in the same group
were already derived from the same p50/p90 pair and were correct
(`EXHAUSTED_REVERIFY_WINDOW_MS = 2 × p90 = 48 h`, the ladder's first two rungs).
The cool-down sat between them, in the same file, with a comment describing
exactly the failure mode it was too short to prevent.

## 2. `aggressive` operates at 100% of the observed daily wall — SURFACED

`dailyPlan / FOLLOW_WALL_PER_DAY.low` is the number that matters and the ordinal
table never showed it:

| activityLevel | plan/day | effective margin |
|---|---|---|
| minimal | 15 | 0.15 |
| light | 30 | 0.30 |
| moderate | 50 | 0.50 |
| active | 75 | 0.75 |
| **aggressive** | **100** | **1.00** |

`aggressive` plans exactly the low end of the observed daily wall. That may be a
defensible product choice — it is the top of a five-rung scale, and the hourly
velocity guard still applies — but it should be a choice the user can see, not a
consequence of `k = 1.8` in a table.

**Surfaced, not changed.** `effectiveMargin(level)` and
`deriveOperatingPlan(pattern).effectiveMargin` expose it; the Rate & Safety card
should show it. Behaviour is unchanged.

## 3. The predicted `nightowl + aggressive + cautious` conflict does NOT reproduce

The design predicted this combination would be infeasible: session mass
`H_eff ≈ 6.1 h`, so `hourlyCap × H_eff = 14 × 6.1 = 85 < 100`, and the app would
silently under-deliver.

Computed against the app's actual circadian field
(`∫λ(t)dt` over the day, averaged across the week, at 5-minute resolution), the
night-owl shape has the **largest** session mass of the five — ≈14.3 h, against
≈12.1 h for `balanced` — because its overnight floor is four times higher (0.06
vs 0.015) and its bumps are the widest. `14 × 14.3 = 200 ≥ 100`: coherent.

Across all 2,700 combinations of the knobs that move a number, **nothing is
infeasible today.** The tightest is `aggressive + cautious + morning + weekdays`
at 1.43× headroom — the morning shape, not the night-owl one.

**Kept anyway.** `deriveOperatingPlan()` returns `Coherent | Conflict{binding}`,
the `Conflict` branch is proved live by a test that squeezes the hourly wall from
60 to 12, and the check becomes load-bearing the moment adaptivity (wave B) can
lower the effective margin after a refusal. The lesson is the one this whole
exercise is for: the estimate was wrong in the direction nobody would have
checked, and computing it settled the question in a way arguing could not.

## 4. The gap floor does not scale with the cap it protects — PINNED

`gapFloor = 3600 s / (cap × BURST_TOLERANCE)` is the fastest instantaneous pace
the policy sanctions at a given hourly cap:

| caution | cap | derived floor | shipped |
|---|---|---|---|
| cautious | 14 | 70 s | **60 s** |
| standard | 22 | 45 s | 45 s ✅ |
| bold | 30 | 33 s | **35 s** |

`standard` is exact. The two ends are not, and they are not off in the same
direction: at cap 14 the shipped 60 s permits a 4.3× burst where the policy
sanctions 3.7×, while at cap 30 the shipped 35 s is 2 s more conservative than it
needs to be. The shipped table simply does not scale with its own caps.

**Pinned for wave A** (behaviour freeze). Raising `cautious` to 70 s is a real
safety improvement and belongs in wave B, where it can be shipped with a note in
the release rather than smuggled in under a refactor.

## 5. `cautious + bursts` needs a clamp — DOCUMENTED

`resolvePattern` computes `gapFloorSeconds: min(floor, gapMedian)`. That `min` is
load-bearing for exactly one knob pair: `cautious` (60 s floor) with `bursts`
(55 s median). Everywhere else the two tables agree without help, and no shipped
persona hits it — `casual` is cautious + trickle, `nightOwl` is standard +
bursts.

**Documented, with a test that pins it to exactly that one pair.** If the
`cautious` floor rises to its derived 70 s, this clash widens to
`cautious + sessions` too, which is the sort of thing that should be decided
deliberately rather than absorbed by a `min`.

## 6. The cold breaker threshold is one rung conservative — RECORDED

`ACTIONS_FAILING_HALT = 8` (in `src/engine/engine.ts`, outside the timing
registry). The posterior at π = 0.005, q = 0.30, confidence 0.9 needs
`k ≥ 6.22`, i.e. **7**. The other three thresholds derived from the same frame
match exactly: `REENTRY_FAILS = 2`, `BLOCKED_STREAK_ENTRY = 3`,
`PRUNE_CONSECUTIVE_BLOCK_HALT = 3`, and "drift needs two windows".

**Recorded as an advisory override** — visible and arguable as a ±1, not applied.
Wave A does not touch `src/engine`.

## 7. Ladder rung 3 is flattened — PINNED

`hold(n) = W_p50 × 0.33 × 1.5^(n-1)` gives 60 min, 90 min, **135 min**. The
shipped ladder is 60 / 90 / **120**. Rungs 1 and 2 are exact; rung 3 was flattened
by hand. The coverage requirement (`Σ ≥ p50 = 3 h`) is met either way — 4.5 h
shipped, 4.75 h derived — so nothing is unsafe.

**Pinned.** Worth revisiting together with open question 2 (a `'p90'` ladder
would be 7 rungs covering 24 h, which is a product decision about whether a
day-long wall should surface to the user or be waited out silently).

## 8. Sixteen pacing-band edges are hand-set — PINNED

Nine uniform pacing bands (`REFILL_PACING`, `ENRICH_PACE`, `ACQUIRE_SCROLL`,
`LIST_WALK_PAGE`, `LIST_WALK_REST`, `NOTIFICATIONS_CLOSE_DELAY`,
`NOTIFICATIONS_SCROLL_WAIT`, `ACCEPT_PACE`, `RESUME_SETTLE`). Their midpoints are
policy quantities with real rationales; their widths range from ±28.6% to ±54%
with nothing distinguishing them. One shape (`±28.6%`) reproduces `ENRICH_PACE`
exactly; the other eight bands' edges are pinned.

**Pinned.** This is the honest residue: 16 of the 18 applied overrides are band
edges. They are the cheapest thing in the registry to unify (one width, nine
bands) and the least urgent, because a pacing band's exact width is the one kind
of constant where "somewhere in this range, jittered" really is the whole
requirement.

## Summary

| # | Finding | Action |
|---|---|---|
| 1 | Prune cool-down (2 h) shorter than the p50 wall (3 h) | **Fixed** → 3 h |
| 2 | `aggressive` = 100% of the low daily wall | Surfaced via `effectiveMargin` |
| 3 | Predicted night-owl infeasibility | Does not reproduce; check kept |
| 4 | Gap floors don't scale with their caps | Pinned; wave-B safety change |
| 5 | `cautious + bursts` needs the `min` clamp | Documented + pinned by test |
| 6 | `ACTIONS_FAILING_HALT` 8 vs derived 7 | Advisory override |
| 7 | Ladder rung 3 flattened (120 vs 135 min) | Pinned |
| 8 | Sixteen hand-set pacing-band edges | Pinned |
