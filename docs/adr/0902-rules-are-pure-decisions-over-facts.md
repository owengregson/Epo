# 0902 — Rules are pure decisions over a Facts snapshot

**Status:** accepted · **Area:** engine (`src/engine/facts.ts`, `rules.ts`, `engine.ts`)
**Supersedes the mechanism of:** ADR 0205 (the gate table). Its *contract* — one
action per iteration, precedence as data — is unchanged and now stronger.

## Context

ADR 0205 replaced a 254-line `if`-chain with an ordered `GATES` table. That was
the right shape, but each gate was `async run(ctx)` calling back into a
`GateHost`, so a "rule" could await, read the clock, hit the store and drive
Instagram — all inside the thing that was supposed to be *deciding*. Three
consequences:

- **The precedence could only be asserted example by example.** `gates.test.ts`
  pinned the order and ~13 hand-written short-circuit cases. "For ANY state,
  aborted wins" was prose.
- **`clockGate` existed only to say "sample the clock once."** A rule that reads
  the world cannot be given a consistent snapshot; it has to be handed one by a
  gate above it, by convention.
- **Prune could not merge.** `prune-engine.ts` re-implements pause/resume/stop/
  halt/streaks/status because the growth loop's gates are welded to the growth
  host. Merging two hosts is only safe once rules stop being calls into a host.

## Decision

A rule is a **pure function of a `Facts` slice**:

```ts
interface Rule<N extends FactKey> {
  id: RuleId;
  modes: readonly Mode[];
  needs: readonly N[];                                  // gathered, once
  decide(f: Pick<Facts, N>, run: RunCtx): RuleVerdict | null;   // no await/store/clock
}
```

`RuleVerdict` is `halt{reason} | park{spec} | run{effect} | yield`. A `halt` with
`reason: null` is "this generation is superseded, or we already halted" — one
class, so *aborted dominates everything* is a single property rather than a
special case. A `run` carries **at most one** `EffectRef`, which is what makes a
burst unrepresentable rather than merely disallowed (ADR 0205, now in the type).

Everything that has to touch the world is a **`FactSource`** with a staleness
budget, gathered by `FactGatherer` **lazily, in rule order, and memoised per
tick**. That is not an optimisation, it is the safety property: `sentinel` is
only gathered when the `sentinel-auth` rule asks for it, which happens only
after the `aborted` rule has declined the tick — so a superseded step still
never touches Instagram, without an ordering comment.

`clockGate` disappears: `clock` is a fact source, so "every rule below reads the
same instant" is true of the whole runtime, not of one gate. Twelve gates became
**eleven rules plus one fact source**.

`decideProgram(run, gather)` is the whole conductor, and the executor and the
property tests drive the *same* function — the tests cannot be testing a
different loop from the one that ships.

## Consequences

**The precedence is a property, not a list.** `tests/engine/rules.test.ts` runs
fast-check over generated `Facts` and proves: exactly one verdict, always;
deciding is pure (same facts ⇒ same verdict); `aborted ⇒ halt` regardless of the
other fields; an auth sentinel ⇒ `halt{sentinel}` unless aborted; an armed hold
is served unless aborted/auth; the safety prefix always wins over growth; within
the safety prefix `halt` dominates `run`; a `run` verdict carries one effect.

**Undeclared reads are caught.** The test harness passes a `Facts` proxy that
throws on any key outside `rule.needs`, so "the kernel gathers exactly these"
is enforced.

**Prune is a mode.** `PROGRAM = { safety, growth, scan, run }`; `programFor(mode)`
is `safety ++ mode`. The prune rule lists are declared and tested here; wave B
merges the loop onto them and ~600 lines of `prune-engine.ts` delete. The
per-candidate correctness rules moved out first, unchanged, into
`prune-candidate.ts`, shared by both paths today.

**Pacing gating became pure.** `pacingVerdict(facts)` returns a `ParkSpec`; the
executor performs the wait. Both models are now testable without a clock, a
`WaitRunner` or an Engine.

**The cost.** A fact source may still mutate as it reads (the churn scheduler's
timer advance, the planner's `advance(now)`, the feed's leading-skip
consumption). Those are documented at each source with the ordering they
preserve. Wave B moves the remaining ones behind Chronos and Scope.

## Alternatives rejected

- **Keep `GateHost`, add a property test over the host.** The host is an
  interface over a live Engine; generating one is generating a mock, and a mock
  proves nothing about precedence.
- **xstate.** `after()` delays do not persist remaining time across a
  rehydration — a direct violation of PRINCIPLES §3, and precisely the bug the
  recovery hold's absolute deadline exists to prevent. Twelve ordered rules is
  not a topology problem (see the v4 design §8).
- **Gather every fact eagerly.** Simpler to type, but it would call the sentinel
  on a superseded step and advance the pacing planner during a ceiling park.
  Laziness *is* the semantics.
