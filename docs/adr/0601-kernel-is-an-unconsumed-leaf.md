# 0601 — The kernel lands as an unconsumed leaf

**Status:** accepted · **Area:** kernel (`src/kernel/*`, `tests/kernel/*`)

## Context

Epo's design is already correct; it is enforced in prose. PRINCIPLES §1–§3, ADR
0205 ("one action per iteration"), ADR 0206 (unverified-click arbitration) and
ADR 0303 (`SHAPE_MISMATCH` never collapses to empty) are rules a reviewer has to
remember. A framework reset's whole job is to move each of them from a comment
into a type, a table, or a gate.

That is a wide change. Every previous attempt to make a wide change safe in this
repo has used the same trick: land the new mechanism first, prove it in
isolation, and migrate call sites afterwards (the `Pacer` port, the `GATES`
table, the versioned adapter). The kernel is the largest instance of it.

## Decision

`src/kernel/**` **imports nothing from `src`**. Its only external dependency is
`zod`, and only inside `parse.ts`. It ships with its own property suites and
**nothing consumes it in wave A**.

Consequences of the no-import rule, accepted deliberately:

- Vocabulary the kernel needs from elsewhere is **restated, not imported**.
  `AuthStatus` (`outcome.ts`) mirrors `SentinelStatus`
  (`src/adapter/ig-surface.ts:223`); `normal01`/`logNormal` (`schedule.ts`)
  restate the Box–Muller and median-parameterised log-normal math from
  `src/timing/distributions.ts`. Each restatement carries a comment naming its
  twin, and the migration deletes the twin rather than keeping both.
- The kernel type-checks in isolation, so it cannot silently acquire a
  dependency on the engine, the store or Electron.
- A wave that goes badly is reverted by deleting a directory. Nothing imports it.

The adoption order is written down once, in `src/kernel/index.ts`, and it is a
strict sequence: derived constants → the adapter parse boundary → the outcome
algebra → brands at the store boundary → capabilities → `Scope` in the conductor
→ `FollowRecord` as a union. Each step is independently revertible.

## Consequences

- The kernel is worth reviewing on its own terms — the suites are the spec.
- There is a period where two vocabularies coexist (`Result<T>` and `Res`,
  `SHAPE_MISMATCH` and `Parsed`). That is the price of a revertible migration,
  and each ADR below names the older type it deletes.
- **Trip-wire, set in advance:** if the last step (`FollowRecord` as a union)
  needs more than ~200 changed lines outside the store, stop at the outcome
  algebra. Ceremony that costs more edits than it catches bugs is a defect, and
  a leaf is exactly the shape that lets us stop early without unwinding.

## Rejected: growing the kernel out of an existing module

`src/utils` and `src/timing` were both candidates for "just add it here". Both
already import from `src`, so neither can hold a type the store, the adapter and
the renderer all depend on without creating the cycles the layering forbids.
