# 0608 — The settings envelope rule

**Status:** draft (SC stream; finalized in Phase I) · **Area:** kernel (`src/kernel/{settings-policy,derive-envelope,
derive-schedule,derive-audience}.ts`), `src/settings/{params*,resolve}.ts`

## Context

Settings v1 stored fourteen numbers derived from the pattern knobs and re-derived all of them on every save
(`settings.ts:397-414`), so an Advanced value silently reverted, and nothing bounded a hand-typed value by what the
kernel itself would ever choose: a 40/h cap was accepted while every preset stops at 30. Owner item 3 asks for
plain choices with an Advanced view; A3/A4 ask that no override raise a ceiling for convenience.

## Decision

1. **Three layers.** Intent (plain choices) → derived (computed at read time, in topological order, from the
   **effective** upstreams) → overrides `{value, setAt, basis}`. An override replaces a reference parameter, never a
   drawn value; it is clamped at resolve time and the clamp is reported, never written back.
2. **The envelope.** Every parameter declares its risk. The risky side is bounded by the most permissive value the
   kernel derives anywhere on the 30-point grid or in the plan's own pace band (`ENVELOPE`, computed once): ≤ 30/h,
   ≤ 100 and ≤ 130 a day, waits ≥ 2 days, a pruning share ≤ 0.5, checks ≥ 0.85 h (the briskest spacing the plan
   draws). Every timing row (`tempo.*`, both gap rows) is **slower only**. Law: `ENVELOPE.hourlyCap.max ≤
   FOLLOW_WALL_PER_HOUR.low`.
3. **The safe side** is `SETTINGS_GUARDS`, one guard line each. **Coupled bounds** come from effective upstreams:
   ceiling ≥ volume, burst floor ≤ minimum gap ≤ typical gap, pruning ≤ ceiling, ordered ranges and curves.
4. **`SETTINGS_POLICY`** is a tier-1 module: the quiet-hours rule (λ < 0.2 × peak, a 30-minute grid, ≤ 16 h), the
   typical-day z, the audience sizes and curve, the private edge, the recommendations no choice moves (the follow-back
   floor linked to the exploration prior), the interim recommendations until the plan port registers, the risk
   rungs, the Boost lengths, the tempo-override factor bound, the document version and the step grid.
5. **The plan core's numbers** (the effective gap at pace 1, the day law and its maximum, the retry limit) reach the
   settings core through one port, `PlanMath`, so the catalog, the view and the migration read them from one place.

## Consequences

- Identity: with no overrides the effective numbers are today's derivation at every grid point (a law).
- A change of intent never deletes an override; moving the intent back restores it; a moved recommendation under an
  override is reported as a conflict, and an override set against an older recommendation reads as stale.
- Going past the envelope means changing a POLICY dial, which needs an ADR.

## Alternatives rejected

- **Bounds per preset** (each card its own limits): an override could then exceed what any other choice allows.
- **Re-deriving on save** (v1): the silent revert this ADR ends.
- **Faster timing overrides** with a floor: the plan's own pace draw is the brisk side; an override that shortens a
  wait would add pressure no plan ever chose.
