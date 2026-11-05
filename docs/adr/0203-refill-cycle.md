# 0203 — The bounded refill cycle and the exhaustion latch

**Status:** accepted · **Area:** engine (`src/engine/target-pipeline.ts`)

[ADR 0215](0215-quality-preserving-source-handoffs.md) adds quality-aware queue
occupancy and bounded preparation between actions. New observations are planned
before yielding; partial preparation never authorizes lower-quality follows.

## Context

The growth loop works one chain target at a time. Keeping its candidate queue
stocked means scraping the target's followers, enriching the rows the list left
count-less, and planning a batch. Every one of those steps is Instagram traffic,
and every one of them can fail in a way that looks like "nothing to do here".

Two failure modes had to be designed against:

1. **Hammering.** A dry or rejected target must not be re-scraped every step.
2. **Burning the chain.** `chain.advance` marks a target exhausted
   IRREVERSIBLY. An outage that returns zero rows must never be read as "this
   audience is used up" — that converted a transient rate wall into a
   permanently dead chain.

## Decision

A **cycle** is one bounded attempt to refill the current target's queue:

- at most **one** acquisition,
- at most `MAX_ENRICH_PASSES_PER_CYCLE` enrichment passes
  (`ENRICH_BATCH_SIZE` usernames each),
- then a final plan.

Only demonstrated progress — a plan that enqueued something — opens another
cycle. So the traffic a cycle can spend is provably bounded, and a target that
yields nothing cannot loop.

### The evidence rule for exhaustion

`targetExhausted` latches ONLY on positive evidence: the local pool is spent AND
the latest acquire's end reason is drain evidence (`ACQUIRE_DRAIN_REASONS` =
`no-more-pages`, which verified the end of the list, or `coverage-cap`, where the
coverage policy is deliberately satisfied). Every other genuine end reason
(`target-reached`, `page-budget`, `no-new-for-caller`, `stagnant`) merely BOUNDS
A SLICE — the persisted cursor resumes where it stopped — so a zero under one of
those reopens acquisition instead of latching.

A FAILED read (`shape-mismatch`, `fetch-failed`, `sentinel-blocked`, `stopped`,
`dialog-failed`) yields no evidence at all: it leaves the cycle's acquisition
slot UNCONSUMED and the latch untouched.

### The ladders

Repeatedly walled reads escalate rather than spin:

- A failed acquire, or a cycle whose enrichment delivered nothing while
  un-enriched candidates remain, counts a **walled cycle**; the first ones take
  the long enrich-backoff park, and the `WALLED_CYCLES_ENTRY`-th in a row enters
  the recovery ladder (see ADR 0201) — carrying drift evidence when the read
  itself reported shape drift.
- A slice-bounding zero reopens acquisition promptly for the first couple of
  cycles, then takes the same long park, so a pathological known-rows tail can
  never hot-loop the scraper.

### The dead-end self-heal

When the chain finds no next hop, one revival pass runs before the terminal
`chain-exhausted` halt: the most recently exhausted target — within
`EXHAUSTED_REVERIFY_WINDOW_MS` and not yet re-verified this run — returns to
`active` and is re-adopted, so its acquisition is retried ONCE. A re-exhaustion
re-stamps it and the per-run set blocks a second revival, so a genuinely dry
chain still halts. Deliberate retirements (no stamp — restart-from-seed) are
never revived.

## Consequences

- Refill traffic per cycle is bounded by construction, not by a rate limiter.
- An outage costs a long wait; it can no longer cost the chain.
- The reversal path means a mis-stamped exhaustion is self-correcting once,
  without a manual re-seed.
