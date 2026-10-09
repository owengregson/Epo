# 0802 — Drift is a metric, and shadow parsing is what earns the switch

**Status:** accepted · **Area:** surface (`src/surface/shadow.ts`, `health.ts`,
`lab/scrub.ts`, `tests/surface/**`)

## Context

`SHAPE_MISMATCH` is an exception-shaped answer to a question that is really
statistical. Nobody can say whether Instagram changed last night or last month,
which endpoint is degrading, or whether a new key appeared on `users[]` three weeks
before it broke anything — because the only record is a `logger.warn` that scrolls
away.

There is also a real risk in the other direction. A stricter schema will reject
bodies the current lenient extractor tolerates, and a rejection mid-walk kills a
whole census. Switching the parse in one step is the single most dangerous thing in
this migration.

## Decision

**1. Shadow first.** Every endpoint carries `mode: 'observe' | 'enforce'`. In
`observe` — where all seven start — the legacy extractor drives behaviour and the
schema runs beside it. `Reader` passes a comparator that knows the legacy shape;
`shadowParse` logs a disagreement with the zod issue path and ticks a counter. Zero
behaviour change. A flip to `enforce` is per endpoint, backed by the disagreement
record, and reversible without a release.

**2. Drift is counted.** `SurfaceHealth` holds, per endpoint: `parsed`, `mismatch`,
`novel`, `rowIssues`, `disagreed`, `lastMismatchAt`, `lastNovelKeys`. `snapshot()`
is already the row shape a `surface_observations` table would hold — the store table
and the live projection are a wave-B seam, and they need no new plumbing because the
existing `onMutation` → throttled-projection path is exactly what PRINCIPLES §2
asks for.

**3. A novelty pass runs alongside the parse.** zod strips unknown keys silently,
which hides the EARLIEST drift signal there is. The novelty pass diffs the raw body's
key-set against the schema's known keys (walked out of `z.toJSONSchema`, which is
also what carries the `pii` metadata) and reports paths like `users[].groups`. A new
key on `users[]` is a warning weeks before it is a break.

**4. The corpus is scrubbed by an allow-list, and the leak test is the gate.**
`src/surface/lab/scrub.ts` walks the schema's shape: a known field with a `pii` class
becomes a stable pseudonym (`user_a1`, `Name A1`, a synthetic pk in a reserved
12-digit range starting `7`); a known non-PII field passes through; **a key the
schema does not know keeps its key and loses its value**, replaced by its type name.
Allow-list, never deny-list. `tests/surface/leak.test.ts` then checks the committed
bytes structurally — no CDN URL, nothing cookie-shaped, no `@handle` that is not a
pseudonym, no profile href whose first segment is not a pseudonym, no long digit run
outside the synthetic range — plus, where the git-ignored originals exist, a direct
differential check. A snapshot that still carries a real identifier is DROPPED, not
committed.

## Consequences

- The corpus is 8 bodies + 5 DOM snapshots, ~130 KB, chosen for SHAPE diversity
  rather than volume: a page without `next_max_id` (the end-of-list shape ADR 0303 is
  about), a page carrying `groups`, a `pending/` body whose `pk` is a NUMBER, a
  confirm row shipped as a `<button>` and one shipped as nested spans inside a
  `div[role=button]`.
- `tests/surface/replay.test.ts` and `tests/surface/controls/*.contract.test.ts` run
  under plain Jest in CI, in milliseconds, against markup Instagram actually shipped —
  including the load-bearing negative for ADR 0302 (a suggestion carousel appended to
  the page never wins the header anchor).
- The corpus records its own blind spots. The 2026-08-12 capture never opened the
  notifications drawer, so `activity-feed` has no body; `following-list` shares the
  followers-list shape and was never separately recorded. Both are named in
  `manifest.missing` and asserted, so "unverified" is stated rather than assumed.

## Alternatives rejected

- **Flip to enforce and watch production.** Risk #1 of the design: a body the lenient
  extractor tolerated kills a census mid-walk, and the cost lands on the owner's real
  account.
- **Deny-list scrubbing.** One missed field in a committed corpus is permanent and
  public. The allow-list's failure mode is a fixture that loses a field; the
  deny-list's is a fixture that keeps a handle.
- **Counters in `meta` instead of a table.** The 1-hour window the health card wants
  needs history. Deferred to wave B rather than decided by the cheaper option.
