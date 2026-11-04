# 0807 — Probe transport evidence survives page teardown

**Status:** accepted · **Area:** probe only (`src/probe/`)

## Problem

The November 4 L1 follow-up stopped when CDP could no longer retrieve an auxiliary request's
POST data or response body. A second request had no recorded response or terminal event.
Treating those observations as server failures confuses the page debugger's lifetime with the
request's lifetime. Treating them as successes would conceal missing evidence.

Isolated Electron experiments reproduced both alternatives: a held fetch emitted only CDP's
request-start event across navigation, while the session observer recorded an explicit abort;
a keepalive request with the same incomplete CDP history completed with HTTP 200. Unload requests
could be absent from CDP entirely. Durable CDP storage retained a completed response in a separate
process-change experiment, but did not restore these missing unload events. Request ownership
was present at the native start and absent at later native events. These are local reproductions;
they do not retroactively establish the causes of the earlier live failures.

## Decision

The verify probe records two independent streams from its single tab:

- Session `webRequest` events establish request ownership, upload evidence, HTTP status and
  terminal completion/cancellation. Ownership is retained by native request ID after navigation.
  Callbacks immediately allow the original request; the observer never composes, retries or
  rewrites a request. Upload reads use the existing body deadline and request-size bound.
- CDP retains request/session/frame/loader identities, event and command timing, navigation
  boundaries and decoded response bodies. Complete event-carried POST entries are used before
  looking up metadata in a renderer that may have gone away. Commands use the owning CDP session.

Each CDP request must have a unique reciprocal native match by method, exact URL, event-clock
window and matching upload hashes where both exist. The 250 ms probe-only clock tolerance is
an association bound, not an Instagram-facing wait. Concurrent identical candidates, contradictions,
unowned starts, unresolved terminals and unavailable metadata do not qualify. The probe listens
through a bounded terminal-settlement phase before removing listeners and draining pending reads.

Every observed unsafe status/MIME and every non-abort transport error still stops the run. Every
known Reader request needs its own captured body; each profile/feed/requests body also needs
its own canonical, non-partial production Reader result. Another response of that kind cannot
substitute. Auxiliary completed 2xx responses can have explicitly unavailable body evidence;
that is never reported as a captured body.

**L1 qualification amendment:** an auxiliary request with a positive native `net::ERR_ABORTED`
terminal overlapping an observed main-frame navigation is recorded separately as
`navigation-canceled`. It is not a successful 2xx response, and a missing terminal alone never
qualifies as cancellation. A prior unsafe response still fails even if cancellation follows.
This replaces the earlier literal requirement that every started exchange return 2xx, which
mistook normal browser cancellation for a server result. Earlier stopped runs remain stopped;
they lack the native evidence needed to apply this distinction.

## Scope and verification

The production tab, pacing, Reader, mutation policy and account state are unchanged. The native
observer exclusively owns its six session `webRequest` listener slots during the standalone
verify tool; it must not be attached beside another owner of those slots. Raw request text is
kept in memory for matching/classification, while private evidence reports hashes and explicitly
bounded metadata. Account captures remain outside the repository.

Regressions cover cancellation versus loss, auxiliary versus required bodies, native-only
requests, ambiguous joins, payload/status contradictions, unsafe responses followed by aborts,
first-failure retention, blob ordering/caps, session identity and bounded settlement. Local
experiments and the ensuing live result are recorded in the
[overhaul QA record](../qa/plan-derived-overhaul-2026-11.md).
