# 0704 — Follower change log and own counts

Status: accepted (plan-derived overhaul, reopen stream); numbers and cross-links checked at integration

## Context

Follower growth was read straight off the `edges` table: a gain was an own-follower edge's
`first_seen_at`, a loss a removed edge's `last_confirmed_at`, both counted strictly after the followers
baseline. That model loses history and misdates it. A re-follow overwrites nothing visible (the edge
keeps its first sighting), so a past loss vanishes from the chart. A follower found by a list walk is
dated by the walk, not by when they followed. An edge first observed as removed still counted a loss.
Instagram's own header count, the only exact magnitude Epo sees, was kept as the latest value on the
account row and discarded at the next read, so nothing could say how much of a count change Epo had
not identified, or on which day it happened.

## Decision

Two append-only tables (migration 15) and one pure fold (`src/store/folds/growth.ts`):

- `own_counts (at, followers, following)` keeps **every** own-header observation, written inside the
  same `observe` write as the account projection (facts stream, PRINCIPLES §1).
- `follower_changes (account_pk, delta, lo, hi, source, found_at)` keeps one row per **transition** of an
  own-follower edge: `+1` none/removed → active, `−1` active → removed, dated by the interval `[lo, hi]`
  the change is known to fall in. The row is written in the edge's own write by the relationship repo's
  transition hook; an edge that was never active writes nothing. Dating: a notifications event or an
  accepted request is exact (`lo = hi`); any other gain runs from the last complete census (else the
  baseline), or from a recorded loss for a re-follow; a loss runs from the last time the edge was seen
  active. A late dated event narrows the gain that already counts the follower; narrowing only tightens.
  Nothing at or before the baseline is written (stock), and the first census's own walk rows are stock.
- Header windows `(t_{i−1}, t_i]` are linked into **components** by changes that span several windows;
  a component's **residual** is its header delta minus the changes that end inside it, computed at read
  time, never stored, so a later identification shrinks it. A change ending after the newest header
  holds its component open until the next one.
- **Placement** on a plan-day `[S, E)` (the window always passed in from the `PlanDayClock`): a change
  with `S ≤ lo ∧ hi < E`, a component with `S ≤ from ∧ to < E`. Everything else is unplaced and shown
  once, under "While you were away". Law L3: placed over every plan-day plus unplaced equals
  `F_last − F_first`, each change counted once.
- **Outside following actions** per header window: `max(0, ΔG − epoNet − resolved)`, increases only.
  Epo's follows to private accounts are outstanding requests (they do not move the header) until an
  unexplained increase absorbs them (an acceptance) or Epo withdraws one; a decrease is never charged.
  It feeds the ceiling only, never the kind budgets.
- **Backfill identity** (law L8): the first build after the migration turns the legacy edges into point
  rows (`+1` at first seen, `−1` at removal, after the baseline, source `migrated`) and seeds
  `own_counts` from the own account row, once (`meta.follower_changes_backfilled_at`). Every growth
  read over the migrated log equals the old edge queries on every window, so no chart moves at upgrade.

The store never computes a day: plan-day windows and day lists are method arguments, and kernel
bounds arrive through `StorePolicy` (spec §14 C24).

## Consequences

- "Net today" is the placed figure for today's plan-day, dated by event time; a change from while Epo
  was closed that no single day holds is reported once, not smeared onto the day it was found.
- The legacy edge reads stay for the current UI until the sidebar and the People page read the log.
- `outsideSince` folds the retained ledgers per call; it is memoized until the next store write.
- The frontier sweep (ADR 0213) writes the dated rows: a drawer event is exact; a followers-head row is
  interval-dated from the frontier and narrowed by list position only after the order self-check; a
  head walk never writes a loss. Its `AwaySummary` is a window read over this log.
- The first complete following check establishes stock: it charges none of the preexisting list
  as new actions and preserves earlier header estimates. Later complete checks replace the header
  estimate only after that baseline, through their checked time. New outside
  follows lack event dates, so their ceiling charge belongs to the plan-day in which the complete
  check observes them. This is a conservative admission charge, not a dated growth event. The
  complete count anchors subsequent header estimates; Epo's later writes and outstanding requests
  are still subtracted. Landed ledger and settled manual-intent follows count as Epo actions even
  without a managed follow record; an old follow followed by a verified removal cannot exempt a
  later outside refollow. Repeated checks add zero for edges already observed.
- `meta.outside_following` retains per-pk discoveries through an interrupted read, then atomically
  records the complete check and clears its pending set. `reopen_state.following.added` records that
  check's additions. Checks persist through the store retention horizon; a restart does not charge
  the same discovery twice.

## Alternatives rejected

- A stored running residual: it would go stale the moment a later read identifies a change.
- Dating by the moment Epo learned of a change: it is the misdating this replaces.
- A union parse of old and new growth shapes: one backfill, one model.
