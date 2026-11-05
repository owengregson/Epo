# 0603 — No effect system: steal three ideas, reject the runtime

**Status:** accepted · **Area:** kernel (`src/kernel/schedule.ts`, `scope.ts`,
`result.ts`); runtime (wave B)

## Context

`effect@3` offers this app four things it genuinely wants: a typed error channel
(Epo's biggest hole — see ADR 0602), typed DI through Layers (`EngineDeps` has 12
optional fields, which is 2^12 nominal production configurations and one that is
exercised), `Schedule` as data (the recovery ladder IS
`exponential |> jittered |> truncate`), and interruption (`AbortController` +
`superseded(token)` + `withTimeout` + `DelayManager` + `awaitParked` is four
mechanisms doing one job).

The Effect-shaped follow path is genuinely lovely:

```ts
const follow = (u: Username) => Effect.gen(function* () { … });
// Effect<Verdict, Drift | RateWall | TabStall | Interrupted, TabService | Clock>
```

## Decision

**Reject the runtime. Adopt three of its ideas as ~250 lines of owned code.**

The durability argument is decisive and specific to this app:

- **Fibers do not survive `app.quit()`.** Epo's hardest invariants are durable
  *across process restarts* — `action_delay_deadline_at`, `recovery_state`,
  `pacing_state`, `sweepLastRunAt`, and PRINCIPLES §3 ("work that came due while
  the app was closed runs first, never one interval later"). Effect's structured
  concurrency is scoped to one process, so the durable-deadline machinery stays
  hand-rolled either way. That removes the largest apparent win before any other
  argument is made — and it is the same reason `xstate@5` is rejected, whose
  `after()` delays do not persist remaining time on rehydration.
- **It is a pervasive rewrite.** Every `async` signature in `src/engine`,
  `src/rim` and `src/adapter` changes, across 114 test files. Estimate for a solo
  maintainer: 8–14 weeks, versus ~2 weeks for the kernel below.
- **It carries `fast-check` as a runtime dependency** into a 3-runtime-dep app.
- **Permanent comprehension tax** in a codebase whose reviewers are agents
  reading it cold.

What is stolen, and where it lives:

| Idea | Kernel module | Replaces |
|---|---|---|
| Typed error channel | `result.ts` (`Res<A,E>`) + `outcome.ts` | `src/utils/result.ts`'s `reason: string` |
| Schedule as data | `schedule.ts` (`once`/`recurs`/`exponential`/`jittered`/`truncate`, `draw`, `describe`) | `RECOVERY.HOLD_MEDIANS_MS` + sigma + factors + a rung counter in `recovery.ts` |
| Scoped lifetimes | `scope.ts` (`Scope`, `Resource`, reverse-order finalizers, cascading abort) | generation tokens, `superseded()`, `owedResume`, `parkedNow`, `awaitParked` |

`Schedule` being **plain data** is what makes it better than a combinator here,
not merely cheaper: a schedule can be printed on the Rate & Safety card,
property-tested, derived from the fundamentals, and **persisted into a `timers`
row** — which is exactly the thing a fiber cannot do.

`Scope` is deliberately timer-free (Promise + AbortController only). Durable
time is Chronos's job; a scope only owns lifetimes inside one process run.

## Consequences

- `EngineDeps`'s optional fields become required, with a `testDeps()` constructor
  for tests — one production shape instead of 2^12 nominal ones.
- Single-use capabilities are runtime-checked, not linear-typed (ADR 0602's
  honest limit; see `once()` in `capabilities.ts`).
- Revisit only on new evidence: an Effect release whose scheduler persists across
  process restarts, or a second app in this repo to amortise the tax.
