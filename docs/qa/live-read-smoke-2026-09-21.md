# Live Instagram read smoke test — 2026-09-21

Source: user-supplied stdout from `npm run livetest`, reviewed on 2026-09-21.
The output reports a completed build, dry-run mode, no follow-test target,
`acquireMaxRounds: 1`, and `enrichCap: 1`. It does not include a source or bundle
hash. Account identifiers, sample usernames and pagination tokens are omitted
from this report.

| Step | Result | Evidence in the supplied output |
| --- | --- | --- |
| Identity | PASS | Resolved from the navigation profile link |
| Acquisition | PASS | 274 observations across 11 direct API pages; no duplicates reported |
| Enrichment | PASS | One profile requested and enriched with follower/following counts |
| Score and plan | PASS | One eligible candidate queued from the observed pool |
| Follow | SKIP | No follow-test target configured |
| Follow-back check | SKIP | No follow-test target configured |
| Unfollow | SKIP | No follow-test target configured |
| Sentinel | PASS | Final status `ok` |

Reported verdict: **ALL PASS — five passed, three skipped; zero real follow or
unfollow actions**. This supplies the live read-path evidence missing from the
earlier implementation report. It does not validate follow/unfollow behavior,
native pointer gestures, background operation on Instagram, or long-term
account availability. Acquisition ended at its demand target with an explicit
partial-list result; the 274 observations are not a complete follower census.

## Test-limit defect found and repaired

The log exposed a harness configuration mismatch. `EPO_TEST_ACQUIRE_ROUNDS=1`
limited the dialog fallback but left the direct API path at the production
default of 12 pages and 250 newly observed accounts. The run therefore read
11 pages before crossing the demand target. It did not honor the intended
one-page smoke-test scope.

The live harness now passes the requested round bound as `maxPages` as well as
`maxRounds`, and logs both limits. Production acquisition defaults are
unchanged. `tests/livetest/acquisition-budget.test.ts` builds the real harness
graph against a fake page transport, then verifies one fetched page, immediate
observation/edge persistence, the retained resume cursor, and `page-budget`
instead of a false completed-list claim. The regression passes. This repair
was verified locally without issuing another live Instagram request.

Final `npm run check` passed all gates, including **170 test suites / 1,849
tests**, type checking, lint, dependency boundaries, generated-file freshness
and the development build. One suite and two tests remain skipped.
