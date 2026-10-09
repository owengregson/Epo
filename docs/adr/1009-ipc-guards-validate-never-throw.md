# 1009 — IPC guards validate shape, and never throw across the boundary

Status: accepted (2026-09-02)

## Context

The renderer is a sandboxed `WebContentsView` with `contextIsolation` on, so an
attacker-controlled payload is not a live threat today. But four channels take
a scalar straight into the store or the settings file — `restartFromSeed(seed)`,
`queueList(state)`, `chainDetail(targetPk)`, `updateSettings(partial)` — and
what actually arrives over IPC is `unknown`: the contract's types are erased at
exactly the point they would be load-bearing. `setStage` and `setTourHold`
already hand-checked their arguments inline, which is the same instinct
without a home.

## Decision

`src/ipc/guards.ts` holds a `GUARDS` table of zod schemas, one array per
guarded method, `satisfies Partial<{[M in BridgeMethod]: ArgSchemas<Req<M>>}>`
so a schema cannot describe a different type than the contract promises.
`register.ts` runs `checkArgs(method, args)` before the handler.

Two rules:

1. **Shape only, never value policy.** Clamps stay in the settings `RULES`
   table (ADR 0103), whose semantics are coercion, not validation:
   `jitterPercent: 100` must become `90`, never a rejection and never the
   default. So `updateSettings`'s schema checks "a plain object whose keys are
   declared knobs" — built from `SETTINGS_KEYS`, projected out of `RULES`, so a
   new knob is admitted by the same edit that declares it — and hands every
   value to `sanitizeSettings` untouched. `tests/settings/settings.test.ts`
   passes unmodified.
2. **Never throw across the boundary.** A refusal logs at error with the
   channel, the argument index and zod's failing path, then answers with the
   channel's OWN typed fallback — the identical exit a throwing handler takes
   (ADR 0101). The renderer always receives the shape its contract promises.

zod (already a dependency for the four untrusted boundaries in the v4 design)
lives in `guards.ts` rather than `contract.ts`, because the contract is
imported by the renderer and must stay dependency-free.

## Consequences

- Adding a guard is one table row; a channel with no row is unguarded, which is
  correct for the ~30 channels that take no arguments and is now stated rather
  than assumed.
- The known risk is over-strictness silently costing a user a saved setting.
  It is mitigated three ways: the shape check admits every out-of-range value
  (a clamp, not a rejection), a refusal is logged at error with the failing
  path rather than swallowed, and `updateSettings`'s fallback re-reads the
  current settings rather than fabricating one — a refused save leaves the file
  exactly as it was.
- `checkArgs` is pure, so `tests/main/ipc-guards.test.ts` exercises the real
  schemas with no electron mock.
