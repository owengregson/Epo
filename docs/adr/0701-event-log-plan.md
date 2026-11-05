# 0701 — Make the event log real, narrowly, with a checkpoint (wave B plan)

Status: proposed (2026-09-02) — wave A ships the vocabulary and the fold; the
table, the backfill and the rebuild land in wave B

## Context

Epo calls itself "a local event-sourced knowledge graph". Four tables are that
idea, and only two of them are believed:

- `action_ledger` and `prune_ledger` are real append-only logs with a real
  reader (the rate governor).
- `observations` and `username_history` are append-only logs with **no** reader
  at all. Both are written on the streaming hot path, retention-pruned at 90
  days, and replayed by nothing.

Meanwhile the merge rules that matter are hand-inlined into SQL, where no type
and no test can see them: `COALESCE(excluded.score, follow_records.score)` and
the two stamp defenses beside it, `MIN(edges.first_seen_at, excluded.…)`, and
the enrichment heal in the `accounts` `ON CONFLICT` tail. Each one is a fold
written in a place folds cannot be tested.

`projectAccount` is the exception — a real pure fold, and the best code in the
store — and its own docstring names its weakness: identity fields have no
persisted per-field provenance, so their merge is newest-wins. A `search` read
(confidence 40) overwrites a `profile` username (confidence 90) purely by
arriving later.

## Decision (wave A: what already landed)

- `src/store/events.ts` — the envelope (`seq`, `at`, `source`, `v`) and
  `AccountObserved`. **Confidence is not stored**: it is
  `SOURCE_CONFIDENCE[source]`, a pure function of provenance. Persisting it, as
  `observations.confidence` does, is a second source of truth for a derived
  number. `accountObserved(obs)` lifts today's `Observation` — the backfill seam.
- `src/store/folds/account.ts` — `Provenanced<T>`, per-field provenance, and
  ONE merge rule for every field: a strictly better source wins; otherwise
  newer-and-not-worse wins; otherwise nothing moves. `ratio` and `enrichment`
  are not stored at all.
- Property tests (fast-check) over generated streams: **incremental fold ===
  batch fold** at any split point (the append path and the rebuild path must
  agree, or the log is a lie); confidence never decreases; every field is dated
  by an event that actually carried it; equal-confidence events at distinct
  times are order-independent; `merge` is idempotent.

Nothing above is on the write path. `projectAccount` still drives `accounts`.

### The three measured divergences from `projectAccount`

A property test pins their AGREEMENT on the overlapping contract — observations
arriving in order and never weakening — and three example tests pin each
divergence, so wave B's shadow diff has an expected list rather than a surprise:

1. **The newest-wins hole, fixed.** A later `search` username no longer
   overwrites a `profile` one.
2. **Shared stats provenance, split.** `followers`/`following`/`mutuals`/
   `activitySignal` share one `stats_observed_at`/`stats_source` pair today, so
   a high-confidence read of one field freezes the others against legitimately
   newer equal-confidence reads of their own.
3. **No stored derived values.** `ratio` and `enrichment` are absent from the
   fold; they become a generated column and a read-time function.

Divergences 1 and 2 change stored values. Both are corrections, and both must
appear in the wave-B shadow diff — a diff of zero there would mean the fold was
not actually applied.

## Plan (wave B)

**Migration 13 — `events` + backfill.** One appended entry, forward-only:

1. `CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT
   NULL, kind TEXT NOT NULL, source TEXT NOT NULL, v INTEGER NOT NULL, payload
   TEXT NOT NULL)`, plus `idx(kind, at)` and `idx(at)`. Generated with
   `ddl(EVENTS)` per ADR 0703.
2. **Lift the real logs**: `observations` → `AccountObserved` (`confidence`
   dropped — it is derivable); `action_ledger` → `ActionSettled{actor:'growth'}`;
   `prune_ledger` → `ActionSettled{actor:'prune'}`.
3. **Mint genesis events from current projections** for everything with no log:
   one `AccountSnapshotted` per `accounts` row dated `first_seen_at`, one
   `EdgeSnapshotted` per `edges` row (plus a retraction at `last_confirmed_at`
   when `status='removed'`), one `RecordSnapshotted` per `follow_records` row,
   one `TargetSnapshotted` per target — all `source: 'backfill'`. Genesis events
   are a legitimate kind, not a hack: they are "what we knew at the checkpoint",
   and they are exactly what makes a rebuild reproduce today's tables on day one.
4. `checkpoint_seq` in `meta` = the last genesis seq. Rebuild replays from there.
5. `username_history` stops being a write-only log and becomes a PROJECTION
   folded from `AccountObserved`, so it is rebuildable and its retention sweep
   becomes unnecessary.

**Append path.** `execute(cmd)` → deciders return events → one transaction
appends each event and applies `SINKS[kind]` to the projection tables → one
change signal. PRINCIPLES §1 restates as *an event is appended the moment its
fact is parsed*: "per-row write" and "per-row append" become the same act.

**Rebuild path.** `rebuildProjections({ into: 'shadow' })` restores the
checkpoint and replays the tail through **the same** `SINKS[kind].apply`. Two
code paths producing one table is the classic event-sourcing failure; the
mitigation is structural (one apply function) plus the fast-check
incremental-equals-batch property as a merge gate.

**No dual write.** Dual-write is for systems with two writers; this app has one
process and one store. The first open after migration 13 runs the shadow
rebuild ONCE and logs a discrepancy report against the live tables. Green on
first launch (modulo the three known divergences) is the proof, and it costs
one launch.

**Retention becomes derived, not a magic 90 days:**
`LOG_RETENTION_MS = 3 × (followbackWaitMs + holdMs)` — ~24 days on balanced
defaults, and it MOVES when the user moves the knob, which the current constant
does not.

## What this deletes

`observations.confidence`; `accounts.ratio` and `accounts.enrichment` as stored
columns; `prune_ledger` as a second table (one `ActionSettled` stream with an
`actor` dimension); `follow_records.abandoned_at` / `healed_at` (folds over the
record's own transition stream, not columns defended by `COALESCE`); the
`{ authoritative?: boolean }` flag (replaced by a `VerifiedWalk` token the
walker mints only at a verified end of list).

## Alternatives rejected

- **Drop the log.** Delete `observations` and `username_history`, keep the two
  ledgers, stop calling the app event-sourced. Rejected because three things
  the app already wants are log queries and nothing else: the recovery incident
  window (a JSON blob in `meta` plus a `COALESCE` over the action ledger today),
  follow-back latency (two stamps on a row), and per-target attribution over
  time. Each is re-derived by hand today.
- **Keep every event forever.** Retention and rebuildability are reconciled by
  the checkpoint, not by unbounded growth.
- **Per-aggregate streams.** One global log with `(kind, at)` indexed is
  simpler and this app's aggregates are small. Revisit past ~5M rows.

## Open questions

1. Is `EdgeRetracted` per-pk or per-census? Per-pk keeps the fold trivial and
   lets facts stream, but a census that loses 800 followers appends 800 events.
2. Should `recovery_state` / `pacing_state` become events? They are durable JSON
   with correct semantics today, and they are the most safety-critical machine
   in the app. Leave as meta in pass one.
3. Checkpoint frequency: "the projection tables ARE the checkpoint" is cheapest,
   but a rebuild after a corrupt projection can then only replay the retained
   tail. A weekly `VACUUM INTO` snapshot would allow a true from-zero rebuild.
4. Write amplification: a 5,000-row walk does 2 writes/row today and would do
   2–3. Must be benchmarked with `synchronous = FULL` intact — that setting is
   the expensive part and it is load-bearing for crash durability.
