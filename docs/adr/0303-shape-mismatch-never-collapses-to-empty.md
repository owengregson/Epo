# 0303 — `SHAPE_MISMATCH` never collapses to the empty result

**Status:** accepted · **Area:** adapter/rim (`src/adapter/parse-helpers.ts`,
`reader.ts`, `versions/*`, `list-page-walker.ts`, `followers-page-reader.ts`)

## Context

Every extractor answers a question whose "nothing here" answer looks exactly
like its "I could not read this" answer:

| endpoint | typed empty result | what drift also produces |
|---|---|---|
| followers page | `{observations: [], hasMore: false}` | an unparsed page |
| `friendships/show` | all-false relationship | an error body `{"status":"fail"}` |
| `web_profile_info` | `null` (profile gone) | a soft-block body |
| activity feed | `[]` (no recent follows) | a reshaped inbox |

The empty shapes are load-bearing: an empty followers page is **end of list**,
which the prune scan turns into "this follower is gone" and "unfollow this
account". A drifted page parsed leniently would originate or confirm an
end-of-list claim and hand absence-based verdicts a fabricated end.

## Decision

An extractor that cannot recognise a body returns `SHAPE_MISMATCH` — a distinct
sentinel, never the typed empty value, never a throw. Consumers must handle it
explicitly:

- `Reader.parse*Strict` returns `null` for a mismatch; the walkers end the walk
  `reason: 'shape-mismatch'` with `complete`/`endConfirmed` **false**, and a
  pending end-of-list claim dies unverified with it.
- A shape mismatch does NOT fall back to the dialog scrape: the dialog path
  parses through the same drifted extractor, so the fallback would burn a whole
  scrape to fabricate a second empty read.
- `extractProfileInfo` distinguishes the two: a body whose `data` container
  exists with an empty user is Instagram saying the profile is gone (`null`);
  anything else is `SHAPE_MISMATCH`.
- `extractFriendshipShow` guards on the EXPECTED KEYS, not merely "is it an
  object" — otherwise `{"status":"fail"}` parses cleanly to all-false, a FALSE
  "we do not follow them" fact that flows into the reconciler and terminates
  held records.

## The general rule

**Ambiguity resolves toward "I don't know", never toward a fact.** The same
instinct runs through the classifiers: `classifyEnvelope` and
`classifyMutationResponse` default an unrecognised refusal to `rate-limited`,
because waiting out a wall is cheap and reversible while declaring drift — or
fabricating an empty fact — is neither. The one exception is a 2xx with an
unreadable body, which is `drift-suspect`: an unreadable success is never
claimed as a success.
