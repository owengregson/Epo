# 0403 — One shell context for the pushed projections, not a signals store

Status: accepted (2026-09-02)

## Context

PRINCIPLES §2 (the UI mirrors the graph, live) is implemented by
`useKeepAlivePoll`: subscribe to a pushed channel, pull once on mount, and pull
again only when no push has arrived inside the keep-alive window. That is the
mechanism that makes counts tick DURING a scan, and it worked.

What did not work was *how many times* it ran. `usePruneStatus()` was subscribed
twice — in `App.tsx` and again in `PruneView.tsx` — and settings were fetched
twice (`App.tsx` and `QueuesView.tsx`). Two copies of one projection can
disagree. On top of that, `status`, `prune`, `settings`, `onSaved`, `confirm`
and `toast` were threaded through five view signatures into roughly fifteen
cards.

## Decision

One `ShellContext` (Preact's built-in `createContext`, no dependency) carrying
exactly the six things the shell owns once: `status`, `prune`, `settings`,
`onSaved`, `confirm`, `toast`. `App` subscribes and loads; views read
`useShell()`.

`@preact/signals` was considered and deferred. It is the Preact team's own
answer and would additionally give fine-grained re-render (today a streamed log
line re-renders the whole tree, which is why `GraphStage` keeps its world in
refs). But it is a paradigm shift inside every component, and the two concrete
defects — the duplicate subscription and the duplicate fetch — are fixed by a
context for roughly 20% of the churn. Signals stay available now that `App.tsx`
is decomposed into small hooks.

The subscription plumbing itself is untouched: push-first with a pull backstop,
`useKeepAlivePoll` unchanged, `useGraphBoard`'s trailing-coalesced refetch
unchanged, and `chainListKey`/`countKey` unchanged. Those keys look like
cache-busting cruft and are not — they are the §2 backstop for projections that
move without a counter changing.

## Consequences

- `ChainView` and `QueuesView` take no props at all; `PruneView` takes none;
  `SettingsView` keeps only what is genuinely shell state (`goTo`,
  `seedPrompt`, `onReplayTour`, `updateStatus`).
- A render test can assert `listenerCount('pruneStatus') === 1`, so the
  duplicate cannot come back unnoticed.
- The context value object is rebuilt every render, so every consumer still
  re-renders on every push — the same as before. Fixing that is the signals
  work, not this change.
- `useSettings()` now returns `[settings, setSettings]` and is called exactly
  once, by the shell.
