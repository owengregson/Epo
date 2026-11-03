# 0806 — One parser, tiers, presence-gated verdicts, witnessed recovery

**Status:** draft (the parse stream's first half; the one-parser flips, recovery and drift persistence land with
PP-b and the parse-health stream) · **Area:** surface (`src/surface/read/*`, `src/surface/transport/*`), adapter
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

## Consequences

- A small delivery change costs a paused verdict, never a wrong fact; real bodies keep reading at C0 (zero facts lost
  on the captured corpus).
- The legacy extractors keep driving behaviour until the per-endpoint flips; they already read relationships,
  continuation and counts through the permanent modules, so the flips swap what sits underneath.
- The read pipeline's guardrails and protocol facts live in `src/kernel/surface-policy.ts` (`SURFACE_BOUNDS`,
  `HTTP_STATUS`).

## Alternatives rejected

- **"Safe either way" end probes.** An offset probe against an opaque cursor returns the head, which reads as
  "nothing new": a verified end that was never verified.
- **Defaulting absent booleans to `false`.** Cheaper, and exactly the class of fact this ADR exists to stop.
- **Lenient parses for "fact-only" callers.** Every lenient variant ended up feeding a completeness or absence
  verdict; strict reads with typed failures replace them.
