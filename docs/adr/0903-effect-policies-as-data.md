# 0903 — Effect policies as data

**Status:** accepted (declaration only) · **Area:** engine
(`src/engine/effect-policy.ts`, `schedule.ts`)

## Context

Around every Instagram-facing effect the app repeats the same six decisions:
which ledger to debit, what timeout to use, whether a retry is allowed, what a
refusal does to the follow record, what must be true first, and how many may run
per iteration. Today each decision is re-made at each call site:

- `churn-scheduler.ts` and `prune-engine.ts` each carry their own `switch` over
  an action outcome, and each independently implements "a blocked action leaves
  the record untouched" (ADR 0206). Two copies of one rule is one copy too many.
- "Never re-drive a mutation at full pace" is a comment. Nothing stops a future
  call site from wrapping `actor.follow()` in a retry loop.
- Timeouts are constants read at the call site rather than a property of the
  operation.

## Decision

Every IG-facing effect declares a policy, in one table:

```ts
type EffectPolicy = {
  budget: 'mutation' | 'read-heavy' | 'read-light' | 'local';
  timeoutFrom: LatencyOp;            // timeout = measured p99 × TIMEOUT_SLACK
  onRefusal: 'record-untouched' | 'record-failed' | 'record-ambiguous';
  requires: readonly ('tab' | 'session' | 'online')[];
  perIteration: 1 | 'unbounded';
  span: string;
} & ({ idempotent: true;  retry: Schedule | 'never' }
   | { idempotent: false; retry: 'never' });
```

The union in the second half is the load-bearing part: **`idempotent: false`
makes a retry schedule a compile error.** A click that may have landed can never
be re-driven by a runner; the only re-drive path in the app is the recovery
ladder, through a hold. That is ADR 0206's rule, expressed as a type instead of
a convention.

`Schedule` is data too (`src/engine/schedule.ts`):
`once | recurs | exponential | jittered | truncate | table`. The recovery ladder
becomes ONE value — `RECOVERY_LADDER` — carrying the per-rung medians, the
log-normal sigma, the clamp band and the rung count, and
`tests/engine/schedule.test.ts` proves `draw()` reproduces
`RecoverySupervisor.nextHoldMs()` **value for value and rng-draw for rng-draw**,
so substituting it cannot shift any downstream seeded draw.

## Scope this wave

**Declaration only.** `EFFECT_POLICY` is consumed by nothing but a totality test
asserting it covers every effect id. Wave B's effect runner reads it and both
outcome `switch`es collapse into `onRefusal`; the budget debit moves in front of
dispatch so a new call site cannot bypass the governor.

## Consequences

- A new IG-facing effect is a tsc error until its policy exists.
- The retry rule is checked once, at the table, instead of reviewed at every
  call site.
- The span names form a closed vocabulary, which is what the `spans` table's
  `name` column and the derived-latency percentiles both consume.
- Two files now hold a local copy of a kernel concept (`absurd`, `Schedule`).
  That is deliberate for wave A — the runtime may not import `src/kernel` yet —
  and each carries a `SEAM (wave B)` comment naming its permanent home.

## Alternatives rejected

- **A `retryable()` helper at each call site.** Same convention, new spelling;
  nothing prevents the next call site from skipping it.
- **`effect@3`'s `Effect.retry(policy)`.** The policy shape is the good idea and
  it is stolen here; the runtime is not (see ADR 0603 and the v4 design §8).
- **Deriving the table from the surface descriptors.** The surface knows *how*
  to press a control, not what a refusal means to a follow record. Different
  layer, different vocabulary.
