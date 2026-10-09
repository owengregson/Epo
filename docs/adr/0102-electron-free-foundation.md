# 0102 — The composition root owns no Electron import

Status: accepted (2026-09-02)

## Context

`Foundation` imported `app` and `session` from electron for exactly two things:
`app.getPath('userData')` (the DB path, the settings path, the data wipe) and
`session.fromPartition(IG_PARTITION)` (the `ds_user_id` cookie, the logout
wipe). That was the ONLY reason six `tests/main` suites carried an identical
`jest.mock('electron', …)` block, and the reason the 400-line `build()` could
not be reached in a test without mocking a cookie read.

## Decision

`FoundationDeps` takes `userDataDir: string` and an `IgSessionPort`
(`readCookie` / `clear`). `main.ts` supplies `app.getPath('userData')` and
`electronIgSession()` (`src/main/services/ig-session.ts`, the one file that
knows the partition). The graph construction moved out whole into
`src/main/services/graph-builder.ts` as `buildGraph(ownPk, ownUsername, deps)`
with an explicit `GraphBuildDeps`; `Foundation.build()` is now a one-line call
plus the deps projection.

## Consequences

- No `tests/main` suite mocks electron. `tests/kit/main-harness.ts` builds a
  Foundation over a temp directory and a fake session in one call.
- `buildGraph` is a free function over explicit inputs, so a new rim component
  is an edit to a file nothing else in `main` touches.
- The cookie-read failure path moved into the port: an unreadable cookie returns
  `null` (a navigation blip must not flap a live graph — a real logout parks via
  the sentinel), which is the behaviour the old inline `catch` had.
- `updater.ts` stays out of everything a service or test touches: it imports
  `electron-updater` at module load. `main.ts` constructs it and passes the
  structural `UpdaterPort` into `registerEpoIpc`.
