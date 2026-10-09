# 0803 — One action pipeline, and the Verdict carries its own record effect

**Status:** accepted · **Area:** adapter (`src/adapter/verdict.ts`, `arbiter.ts`,
`response-watch.ts`, `action-result.ts`, `actor.ts`)

## Context

"A blocked or throttled action leaves the follow record EXACTLY as it was" is the
invariant that keeps a rate wall from burning through the candidate pool. Today it is
maintained by convention across four files: the Actor throws
`ActionRateLimitedError` / `ActionBlockedError`, `churn-actions.ts` maps those onto
`ChurnActionOutcome`'s optional cause flags, `applyOutcome` re-derives from those
flags whether the record may be touched, and the recovery ladder reads them again.
Nothing checks that the four agree.

Worse, the arbitration itself existed **twice**. `followDriven` and `unfollowDriven`
each contained the same sequence — await the mutation watch, switch on the
classification, fall back to the DOM, probe for a block, decide — with small
differences in wording and ordering. Two copies of a decision that must never diverge.

`MutationWatch` was also specialised to `follow | unfollow`, so the notifications
drawer and the follow-requests panel had no way to arm the response they expect: they
click and then poll for a body that may already have arrived.

## Decision

**`Verdict` is a value that carries its own record effect.**

```
landed    → commit           the ledger row and the transition
noop      → reconcile        already in the target state; nothing was pressed
refused   → fail             a real per-account refusal
throttled → untouched        Instagram's server said no — DEFINITIVE
walled    → untouched        an interstitial / session wall answered
ambiguous → mark-unverified  the click was dispatched and nothing confirmed it
drift     → untouched        nothing explains what was seen
```

`VERDICT_EFFECT` is a `satisfies`-checked table, so a new verdict kind with no
declared effect is a compile error. `CommitVerdict` is the narrowed member, and the
ledger writer will take only that — a throttled verdict cannot be handed to it.

**`arbitrate()` is the single decision**, used by both follow and unfollow. The order
is unchanged and still right (ADR 0304): the mutation response first, the DOM as
fallback, a block probe when the DOM disagrees, and only then a failure. What changes
is that it happens once.

**`ResponseWatch<T>` generalises `MutationWatch`.** The pattern it encodes — arm the
expected response BEFORE the interaction that fires it, because the web client flips
the button optimistically and snaps it back when refused — is not specific to
mutations. `MutationWatch` is now a thin specialisation of it, and the drawer and
requests panel can adopt it without inventing a second mechanism.

## What this wave does NOT change

The Actor's public contract is untouched: it still returns `Result<{clicked}>` and
still throws `ActionRateLimitedError` / `ActionBlockedError`, because
`churn-actions.ts` must keep returning the `ChurnActionOutcome` the engine consumes.
The Verdict is produced first and mapped at the edge by `verdictToResult`
(`src/adapter/action-result.ts`) — one total switch, in one module, whose existence is
the seam.

**Wave-B seam:** the engine adopts the Verdict's `effect` directly;
`verdictToResult`, `ActionRateLimitedError` and `ActionBlockedError` delete together.
The existing engine tests are the safety net for that step, and it must not be done
in the same commit that rewrites them.

## Consequences

- The arbitration is unit-testable without an Actor, a tab, or an Interactor
  (`tests/adapter/arbiter.test.ts`) — including the two cases that were only ever
  reachable through the whole Actor before: an optimistic DOM flip that must NOT
  beat a `feedback_required` response, and a block interstitial in place of the
  confirm menu that must not burn a candidate.
- `Evidence` carries the press→response latency, which is what feeds
  `SurfaceMeter`'s `mutation-arrival` reservoir — the arbitration and the
  measurement read the same observation instead of timing it twice.
- `ambiguous` is declared but not yet constructed: the post-click stall stays a
  `TabUnresponsiveError` with `phase: 'post-click'` (ADR 0206) this wave.

## Alternatives rejected

- **Keep the exceptions, add a shared helper.** The duplication was the smaller
  problem; the invariant living in four files was the larger one, and a helper does
  not move it into a type.
- **Make the Actor return the Verdict now.** It would change
  `ChurnActionOutcome` in the same wave that introduces the algebra, with the engine
  tests as the only net. Sequenced deliberately.
