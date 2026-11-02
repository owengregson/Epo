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
