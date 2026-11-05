# 0604 — Parse, don't validate: `zod@4` at the untrusted boundaries

**Status:** accepted · **Area:** kernel (`src/kernel/parse.ts`); adapter, store
and IPC boundaries in wave B

## Context

Epo has four untrusted boundaries — Instagram response bodies, the settings
file, SQLite rows, and IPC payloads — and three of them currently **cast**.
`asFetchEnvelope` (`src/adapter/ig-surface.ts`) checks three fields and then does
`return value as unknown as FetchEnvelope`: `json`, `textHead` and `finalUrl` are
never checked and flow onward as trusted. That is a cast wearing a guard's
uniform.

ADR 0303 protects the distinction that matters most here — an extractor that
cannot recognise a body returns `SHAPE_MISMATCH`, never the typed empty value,
because an empty followers page IS end-of-list and end-of-list originates
absence verdicts ("this follower is gone", "unfollow this account"). The
mechanism enforcing it is a hand-written guard per endpoint per version module:
roughly ten early returns each, where one missed branch fabricates an empty
list. And `SHAPE_MISMATCH` is `Symbol('shape-mismatch')` — zero payload, so a
drifted body tells you nothing about *which* path moved.

## Decision

Parse at the boundary with **zod 4.5.4**, through one kernel helper:

```ts
type Parsed<T> = { ok: true; value: T }
               | { ok: false; drift: { at: string; expected: string; got: string } };
parseWith(schema, label)(body)   // never throws
```

Three structural consequences, none of which is a convention:

1. **There is no third case.** A schema has exactly two exits. The ten hand-
   written early returns per extractor collapse into a shape declaration.
2. **Empty is a value; drift is not.** `z.array(user)` accepts `[]` and rejects
   `{}`. ADR 0303's distinction becomes the parser's *definition* rather than a
   reviewer's vigilance — and `SHAPE_MISMATCH` keeps its meaning while gaining
   evidence.
3. **Drift is diagnosable.** `drift.at` is the exact JSON path
   (`followersList.users[1].pk`), which is what gets written into
   `src/adapter/versions/<new-date>.ts` and into the HANDOFF entry.

`parseWith` **never throws** — not on a malformed body, not on a schema whose own
refinement blows up (that becomes drift too, with the thrown message as `got`).
That is a property, tested with `fc.anything()`, not a promise.

`got` renders the value actually found at the drift path, typed and truncated to
60 characters, so a log line never carries a whole response body.

## NOT for Settings

ADR 0103's reasoning holds verbatim and is preserved: settings semantics are
**coercion to the nearest safe value**, never rejection (`jitterPercent: 100 →
90`), and `z.infer` erases the per-knob JSDoc the Settings view renders. The
`RULES` clamp table stays. Coercion is not validation.

## Rejected alternatives

| Candidate | Reason |
|---|---|
| **valibot 1.4.2** | Smallest bundle and genuinely good; its modular `v.pipe(v.object(…))` API reads worse for deeply-nested IG bodies and its error-formatting ecosystem is thinner. Revisit only if the renderer needs schemas in a hot path. |
| **arktype 2.2.3** | Parses a string DSL *in the type system*. On 39k lines that is the riskiest single addition to `tsc --noEmit`, which is one of the four gates — and it pulls three `@ark/*` packages into a 3-runtime-dep app. |
| **@effect/schema** | Only makes sense inside `effect`, rejected in ADR 0603. |
| **Keep the hand-written guards** | They are the status quo that shipped `asFetchEnvelope`'s cast and eight parallel `extract*` result interfaces. |

zod also `safeParse`s without throwing by construction, is Standard-Schema
compliant (so a later change of library is not blocked), and ships a `zod/mini`
export for the renderer-reachable slice if bundle size ever argues for it.
