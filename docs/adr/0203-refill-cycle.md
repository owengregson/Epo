# 0203 — The bounded refill cycle and the exhaustion latch

**Status:** accepted · **Area:** engine (`src/engine/target-pipeline.ts`)

[ADR 0215](0215-quality-preserving-source-handoffs.md) adds quality-aware queue
occupancy and bounded preparation between actions. New observations are planned
before yielding; partial preparation never authorizes lower-quality follows.

## Context

The original growth loop worked one chain target at a time. Keeping its candidate queue
stocked means scraping the target's followers, enriching the rows the list left
count-less, and planning a batch. Acquisition and enrichment use Instagram;
planning reads and writes only the local store. A failed read can look like
"nothing to do here" unless its evidence is kept separate from the result count.

Two failure modes had to be designed against:

1. **Hammering.** A dry or rejected target must not be re-scraped every step.
2. **Burning the chain.** An outage that returns zero rows must never be read as
   "this audience is used up" or mark that target exhausted.

## Decision

A **cycle** is one bounded attempt to refill the current target's queue:

- at most **one** acquisition,
- at most `MAX_ENRICH_PASSES_PER_CYCLE` full enrichment slices
  (`ENRICH_BATCH_SIZE` profile attempts each), which may be split into the
  one-profile units described below,
- a plan after each successful enrichment unit and at the end of the cycle.

Enqueued candidates open another cycle. An unread local pool or a bounded list
slice can also reopen under the rules below; neither proves exhaustion.
Repeated walls or empty slices back off instead of spinning.

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

## Amendment — preparing quality-qualified reserves (2026-11-04)

The current target owns exploration reads; it does not exclusively own follow
actions. With quality cohorts enabled, the queue's low-water count includes only
currently usable candidates meeting the anchored quality bar. A stocked read
source may advance with `queue-stocked` to prepare a reserve while its old good
queue remains actionable. This is scheduling evidence, never exhaustion.

When an action is available, one preparation unit is either one bounded list
acquisition or one profile enrichment, including an own-follower fallback.
Successful observations are planned before that unit yields. Further preparation
yields to the available action, including its existing owed delay; safety,
journal settlement and scheduled checks keep their earlier precedence.
Paid-for unprofiled rows are worked before another acquisition.
Small profile units accumulate toward the existing slice limit; two individual
rejected profiles cannot masquerade as two complete empty slices.

A missing reserve preserves the current read source and defers further advances;
the same source can still refill when its good queue runs low. A real read-budget
refusal defers both optional refill and source preparation. Neither parks an
existing action. Paused exploration, exhausted exploration allowance, or incompatible
quality anchors prevent optional preparation; cleanup and journal precedence are
unchanged. No source switch lowers the quality bar or deletes an older queue.
