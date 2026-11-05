# 0602 — One outcome algebra, and `switch` + `absurd` instead of a matcher

**Status:** accepted · **Area:** kernel (`src/kernel/outcome.ts`, `absurd.ts`,
`result.ts`); consumed by adapter → rim → engine in wave B

## Context

Every layer answers the same question in a different vocabulary: `StepResult`
(11 bare strings), `HaltReason` (a 12-variant union), `ChurnActionOutcome`
(a struct plus `cause?`, `alreadyInState?`, `unverifiedClick?`),
`AcquireEndReason`, `EnvelopeKind`, `MutationOutcomeKind`, and
`Result<T> = {ok:false; reason: string}`.

Two defects follow from that, both present today:

1. **The error channel is prose.** The Actor returns `Result<T>`; `churn-actions.ts`
   then re-derives the real classification with `instanceof` checks on six thrown
   error classes. Every consumer re-parses what the producer already knew.
2. **Optional fields make illegal states legal.** `{status:'ok', cause:'drift'}`
   type-checks. The struct is a union wearing a costume.

Yet the codebase *did* discover the right split empirically — Instagram refused
us · our machinery broke · the attempt genuinely failed · the user stopped us ·
it worked. It is just spelled five different ways.

## Decision

One algebra in the kernel:

```
Outcome<A> = Ok<A> | Refused{by, definitive} | Broken{by, clickMayHaveLanded}
           | Failed{by} | Interrupted
```

with `Refusal` / `Breakage` / `Failure` as their own small unions, and — the
point of the exercise — a table:

```ts
const EFFECT = { Ok:'transition', Refused:'untouched', Broken:'untouched',
                 Failed:'burn-retry', Interrupted:'untouched'
               } as const satisfies Record<OutcomeTag, RecordEffect>;
```

`satisfies` makes the table total: a new variant does not compile until it
declares what it does to a follow record. In wave B `applyOutcome` becomes the
**only** function permitted to write a `follow_record` and dispatches on
`EFFECT[o._tag]`, so "the record is untouched when Instagram blocks" stops being
a paragraph in `churn-actions.ts` and becomes a lookup.

`Res<A,E>` (`result.ts`) stays as the small local utility for failures the caller
enumerates. `src/utils/result.ts` and its `reason: string` are deleted.

Exhaustiveness comes from `switch` + `absurd(x: never)`.

## Consequences

- `ChurnActionOutcome` and `HaltReason` become *projections* of one algebra
  rather than parallel vocabularies; `isRateLimitHalt(key: string)` can take the
  reason object instead of a string it might stop matching after a rename.
- `reasonKey()` gives spans, logs and the halt vocabulary one stable string,
  produced by a `switch` that fails to compile when a variant is added. Compare
  `haltReasonKey` (`src/engine/halt-reason.ts:37`), whose doc-comment claims
  exactly this property and then uses a ternary — the claim is false today.
- Every non-Ok variant carries required evidence, so the optional-cause triple
  and the illegal combinations it permitted are gone.

## Rejected: `ts-pattern` 5.9.0

Its win is *deep* matching on nested shapes — precisely what a flat `_tag`
algebra removes the need for. `switch` + a 3-line `absurd` gives the same compile
error at zero dependency and zero checker cost, in a repo whose reviewers read
code cold (see ADR 0301, 0401, 0501 for the same trade taken the same way).
