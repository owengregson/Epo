# 1008 — Push channels are a contract too

Status: accepted (2026-09-02)

## Context

ADR 0101 fixed half the IPC boundary: the 35 renderer→main invoke channels now
derive from one `CHANNELS` map, and a channel string appears exactly once.

The five main→renderer PUSH channels were left in exactly the pre-0101
situation, declared by hand in three places:

- `preload.ts`'s `EVENT_CHANNELS` map,
- `main.ts`'s five literal `shell.send('epo:…', …)` calls (six sites —
  `update-status` twice), and
- `EpoEventPayloads` in `types.ts`.

Separately, the §2 push machinery itself was spelled out five times: three
`FoundationDeps` callbacks (`onStatus`, `onPruneStatus`, `onChainList`), one
throttle timer, and one hand-written push body. Adding a live projection meant
remembering five edits, and forgetting one produces the exact defect
PRINCIPLES §2 exists to name — a number that only moves when an operation ends.

## Decision

**One push table.** `PUSH` (channel name → `epo:*` string) and `PushContract`
(payload per channel) join `CHANNELS`/`IpcContract` in `src/ipc/contract.ts`,
with the same two `Exclude<>` drift guards. `EpoEventPayloads` and
`EpoEventChannel` in `types.ts` are now type aliases of them; preload's
`EVENT_CHANNELS` is `PUSH`; `main.ts` holds one typed
`push(channel, payload)` helper that indexes `PUSH`. A grep-based test
(`tests/main/push-channels.test.ts`) asserts each channel string occurs exactly
once across `src/**`, and that no `'epo:…'` literal exists outside the
contract at all — so a hand-declared sixth channel fails the suite.

**One projections registry.** `src/main/modules/projections.ts` holds a
`satisfies`-checked `PROJECTIONS` table, one `store.onMutation` subscription,
and one trailing throttle (`POLL.GRAPH_PUSH_THROTTLE_MS`). `FoundationDeps`
takes a single `push` seam instead of three callbacks. The registry is bound to
each built graph by the session's OPEN transition and unbound by its CLOSE
(ADR 1007), so its subscription and armed timer cannot outlive the store they
read.

`log` and `updateStatus` are deliberately not in the table: neither derives
from the knowledge graph, so neither belongs on a store-mutation push.

## Consequences

- Adding a live projection is one row in `PROJECTIONS` plus one line in
  `PUSH`/`PushContract` — the §2 affordance ("bind it to a store-derived
  projection and let the mutation push drive it") made mechanical.
- Behaviour is bit-identical: same throttle constant, same trailing (never
  leading) edge, same opening push the moment the graph exists, same guard that
  a late timer pushes nothing. `tests/main/foundation-chain-push.test.ts` and
  `foundation-chain-detail.test.ts` are the untouched oracle; the shim that
  keeps them reading per-projection lives in `tests/kit/main-harness.ts`.
- Two renderer-visible aliases survive this wave and are seams, not decisions:
  the `status`/`engineStatus` channel pair and `EpoBridge`'s
  `onPruneStatus`/`offPruneStatus` sugar. Both delete once the renderer
  migrates.
