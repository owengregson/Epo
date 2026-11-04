# 0212 — Journal mutations and reconcile returns before resuming decisions

Status: accepted

A timer expiring proves that an obligation is due for review. It does not prove
that a person failed to follow back. A click being dispatched does not prove
that Instagram accepted it. Both distinctions must survive process loss.

## Mutation ownership

Every growth, prune, manual, and incoming-request mutation has a durable intent.
The intent records the immutable account ID, username, verb, channel and creation
time before navigation. Immediately before native input, the adapter checks the
current account, expected profile/settled request row, cancellation and shared
admission policy, then marks dispatch durably. A failure after dispatch is
uncertain. It cannot consume a retry and silently replay the same write.

Verified settlement updates the intent, action ledger, relationship observation
and managed follow record in one SQLite transaction. Settlement is idempotent;
observers receive the committed state. An already-established relationship is
external evidence, not a new successful action. Simulations do not consume real
mutation quota or improve source yield.

Unknown dispatched actions reserve quota. Recovery visits the expected account
and observes its present state without replaying the click or inventing a
historical ownership timestamp. Observed external state can settle uncertainty,
but cannot be credited as a verified new mutation. Authentication changes or
ambiguous identity stop admission. All writers share the account's daily/hourly
counts and durable inter-action deadline. A woven-prune server refusal enters
the same account-wide recovery ladder as a growth refusal.

## Knowledge on return

The durable reentry supervisor distinguishes a brief continuation from an
absence, legacy knowledge, uncertain effects and a clock/timezone change. A gap
longer than one hour requires relationship reconciliation. A gap beyond one day
also starts probation: ten verified actions, each separated by at least three
minutes in addition to any longer ordinary pacing. These are initial product
policies, not claims about platform limits. Missed days create no action quota.

Reconciliation first settles ambiguous effects in batches of ten. It then
checks managed obligations, including pending follows, held mutuals and queued
unfollows. A bounded activity feed provides positive historical evidence; it
cannot prove absence. Undated events record detection without fabricating an
event time or overriding a newer negative observation. A membership discovered
on return receives an observation time and a conservative hold.

Production reconciliation reads managed profiles by immutable ID in bounded
batches. Its persisted observation epoch remains stable across batches, restarts
and budget resets, so a large account need not repeatedly restart a full census.
Only explicit fresh relationship flags are evidence. The census fallback can
assert absence only after a complete walk with adequate fresh header coverage.
Partial evidence is retained without completing the success cadence or advancing
unreconciled destructive obligations. Successful partial batches and read-budget
waits are deliberate progress/deferral; repeated actual failures have a bounded,
visible terminal outcome.

Incoming requests are a narrowly scoped restorative mutation during this read
phase: a private account's follow-backs may require acceptance. They use the same
identity, journal, quota and pacing checks. Known managed requests still awaiting
acceptance defer negative reconciliation; the bot cannot expire them merely
because an allowance prevented accepting the rest of the list.

Immediately before a follow/unfollow, a fresh profile observation rechecks the
expected ID, eligibility, retained-source protection, reciprocal hold and bio
keep policy. This closes the gap between an older queue decision and dispatch.
Manual and standalone prune commands run bounded preparation under their own tab
lease; they do not need to launch growth. Stop cancels that preparation.

## Validation and limits

Fake-time integration tests cover week-long absence, partial and failed reads,
multiple reconciliation batches, read-budget deferral, clock changes, immutable
identity mismatch, interrupted dispatch, atomic settlement, and the shared
mutation paths. Process and browser recovery are specified separately in ADR
0210; source breadth and read allocation are in ADR 0211. Native local-fixture
checks validate input/render transport, not Instagram's remote behavior or
multi-day unattended reliability. The retained observation log and settled
intent history are bounded; unresolved intents and outcome evidence remain.

## Amendment — 2026-11-02: holds are presence; a return reconciles what is due

Live, a running engine did nothing for a day. The return supervisor moved
`lastActiveAt` only on progress, so the engine's own overnight session park
read as an absence. Each resume then ran a full census: every managed record
re-read by a profile visit (55), against the 80-visit rolling allowance. Two
censuses spent it, and return probation restarted at every session.

- **A hold the engine chose is presence.** Every engine wait brackets
  `holdUntil(deadline)` / `endHold(now)`. Presence extends to the deadline;
  time slept past it, a stop, or a restart mid-hold is still away (the hold is
  in-process state). "A gap longer than one hour" now means a gap in
  presence, not in progress.
- **An absence reconciles what its timers made due.** The census
  (`requireFresh`) is owed only when the timers themselves cannot be trusted:
  a clock or timezone change, or history from before the journal. A later
  absence cannot downgrade an owed census. After an absence, the watcher
  still demands fresh evidence for every obligation its timer made due
  (expired waits, expired holds, queued unfollows). Every mutation re-reads
  its profile at the click. A record inside its timers drives no decision,
  so re-reading it only spends allowance.
- **A spent allowance is a schedule, not a retry.** A budget deferral parks
  until the allowance's known reopen time, with a positive-only offset. It
  does not use the retry park's 0.5–2× noise, which stretched an 11.5 h wait
  to 19.9 h. It surfaces as `read-budget`, not as a failed follow-back read.

## Amendment — 2026-11-02: a per-account journal and a complete settlement table

Written with ADR 0213 (frontiers and verify-at-act), which supersedes "Knowledge on
return" above. Live, one unfollow stalled at its confirm dialog. Its intent became
uncertain, and the global block then refused every write on every account. The
reconciliation that would settle it read whole batches, and an unreadable account
in a batch halted the engine after five failures. When it did settle, a stranded
unfollow (still following) was marked terminal `external`, so Epo never unfollowed
that account (U06 F6).

- **The gate is per account.** `journalBlocks(pk)` holds while an intent for that
  account is `dispatched` or `uncertain`, the caller's own intent excepted. It is
  checked at selection (the churn and the woven feed pass the account over, so
  nothing waits behind it), at the click before any read (a typed `journal`
  deferral), and on standalone writes (a typed `journal` refusal for that account
  only). The global block and the return's reconcile phase no longer gate
  admission. Unknown dispatched writes still reserve quota.
- **One intent per step, no batch, no halt.** The `journal` rule runs after the
  safety prefix and pacing. Each step settles the oldest due intent with one read
  of its account (`journalDue`: open, and any park served). The runner, its
  batches and the `reconciliation-failed` halt are gone. An incomplete follow-back
  read ends its sweep, and growth goes on.
- **The settlement table is complete (`settlementFor`, pure).** A follow seen
  following or requested settles `external`, and its record waits for a follow-back
  from its dispatch (no longer leaked as `external`). A follow seen neither is
  `cancelled` and spends one retry. **F6:** an unfollow seen following or requested
  is `cancelled`, and its record stays `unfollow_queued`. An unfollow seen neither
  is `external`, and the record is `unfollowed`. An accept seen followed settles
  `external` and closes the request; otherwise it is `cancelled`; channel evidence
  settles it with zero reads.
- **Unavailable accounts park on the plan and end honestly.** A gone or renamed
  page parks the intent and its record to the next plan-day. The second sighting
  expires the intent (`expired`, a new result that keeps its dispatch-day quota)
  and closes the record as `external`. An unreadable page parks to the next session,
  then to later plan-days. Past the retry limit it expires, and the record is
  `abandoned`, which the recovery healer can requeue. A wall counts no attempt and
  goes to the recovery ladder. A refused read waits for the allowance. `prepared`
  intents left by an earlier run are cancelled at graph open, with no read.

## Amendment — 2026-11-02: "Knowledge on return" is superseded by frontiers (ADR 0213)

The return supervisor and its phases are deleted: what changed since Epo last looked is read from
persisted frontiers by one sweep (the header, the drawer since its watermark, the followers head to its
frontier, the following check), every unfollow decision is verified once at the click, and probation
derives from the ledger and the plan-day windows. Requests are a live predicate: an open request keeps a
record out of every timer and pick, and only a complete requests panel ends one. Where "Knowledge on
return" says "the bot cannot expire them", read "Epo does not expire them"; the section stays for history.
