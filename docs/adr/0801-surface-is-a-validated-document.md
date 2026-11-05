# 0801 — The Instagram surface is a validated document, not a 45-method interface

**Status:** accepted · **Area:** surface (`src/surface/**`, `src/adapter/versions/*`,
`src/adapter/ig-surface.ts`)

## Context

`IgSurface` is a hand-maintained façade: 45 members, eight `extract*` guards, eight
result interfaces that must be kept in sync with them by hand, and 14
`locate*Script` builders. Every one of those has to be re-implemented, correctly,
for each new Instagram capture — and nothing checks that the eight extractors and
the eight interfaces still agree, because they are separate declarations of the
same fact.

Three consequences followed from that shape:

- **Types were declared, not derived.** `FollowersListResult` said what we believed
  a followers page contained. Nothing connected that belief to a real body.
- **Drift was a sentinel that died in a log line.** `SHAPE_MISMATCH` said "this body
  is not what I expected" and nothing else: not which field, not which type, not how
  often. Diagnosing a shape change meant adding logging and waiting for it to happen
  again.
- **There were no contract tests at all**, because the only real bodies in the tree
  are `docs/adapter/fixtures/`, which is git-ignored (it contains the owner's real
  Instagram data). The page scripts were tested against hand-written markup
  approximating what we thought Instagram shipped.

## Decision

The surface becomes a **validated data document** under `src/surface/`:

```
schema/endpoints.ts     one zod schema per read endpoint, PII declared per field
schema/surface.ts       the document's own schema + the typed face
versions/<date>/        literals.ts (every Instagram literal) + surface.ts (the document)
index.ts                loadSurface() — validated ONCE, cached, never half-built
parse.ts                parse → project, with a novelty pass alongside
```

An endpoint is `{ kind, mode, match, response, project }`. The **response schema is
the contract** and `project()` emits **one fact per row**, so PRINCIPLES §1
(facts stream) is a property of the projector's shape rather than a rule consumers
must remember. Controls are **descriptors** over six locate strategies which the page
bundle interprets through one entry point (`locate` / `probe`), with an `escape`
tier whose payload names a page function and which the loader REFUSES unless it
cites the ADR that authorised it.

`src/adapter/versions/2026-08-12.ts` keeps its `IgSurface` shape but declares no
literal of its own: it reads the document for routing, mutations and signals, and
imports everything else from `versions/2026-08-12/literals.ts`. The constraint
"every Instagram literal lives in exactly one versioned module" is unchanged and
now stronger — the module is a directory, and the adapter façade is a shim with a
deletion date.

## Consequences

- A new capture is a **data edit plus a contract-test run**, not eight extractor
  rewrites.
- A mismatch carries its **zod issue path**, so "which field, which type" is in the
  first log line. It is also a distinct TYPE from every success shape, which makes
  ADR 0303 structural: an end-of-list claim cannot be constructed from a mismatch
  because a mismatch has no `cursor` to read.
- PII is declared where the field is declared, which is what makes the fixture
  scrubber an allow-list (ADR 0802) rather than a hopeful deny-list.
- Row containers stay `z.array(z.unknown())` at the envelope level and are parsed
  per row inside `project()`. A single malformed row must not reject a page whose
  other rows are facts already paid for (§1) — it is COUNTED as a `rowIssue` instead.
- `src/surface/**` imports zod and the store's `Observation` type and nothing else.
  No Electron, no adapter, no engine — which is why the contract tests can load a
  surface with no tab.

## Migration status (wave A)

Every endpoint is `mode: 'observe'`: the legacy extractor still drives behaviour and
the schema runs beside it (ADR 0802). `IgSurface` survives as the migration seam and
is deleted once every endpoint is `enforce`.

## Alternatives rejected

- **Generate the schemas from the fixtures.** Produces overfit types: an optional
  field becomes required because every captured account happened to carry it, and
  one account's `full_name: ""` becomes a literal. The schemas are hand-authored
  (~10 lines each) and `surface-lab diff` reports what the corpus actually contains
  as an authoring aid.
- **arktype / valibot / @effect/schema.** One validation dependency, not two; zod 4
  is already in the tree for settings, and `z.toJSONSchema` is what drives both the
  scrubber and the novelty pass.
- **Keep `IgSurface` and add tests.** The duplication between the eight extractors
  and the eight interfaces is the defect; testing both copies does not remove it.

## Amendment — 2026-11-03: enforcing reads and witnessed recovery (ADR 0806)

Every endpoint now enforces the surface read pipeline. Canonical and declared-normalization reads
carry presence and completeness evidence; witnessed recovery adds facts without granting destructive
verdicts. `ObservedReads` memoizes each response for its consumers. Legacy extractors run only as
reverse-shadow comparators until L1 and L4 record zero disagreement; their final removal remains
conditional on that live evidence, as recorded in the overhaul QA document.
