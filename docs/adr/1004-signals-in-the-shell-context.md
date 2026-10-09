# 1004 — Signals in the shell context

Status: accepted (2026-09-02) — supersedes the deferral in ADR 0403

## Context

ADR 0403 put the four shell-owned projections behind one `ShellContext` and
deferred `@preact/signals`, naming the condition for revisiting: "signals stay
available now that `App.tsx` is decomposed into small hooks." That is now true —
`App.tsx` is hook composition — and 0403's own Consequences section names the
defect it left standing:

> The context value object is rebuilt every render, so every consumer still
> re-renders on every push.

Two costs followed from that. A streamed log line re-rendered the whole tree,
which is *why* `GraphStage` had to hoard its world in refs (its comment says
so). And a status push during a scan — the mechanism PRINCIPLES §2 exists to
guarantee — re-rendered every view, every card, the graph stage and the prune
page, dozens of times a minute, to move two numbers.

## Decision

`app/shell-context.ts` publishes the four projections as module-scope signals —
`statusSignal`, `pruneSignal`, `settingsSignal`, `logSignal` — plus two computed
values (`transportSignal`, `latestLogSignal`). The subscription plumbing is
untouched: `useKeepAlivePoll` still subscribes push-first with a keep-alive pull
backstop; only its sink changed from `useState` to a `Signal`. `chainListKey` /
`countKey` and `useGraphBoard`'s trailing-coalesced refetch are unchanged.

Three consequences of that shape are deliberate:

- **`useShell()` keeps its signature, with getters.** It returns the same
  `Shell` object shape, but `status`/`prune`/`settings` are property getters, so
  `const { settings } = useShell()` subscribes that component to *settings only*.
  Eagerly reading all four would have re-subscribed every consumer to every
  push — the exact churn we came to remove. `confirm` and `toast` stay in a
  Preact context: they are per-`App` closures, not projections.
- **`transportSignal` caches its object.** `transportModel()` builds a fresh
  object per call, so the computed returns the PREVIOUS object whenever all
  three fields match. Referential stability is what makes the console's
  `data-state`, the transport trio and the control routing sit still while
  counts tick underneath.
- **The shell subscribes without reading.** `App` calls `useEngineStatus()`,
  `usePruneStatus()`, `useSettings()` and `useLogFeed()` for their effects; they
  return `void`. `Header` reads `transportSignal`, `Ticker` and `ActivityCard`
  read the log, and the handlers read with `peek()` at press time. A push now
  re-renders the components that display it and nothing else.

**`subscribe()`, not `useSignalEffect`, for watches.** `useStartWatch` and
`useTourGate` must see EVERY pushed value. `@preact/signals`' `useSignalEffect`
re-runs through `options.requestAnimationFrame`, so two pushes in one frame
collapse into one run against the LAST value — which for the Start watch would
swallow the status that disarms it, and in a test environment (where nothing
restores the rAF queue) can stop the effect from ever re-running again. Both
hooks use `signal.subscribe()` inside a `useEffect`, which is synchronous per
write and reproduces the old `useEffect([status])` semantics exactly.

## Consequences

- `tests/renderer/view-liveness.test.tsx` asserts, per view, that a *pushed*
  projection MOVES a rendered number with no pull behind it. A stale closure or
  a dropped subscription now fails a test instead of silently freezing a
  counter — the failure mode signals introduce.
- Signals are module scope, so they outlive a `render()`. `installFakeBridge`
  calls `resetShellSignals()`, and that reset is the only test-only export in
  the module.
- `GraphStage` may stop hoarding state in refs to dodge parent re-renders. It
  still owns its canvas world imperatively, but now for the honest reason
  (canvas is not VDOM), not to escape the shell.
- The `Transport` and `LiveStatusCard` components keep taking props; only their
  containers read signals. Presentational components stay directly renderable in
  a test and in the gallery (ADR 1006).
