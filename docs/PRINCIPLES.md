# Design Principles

Mandatory, cross-cutting rules for this codebase. New code MUST follow them;
reviews and refactors treat a violation as a bug even when nothing visibly
breaks. Each principle names its enforcement points so drift is findable.

## 1. Facts stream; verdicts wait for completeness

**Every fact learned from Instagram lands in the KnowledgeStore the moment it
is observed — never buffered in memory until a batch, walk, or scan finishes.**
An aborted scrape, a sentinel block mid-walk, a user Stop, or a crash must cost
only the *un-fetched* remainder, never the knowledge already paid for. If a
collection path holds observations in an array and writes them at the end, it
is wrong by design.

What streams (per row / per event, at observation time):

- Account profiles parsed from ANY list page, profile fetch, or feed entry
  (`store.observe`), including one-off reads like the seed check — a paid-for
  fetch is never discarded.
- Relationship edges: a followers-list row writes its `follows` edge
  immediately; an own-following row reconciles the we-follow edge immediately
  (`reconcileOwnFollow`, which also heals drift on sight); a notifications
  follow event writes the follows-us edge (and username) per event, at the
  event's own timestamp.
- Actions and their outcomes: every follow/unfollow/prune attempt writes its
  ledger row and record transition as it happens.

What legitimately WAITS — and the only things that may:

- **Absence-based verdicts.** "This follower is gone" / "this follow no longer
  exists" require a census that verifiably reached the end of the list
  (`ingestScanCensus` authoritative mode). Absence in a partial read is not
  evidence.
- **Candidate sets and baselines.** The prune candidate list and the followers
  baseline are conclusions about the *whole* population; both gate on the
  walk's completeness verdict.
- **Adapter action verification.** A click is only recorded once the
  post-state confirms — that is correctness gating, not batching.

Enforcement points: the rim sources' `ingestRow` helpers
(`own-followers-source.ts`, `own-following-source.ts`), the
`onObservation` callbacks in `followers-page-reader.ts` /
`list-page-walker.ts` / `follower-acquisition.ts` (each row is delivered as it
parses — consumers must write it through, not collect it), the follow-back
watcher's per-event loop, and `ingestScanCensus`'s doc contract. Tests assert
that a stopped/truncated walk still leaves its observed rows and edges in the
store.

Corollary for new collection paths: accept a per-item callback (or write
through to the store directly per item); return arrays only for completeness
verdicts, counts, and absence analysis — never as the sole carrier of facts.

## 2. The UI mirrors the graph, live

**Everything the renderer shows derives from the current state of the
knowledge graph and updates while operations are still running — never "when
the action ends".** Because facts stream into the store per row (§1), the UI
gets its liveness from ONE mechanism, not per-feature plumbing:

- `KnowledgeStore.onMutation` fires after every write; the Foundation
  coalesces bursts through a trailing throttle
  (`POLL.GRAPH_PUSH_THROTTLE_MS`) and pushes BOTH status projections
  (growth `EpoStatus`, `PruneStatus`) fresh from the store.
- Projections carry graph-derived numbers, not operation-scoped ones where a
  live number exists: e.g. `PruneStatus.graph`
  (`store.relationshipCounts()`) makes "not following back" tick during the
  scan walk; queue counts, net-today, and the list hooks (keyed on counts)
  ride the same pushes.

What may still change only at operation end: values that ARE completion
verdicts (§1) — the settled candidate count, `scanReady`, `lastRunAt`. The
display may prefer the verdict once it exists, but must show the live graph
number while the operation runs.

Rule for new UI data: bind it to a store-derived projection field and let the
mutation push drive it. If a component would need to "wait for X to finish"
to show a number the graph already holds, that is a §2 violation.

## 3. Schedules are durable — overdue work runs first

**Anything that runs on a configured cadence records its last-run time
DURABLY, and on startup an overdue schedule runs before new work — the app
being closed must never silently skip a cycle.** In-memory timers alone are a
§3 violation for any configured cadence.

How it is implemented:

- Cadences go through `ScheduleManager.cadence()` with `getLastRunAt` /
  `setLastRunAt` backed by persisted Settings (follow-back check →
  `sweepLastRunAt`; scheduled prune → `pruneLastRunAt`). `isDue` reads the
  persisted value, so a restart changes nothing: elapsed is elapsed.
- Startup evaluation is immediate: watcher loops register with
  `immediate: true` (the scheduled-prune watcher fires its due-check at
  launch, still behind the safety gates), and the engine's step order puts
  the follow-back cadence check BEFORE candidate refill and actions — an
  overdue check is the first thing a freshly started engine does.
- Interrupted work resumes, not restarts: the inter-action delay deadline
  persists (`action_delay_deadline_at`) and is served on relaunch; churn
  timers catch up at graph build (`advanceTimers`); a stopped/truncated
  prune run hands its unvisited remainder back as the runnable set, durable
  in the scan snapshot.

Rule for new scheduled work: persist its last-run timestamp through Settings
or store meta, gate on `isDue` against that persisted value, and make the
first evaluation happen at startup — never "one interval from now".
