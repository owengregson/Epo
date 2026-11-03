# 0103 — Settings declared once, as a rule table (not a zod schema)

Status: accepted (2026-09-02)

## Context

Forty-eight knobs were declared four times: the documented `Settings`
interface, a `DEFAULT_SETTINGS` literal (35 explicit keys plus a
`...resolvePattern()` spread supplying the other 14), a 146-line
`sanitizeSettings`, and a 14-line persona-derivation block copy-pasted into both
of its branches. Adding a knob was four edits in three idioms, and a missed
sanitizer line shipped an unvalidated knob.

The refactor design preferred a `zod@^4` schema as the single source, on the
hard condition that `tests/settings/settings.test.ts` pass unmodified.

## Decision

Hand-consolidate, no new dependency.

`RULES` declares every knob once as `{fallback, coerce}` — default and safe
range on the same line — and is checked against the interface with
`satisfies { [K in keyof Settings]: Rule<Settings[K]> }`, so a knob missing from
either side is a compile error. `DEFAULT_SETTINGS` is projected out of it;
`sanitizeSettings` applies it, then two ordering tables (`AT_LEAST`, `AT_MOST`),
then `applyResolvedPattern` — once, for both persona branches.

Zod was rejected here for two reasons, in order of weight:

1. **The semantics are coercion, not validation.** Every knob must degrade to
   the nearest safe value, never reject: `jitterPercent: 100` becomes `90`, not
   a parse error and not the `30` default. `z.number().min(0).max(90)` fails
   such a value, and `.catch()` substitutes the default rather than the clamp.
   Every field would need a bespoke `.transform(clamp)`, which is the existing
   helper wearing a schema costume — the dependency buys no rule we do not
   already write.
2. **`z.infer` would erase the per-knob documentation.** JSDoc on schema entries
   does not surface on the inferred type's properties, and this object is edited
   constantly from the renderer's Settings view, where hover docs are the
   contract. Keeping the documented interface AND linking it to the table with
   `satisfies` gives the drift protection without that loss.

## Consequences

- Declarations drop from four to two, compiler-linked.
- `tests/settings/settings.test.ts` passes unmodified, including the legacy
  migration: a file with no `pattern` key keeps its hand-set numeric knobs.
  That migration is now an explicit named pre-parse step
  (`migrateLegacyPattern`) rather than inline logic in `loadSettings`.
- The 14 persona-derived defaults have one home: `resolvePattern(balanced)`,
  referenced by the rules that need them.
- `ResolvedPattern`'s key set IS the derived-knob set, so `applyResolvedPattern`
  is one `Object.assign` and a new derived knob needs no edit there.

## Amendment — 2026-11-02: the v2 document keeps the coercion rule

Settings v2 (ADR 0105) keeps this ADR's rule — coercion repairs to the nearest safe value and never throws — and
moves it from the knob table to `src/settings/doc-rules.ts`, `satisfies`-linked to the v2 document so no field goes
uncoerced. Two refinements: garbage is dropped **and counted**, so protection garbage puts protection under review;
and an op that has no nearest safe value (a quiet window that is empty after snapping, seven days off) is refused as
`invalid` rather than repaired. The v1 table stays frozen under `src/settings/v1/` for the migration and older builds.
