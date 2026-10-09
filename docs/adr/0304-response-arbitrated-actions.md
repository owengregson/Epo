# 0304 — The mutation response arbitrates a follow/unfollow, not the DOM

**Status:** accepted · **Area:** adapter (`src/adapter/mutation-watch.ts`,
`ig-surface.ts`, `actor.ts`, `errors.ts`)

## Context

Instagram's web client flips the header action button **optimistically** the
moment it is pressed, and snaps it back when the server refuses. A throttled
follow shows no page-level error at all — no dialog, no interstitial, nothing
the Sentinel's text probe can see. The button just returns to "Follow".

So DOM-only verification has two failure modes, and both are silent:

- the poll catches the optimistic flip and reports a **phantom success** — a
  ledger row, a state transition and a graph edge for a follow that never
  landed;
- the poll catches the snap-back and reports an **anonymous failure** — the
  record burns a retry, and the engine keeps hammering a rate wall it cannot
  see, because the failures look like ordinary ones.

## Decision

The mutation's own HTTP status and body are the arbiter. `MutationWatch` is
armed **before** the click (the response can land in the same tick as the
optimistic flip), recognises the request through the surface
(`matchMutation` — URL for the REST forms, the friendly-name header for
GraphQL), reads the body once it arrives, and classifies it:

| classification | meaning | Actor's response |
|---|---|---|
| `ok` | 2xx with an ok verdict | success; the DOM is read once more as a log echo only |
| `rate-limited` | `feedback_required`, "Try Again Later", the spam flag, 429/5xx | `ActionRateLimitedError` — record untouched, the ladder is entered on the FIRST one |
| `auth` | checkpoint / login wall | `ActionBlockedError` — the session is the problem |
| `refused` | an ordinary refusal (unknown message, 404) | a real failed attempt for this account |
| `drift-suspect` | contradictory or unreadable | fall back to the DOM verification |

`null` — no response inside the window — also falls back to the DOM path, so a
tab without the seam (a plain test fake) behaves exactly as before.

## Why `ActionRateLimitedError` is distinct from `ActionBlockedError`

Both leave the record untouched, but they mean different things to the recovery
ladder. `ActionBlockedError` is an on-screen interstitial the Sentinel can also
name; `ActionRateLimitedError` is Instagram's SERVER saying no, which is
**definitive** — the ladder enters on the first occurrence instead of proving a
streak against the wall, because every further attempt deepens the block.

## Constraints this leaves in place

- Version-agnostic: request matching, verdict extraction and the refusal
  signatures all come from `SURFACE`; only the HTTP status families are read in
  `ig-surface.ts`.
- `TabResponse` carries `method` and `requestHeaders` from
  `Network.requestWillBeSent` — a GraphQL mutation is opaque by URL and is told
  apart from a query only by its friendly-name header, and a GET against a
  mutation path is never the client's mutation.
- An unreadable body still classifies by status, never by a fabricated verdict.
