# 1007 — A module graph, not a DI container (and a Session for the graph)

Status: accepted (2026-09-02)

## Context

`foundation-wiring.ts` was 2,193 lines and is routinely called a god object. It
is not one. It is a **lifetime manager wearing a facade**: it conflates
construction (what depends on what), lifetime (what exists before login vs
after), policy (who may drive the tab), and projection (what gets pushed).

The lifetime half is the expensive one. The knowledge graph does not exist
until the `ds_user_id` cookie resolves, and that single fact produced six
mutable fields — `graph`, `buildPromise`, `ownPkCache`, `usernameRetryAt`,
`disposing`, `tearingDown` — read by roughly forty `if (graph === null)` guards
spread across every method in the file. Nothing named the transition, so every
method had to test for it.

ADR 0102 and 0104 already carved out `graph-builder.ts` and `TabLease`. This
finishes that direction by making construction and lifetime declarative.

## Decision

Two files in `src/kernel/`, importing nothing from `src/`:

- `module.ts` — `Lifetime {start?, stop?, dispose?}`, `Module<T, D, H>`
  (`id`, `needs`, `build(deps, host)`) and `compose(roots, host)`. Every
  reachable module is built exactly once in dependency order, started in that
  order, and disposed in the exact reverse of the order it started. A cycle is
  raised before anything is built; a failed `start()` disposes every module
  whose `start` had completed, newest first, and rethrows. Each of those five
  guarantees is a fast-check property over randomly generated DAGs
  (`tests/kernel/module.test.ts`), not an assertion about one hand-drawn graph.
- `session.ts` — `Session<T>` (`current`, `onOpen`, `onClose`) plus
  `bindToSession`, which states THE RULE: a dependent declared over a session
  is built on open and disposed on close, with transitions serialized so a
  close landing mid-start cannot race it. Binding to an already-open session
  builds immediately.

`src/main/modules/session.ts` (`GraphSession`) owns the six fields and
publishes a `Session<BuiltGraph>`. `Foundation` keeps a private
`get graph()`/`get disposing()`/`get tearingDown()` that read it, so the ~40
guard sites are unchanged text over a single source of truth. The push
machinery is the first dependent bound to the session; `main/modules/not-built.ts`
holds the two projections served while it is closed.

`src/main/app.ts` composes the graph (`UpdaterModule` today) and `main.ts`
calls it. `bootstrap.ts`, `window/shell.ts` and `adapter/tab.ts` are out of
scope for every wave — the kernel wraps them, never rewrites them.

A tiny DI container was considered and rejected: containers resolve by
name/token at runtime, which throws away the compile-time dependency graph.
`needs` references the dependency module directly, so a missing dependency is a
type error and `Composed.get(m)` is keyed on module identity, not a string.
`effect`'s `Layer` was rejected for the same reason as everywhere else (§8 of
the v4 design): adopting it means adopting an effect system across 39k lines of
imperative `async/await`. The three ideas worth stealing — declared deps,
scoped lifetimes, reverse-order finalizers — are 250 lines we own.

## Consequences

- `build` is construction ONLY. A module that acquires a resource in `build`
  and whose own `start` then throws is never disposed — the contract says
  acquire in `start`, release in `dispose`, and the property test pins it.
- `foundation-wiring.ts` drops from 2,193 to ~1,950 lines, and — more to the
  point — stops owning the graph's lifetime. The remaining verbs (engine
  control, prune control, manual ops, the sleep/wake + watchdog lifecycle) are
  wave B's modules; each is coupled to the tab lease and the veil's activity
  machine, which is why they move as units rather than as line count.
- `Composed.stop()` and `Composed.dispose()` stay orthogonal: `dispose` does
  not imply `stop`, so a module that must quiesce before releasing does it in
  its own `dispose`. Unwinding never aborts on a failure; errors are reported
  through `onUnwindError`, which the app wires to the logger (the kernel has
  none by construction).
