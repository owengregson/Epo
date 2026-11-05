# 0101 — A hand-rolled typed IPC contract, not electron-trpc

Status: accepted (2026-09-02)

## Context

Thirty-five renderer→main channels were declared in four places: a dead
`IpcInvokeChannel` union in `types.ts` (zero references, already missing
`prune:pause`/`prune:resume`), the `ipcMain.handle` calls, a hand-maintained
disposer array, and `preload.ts`. `EpoBridge` restated all thirty-five
signatures by hand. The scheme had already drifted: the three `update:*`
channels were registered in `main.ts` and absent from the disposer, so the
"removes every handler" contract was false.

## Decision

`src/ipc/contract.ts` holds `CHANNELS` (bridge method → channel string) and
`IpcContract` (method → `{req, res}`). Everything else derives:
`src/ipc/register.ts` binds and disposes from `Object.keys(CHANNELS)`,
`preload.ts` generates its invoke thunks from the same map, and `EpoBridge`
extends the mapped `BridgeInvokers`. Two `Exclude<>` guards make the two tables
fail to compile if either grows a key the other lacks. A channel string now
appears exactly once in the repo.

`electron-trpc` was rejected: three dependencies (tRPC + superjson) into a
four-runtime-dependency app, a pinned tRPC major, and a subscription model that
duplicates the preload listener registry — which already solves the
exact-listener-removal problem correctly. `@electron-toolkit/typed-ipc` is the
right size but is forty lines of generics we can own.

## Consequences

- Adding a channel is one `CHANNELS` line plus one `IpcContract` line; omitting
  the handler, the fallback, or the bridge entry is a type error.
- `foundation:status` and `engine:status` both survive as aliases for one
  projection. Removing one is a renderer-visible change and is deferred.
- The `safe()` wrapper keeps a per-channel error log AND a per-channel typed
  fallback (`src/main/ipc.ts`'s `fallbacks` map). It never collapses to `null` —
  the renderer always receives the shape its contract promises.
- Error logs lost their bespoke per-handler context fields; the wrapper logs the
  channel plus the call's scalar arguments (target, username, queue state),
  which covers what the old messages carried.
