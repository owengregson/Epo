# 0806 — One parser, tiers, presence-gated verdicts, witnessed recovery

**Status:** accepted (legacy comparators remain until Phase L validates their removal) · **Area:** surface
(`src/surface/read/*`, `src/surface/transport/*`), adapter
(`reader*.ts`, `drawer-read.ts`, `fetch-json.ts`, `mutation-*.ts`), rim (`list-walk-end.ts`, `list-page-walker.ts`,
`profile-observer.ts`, `profile-visit.ts`), engine (`census-authority.ts`, `prune-scan-guards.ts`)

## Context

Instagram changes how it delivers a fact far more often than the fact itself: a key is renamed, a wrapper appears, a
count arrives as a string, a cursor becomes opaque, a body is streamed. Each of those used to read as a *false*
destructive fact: a renamed `following` key made every row "not following" and turned held records `external`; an
opaque cursor let a synthesized offset probe "verify" an end after 50 of 120 rows; a lenient requests parse made an
unreadable panel look like "nobody asked"; `{data:{user:null}, errors:[…]}` read as "this account is gone"; throttle
text found only in an error's `summary` burned the candidate. The rule this ADR adopts: **recovery may add facts; it
never subtracts them.**

## Decision

1. **Tiers and admission.** A read is C0 (the declared container and keys), C1 (a declared normalization step: an
   alternate container, an alias key, a retype, framing, a root-field route) or C2 (recovered). A destructive claim
   needs C0/C1, a complete (non-partial) read, and every key it depends on present (`read/admission.ts`).
2. **Presence-gated relationships.** Each relationship key reads by presence; `weFollow` is `false` only when both
   `following` and `outgoing_request` are present and false. A branded `ObservedRelation` is minted only in
   `read/relationship.ts`, and the relationship reconciler accepts nothing else.
3. **Continuation and the walk table.** A page's continuation reads in a fixed rule order (a non-final stream and a
   more-flag without a cursor are drift; a cursor continues; false flags end; no flags end without evidence) with a
   veto key for an unexplained cursor-like key. The walk keeps a sticky cursor form: an offset space verifies an end
   by one probe; an opaque space ends only on the server's false flags with no veto; new rows past a claimed end
   follow the server's cursor or stop — never a second synthesized offset. Unreadable rows are quarantined and
   counted; every absence verdict refuses a census with quarantined rows, and coverage fails closed on an unknown
   header (`coverageVerdict`).
4. **Field invariants** (`read/fields.ts`): ids only from allow-listed keys with agreement (foreign ids never vote);
   counts as one pair, retyped from digit strings; epoch seconds in range; booleans and text by presence; a null
   relationship is "self" only on the viewer's own record.
5. **One transport.** One decoder (a declared guard, newline-delimited and multipart payloads merged by path, the
   final flag), one GraphQL envelope (every error entry × text key; a refusal signature is a wall; errors without
   the root wait; errors beside it are partial), one observed gate (a wall is never drift), one routing table (the
   profile on any GraphQL path; a declared root field routes a renamed operation at C1). The composed list read hands
   back text for any parseable 2xx and is decoded once.
6. **Evidence.** "Gone" needs the declared container explicitly null, no GraphQL errors and a final body; a visit's
   outcome follows the evidence it saw (wall body, drift, Instagram's empty body, page text, deadline).
7. **Drift is persisted, per account, by one writer** (parse health). The production sink
   (`main/services/surface-health-sink.ts`) alone writes `surface_drift` (one row per surface × endpoint × class × path
   pattern: types, operation names and counts, never a value), `surface_health` (read tallies per plan-day ×
   endpoint) and `meta.surface_meter`. Tallies flush on the push throttle's trailing edge, at a plan-day roll and at
   teardown; a signature lands at once, with at most one scrubbed, leak-checked sample. Learned hints become
   consistent after `driftConfirmThreshold()` distinct witnessed subjects with no contradiction and never promote.
8. **Area states and the surface gate are derived** (`surface/health-view.ts`). Unfollows and relationship reads pause
   on recovered or relationship-key-absent profiles, unfollows on an absent bio or verified badge, pruning on any
   drifted list page and exploration once `driftConfirmThreshold()` drifted pages were seen, follow-back decisions on
   unreadable requests. The gate reads before any read is spent and lifts when clean canonical reads resolve the
   signatures behind a pause, so it survives restarts and never spins.
9. **Compatibility, not a rate limit.** `status.surface` rides the status push; the compatibility panel pulls
   `surface:report` on each revision; Copy report carries scrubbed samples and masks every digit run of six or more.
10. **The corpus is real and scrubbed.** The 2026-11-02 probe bodies are ingested through the production router and
    the 2026-08-12 bodies re-scrubbed (agreeing id aliases, rounded counts, shifted times); both pass the structural
    and differential leak checks before commit, and their manifests' `novelKeys` are the novelty baseline.

## Consequences

- A small delivery change costs a paused verdict, never a wrong fact; real bodies keep reading at C0 (zero facts lost
  on the captured corpus).
- All endpoints use the surface parser. Legacy extractors are reverse-shadow comparators only; their deletion
  requires the L1 and L4 live evidence recorded in the [validation record](../qa/plan-derived-overhaul-2026-11.md).
- The read pipeline's guardrails and protocol facts live in `src/kernel/surface-policy.ts` (`SURFACE_BOUNDS`,
  `HTTP_STATUS`).

## Alternatives rejected

- **"Safe either way" end probes.** An offset probe against an opaque cursor returns the head, which reads as
  "nothing new": a verified end that was never verified.
- **Defaulting absent booleans to `false`.** Cheaper, and exactly the class of fact this ADR exists to stop.
- **Lenient parses for "fact-only" callers.** Every lenient variant ended up feeding a completeness or absence
  verdict; strict reads with typed failures replace them.

## Amendment — 2026-11-03: one parser, the flips, structural recovery (PP-b)

- **`readBody` is the parser** (`src/surface/read/read.ts`, never throws): the observed gate, one decode, the declared
  container resolved FIRST (canonical, then alternates as a C1 step; a GraphQL connection read as a page), then the
  GraphQL envelope over that root, the field readers, `EXPECTED_KEYS` and the row majority. Every read reports once to
  the env's sink (`read/report.ts`); the in-memory `SURFACE_HEALTH` is gone. `ObservedReads` (owned by the `Reader`)
  reads an observed response once for every consumer of it (one body read, one decode, one tally).
- **The flips** ran in §10.3 order, one commit each: profile (and the dead `/users/<pk>/info/`), feed, requests, the two
  relationship bodies, the two lists. Each is `enforce` in the document; the legacy extractors read the document's clean
  canonical bodies (every field and row read) only as comparators, and a field they read differently is
  `shadow-disagreed` (`src/adapter/reader-shadow.ts`). The differential test pins zero differences on every real body
  of both corpora; the intended differences are asserted only on synthetic drift (I1 ids, I7 actors, I9 times).
- **Recovery** (`src/surface/recovery/{locate,signatures}.ts`, `read/recover.ts`) is bounded (R1), skips the declared
  decoys (R2), needs its witness (R3: a visit's anchor, the drawer's or the requests panel's arm, an acquisition walk's
  source pk), accepts exactly one place (R4), rows by majority (R5), hints first (R6) and identity continuity for rows
  (R7). A pattern never carries an id (id-keyed maps render `*`). A recovered read is C2: it adds observations, follow
  events, requester rows and candidate-pool rows, and every destructive sink refuses it (viewer flags withheld, own
  counts dropped, `pendingComplete:false`, no absence, a list continuation never recovered).
- **Only the acquisition walk reads `source-rows`** (`WalkArgs.arm = 'acquisition'`); census, head and following walks
  read C0/C1 only and stop on a moved page. The walk's own verdicts (`cursor-veto`, `end-claim-false`,
  `no-continuation-evidence`) and every C2 read reach the sink, which is what pauses cleanup and exploration.
- **Deadline candidates**: an armed profile visit, drawer or requests panel keeps matching unrouted GraphQL
  responses as references (≤ `fallbackCandidates`) and reads them only at its deadline. The requests arm starts
  only when that panel opens. The observed HTTP/MIME gate applies before body recovery; one cached decode serves
  all consumers of a response. The operation that answered is reported `unrouted` with a hint, so a consistent one
  routes later reads (`via: 'learned'`, still C2, never promoted).
- **The empty bio** stays unresolved by the corpus (no scrubbed 2026-11-02 profile body carries an empty or null bio):
  a `null` bio reads as absent (fail safe) until a live read shows the form (`versions/2026-08-12/expected.ts`).

## Amendment — pre-live review: transport and incomplete evidence

- Mutation responses use the same HTTP/MIME gate as reads. A parseable HTTP 400 may explain a refusal but cannot
  authorize success. GraphQL exchange errors cannot be overridden by an optimistic DOM state.
- A non-final mutation response remains partial evidence while the watch waits for a later final body. A deadline
  with only partial evidence leaves the action unverified for journal settlement; a button flip cannot commit it.
- Dialog and direct list walks with partial data, unreadable rows or unsupported continuation cannot establish
  completeness. A wall or drift discovered while pending body reads drain overrides a natural end.
- A fresh click review rejects recovered/partial follow evidence. Queued follows require the visit's current count
  pair before scoring; previously stored counts cannot supply missing proof. Additive observations remain stored.
