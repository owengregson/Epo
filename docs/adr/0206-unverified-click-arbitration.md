# 0206 — Arbitrating an unverified click

**Status:** accepted · **Area:** engine (`src/engine/churn-scheduler.ts`)

## Context

A follow or unfollow is only recorded once the post-state confirms it. That
verification can fail *after* the click was dispatched — the tab stalls, the
webContents goes away — leaving one genuinely ambiguous case: **the action may
have landed on Instagram, and we cannot tell.**

Both naive answers are wrong:

- Treat it as a failure and retry → a second click that un-does the first
  (follow, then unfollow) or double-writes the ledger.
- Treat it as a success → a phantom ledger row and a lifecycle transition for an
  action that may never have happened.

## Decision

The rim reports the ambiguity explicitly: `ChurnActionOutcome` carries
`unverifiedClick: true` alongside a `blocked` status (record-neutral — nothing is
retried, nothing is failed). The scheduler MARKS the record with the verb that
was dispatched.

The next attempt on that record arbitrates. The adapter's pre-check reports
`alreadyInState` when the button is already in the target state, and the marker
decides what that means:

- **Marked, same verb** → OUR click landed. Record it as ours: ledger row,
  lifecycle transition, directed edge.
- **Not marked** → an EXTERNAL actor owns the relationship. Reconcile the edge
  and back off; write NO ledger row, because the action was not ours.

A definitive `failed` outcome also clears the marker: had the click landed, this
attempt would have read `alreadyInState` instead.

## Why the marker is in memory

It lives in a `Map` on the scheduler, not in the graph. Losing it across a
relaunch degrades to the pre-existing safe behaviour — the next attempt reads
`alreadyInState`, treats it as external, and reconciles — which is never a
re-click and never a phantom ledger row. That is the cheapest correct form; a
durable field would buy attribution accuracy for a case that is already safe.

This is a deliberate exception to "facts stream to the store": the marker is not
an observed fact about Instagram, it is a note about our own in-flight attempt,
and its loss is safe by construction.

## Consequences

- No re-click, ever, on an ambiguous outcome.
- Attribution is right in the common case (same session) and safe in the rare one.
- The arbitration lives in ONE place — the shared outcome applier — so both verbs
  behave identically.
