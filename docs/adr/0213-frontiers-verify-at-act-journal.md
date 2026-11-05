# 0213 — Frontiers, verify-at-act, and a per-account journal

Status: accepted (plan-derived overhaul, reopen stream with the unfollow-decisions stream); numbers and
cross-links checked at integration. Supersedes ADR 0212's "Knowledge on return".

## Context

A return to Epo re-read the world before deciding anything. A return supervisor kept a phase in
`lifecycle_state` (reconcile → probation → ready); a reconcile pass re-read managed relationships in
batches and halted after repeated failures; a timezone or DST change, or history from before the
journal, forced a full census and a fresh probation. Live, an overnight session park counted as an
absence, so every resume re-ran the return check; a census per return spent the day's profile
allowance before the first follow; one unreadable managed record wedged reconciliation; the
pending-requests drawer re-opened every few seconds. Nothing in that model knew what had changed since
Epo last looked, so it re-read everything.

## Decision

**Read only what changed, from persisted frontiers.** `meta.reopen_state` holds one frontier per
source, written by one writer, the `FrontierSweep`, each frontier persisted only after its step's facts
commit (a crash re-reads at most one step's span):

- **H** the own header (`own_counts`): the landing's observation at launch, else one own-profile visit.
- **N** the notifications drawer since a server-time watermark (`atMs`, the keys at it, `readAt`): every
  body is classified as it parses and every fresh event is written at once (facts stream); the drawer
  scrolls only while the watermark is unreached, and an unreached one records a gap. A failure ends N
  only: the watermark stays, `readAt` is stamped, and the next planned check retries — never a loop.
- **R** incoming requests: the drawer's sibling rows open `requests` edges; only a complete panel ends
  one; the panel opens only to accept within the plan's allowance or for one verification read per
  plan-day, never at launch.
- **L** the followers head down to the frontier run (`frontierRun()` = 2 pre-frontier rows), at most
  `FRONTIER_PAGES_MAX` pages; one page initializes the frontier on the upgrade launch; rows above the
  frontier are narrowed by list position only when the order self-check says newest-first. A head walk
  never removes an edge, and a walk that read no page sets no frontier.
- **G** the following check: the ordered whole-list response plus the plain end probe, in session mode
  only, at most once per plan-day, when the following residual is non-zero. Only a verified-complete
  read yields verdicts: a managed record the owner unfollowed becomes `external`; new follows are
  outside follows. Until G runs, the People lanes mark outside changes "not yet verified".
- **J** the journal (`effect_intents`) and **T** the managed timers, store-only: `advanceTimers` runs at
  graph build and on every tick.

**One sweep, three modes.** Steps run in a fixed order (profile → notifications → followers head →
following → consistency), each decided by a pure `decideStep` from the facts the earlier ones wrote.
`stale(t)` (unset, in the future past the clock tolerance, or older than the check spacing) is the one
threshold. **Launch** (startup step 3, after the reveal, under the startup lease, passive): the header,
one drawer pass with no panel, the head walk; never step G. **Session**: the first sweep of an open plan
session. **Check**: later sweeps at the plan's check spacing, anchored on the last sweep's end.
**Light** (Boost on): the head walk and G are deferred. The launch catch-up admits on identity,
connectivity, the sentinel, the recovery ladder and the persisted block; an operational block
(`chain-exhausted`, `seed-unresolved`) does not stop it (reads are not account activity, ADR 0210).

**Verify at the act.** Every unfollow decision is verified once, by the click-time visit; there are
no pre-reads, batches or reconcile phase, and absence verdicts wait for a complete census (PRINCIPLES
§1). **A per-account journal** replaces the global block: a write to an account with an unsettled intent
is refused with the typed reason `journal`; unrelated accounts proceed. Unreachable or unreadable
records park on plan-derived schedules and end in honest terminals.

**Probation derives from the plan** (`probationOwed` over the ledger and plan-day windows), so the return
supervisor, its presence holds, `REENTRY_POLICY` and the timezone comparison are deleted. The legacy
`lifecycle_state` is read once, at the first build without a reopen state, to seed the last sweep's end
(with the v1 sweep stamp the settings migration carried), then cleared.

## Consequences

- A launch costs the landing, one drawer pass and zero to a few head pages (exactly one on the upgrade
  launch); a DST or timezone change costs zero reads; Epo's own holds are never an absence.
- The status carries the catch-up (`catchUp`), the own counts with the outside-change marker, today's
  placed tallies, the journal and the requests; each sweep's `AwaySummary` is persisted and the launch's
  is the feed's caught-up row.
- A drawer, head or following failure ends that step only; nothing absence-related gates growth.

## Alternatives rejected

- Freshness pre-reads of managed records before deciding: they spend the profile allowance on records
  the click verifies anyway.
- A census per return: the cost that stalled growth; absence waits for the plan's census slot.
- Treating a session park as absence and keeping presence holds: time the engine chose to wait is not
  time away; with no return phase there is nothing to hold.
- A stored anchor list for the followers head: a re-follower at the top would fake the frontier; the run
  of known followers needs no list.


## Read allowances and entry spacing

The draw's head allowance uses identified gains plus the positive follower-header residual since
its last head frontier (or complete census). Missing evidence contributes zero, reserving the two
pages a frontier run can straddle; the hard frontier maximum still bounds large hints. The measured
head page size takes precedence over the last complete census's page-size measurement, then the
kernel fallback. Census admission fits both lists in the current session before either walk begins.

The drawer shares the Reader's observed-response memo with every other consumer. Sweep header
visits retain their `catch-up` or `check` debit use. The dialog fallback shares the graph's activity
clock, and boot landing/identity confirmation record their ends there so the first catch-up read
waits from the completed landing. No additional pre-reveal navigation is introduced.
