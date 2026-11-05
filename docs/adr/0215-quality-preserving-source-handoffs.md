# 0215 — Prepare source cohorts without lowering candidate quality

Status: accepted. Supersedes the unqualified queue-fairness rule in ADR 0211.

## Problem

Choosing a source by recent use before comparing its candidates can follow a
weak leftover while stronger profiles remain queued elsewhere. Having a
positive scorer result proves basic eligibility; it does not prove that a
source is ready to replace a productive audience. Counting every queued record
also lets weak or temporarily blocked leftovers prevent better profiles from
being planned.

## Decision

The source being read and the sources allowed to supply follows are separate.
Discovery may move ahead while good candidates from earlier sources continue
to act. The old queue need not be empty. Source diversity applies only after
the quality and preparation gates pass.

A source proves readiness with K usable profiles. K is the configured refill
low-water count, bounded by one source's queue capacity and the full configured
daily plan; a positive plan requires at least one, and a zero plan admits none.
The number is never reduced merely because few actions remain today. The
default is five. Acquisition and enrichment keep their existing plan, session,
activity-clock and rolling-read budgets.

On first preparation, rank each source's best K freshly scored usable queued
profiles. Choose the source with the strongest Kth member, using source id to
break ties. Freeze those K profiles' scoring features as the reference cohort.
The quality floor is its weakest member, at least the scorer's band-edge score.
Extra weak records cannot lower that floor, and one exceptional profile cannot
prove that a whole new source is ready. The normal ratio curve, mutual-follower
weight and private preference still define quality; this is not a new hard
following/follower-ratio cutoff.

Every new source must have K usable candidates at or above the reference floor
before it can supply automatic follows. Entry is latched: after preparation,
consuming the batch does not strand its final good profiles. Those profiles
still pass fresh eligibility and quality checks on every selection and at the
physical click. A drained queue, restart, failed read or source rotation never
lowers the bar. If no qualified candidates remain, prepare more or wait; do not
spend follows on weak leftovers.

The reference cohort and admitted sources persist inside the version-1 source
frontier as an optional quality record, so old installations prepare from their
existing queues without erasing records or inventing historical evidence.
Status and queue picks are read-only. Explicit preparation writes the cohort
before new sources are admitted.

Frozen features are rescored under the live audience settings, so changing a
score weight does not compare new scores against an obsolete numeric scale.
If the reference profiles become ineligible under new criteria, automatic
follow preparation waits and the UI asks for a deliberate source restart.
Ordinary Stop/Start, pause, relaunch and pacing changes preserve the reference.
Restart-from-seed retires the entire old source portfolio, including exhausted
sources with leftovers, and clears the reference. Existing observations and
follow/unfollow obligations remain intact.

## Interleaving preparation and actions

Once the current read source has a prepared batch and there is no other stocked
qualified reserve, a bounded preparation step can look for another source.
This advances the read location, not permission to follow its candidates.
Good earlier candidates remain available. A preparation step yields to an
already-due action rather than repeatedly rotating sources ahead of it.

With good work already due, each refill unit performs one acquisition or one
profile enrichment, then plans its observations before yielding. Small units
accumulate toward the existing bounded slice's empty-yield evidence; one
unproductive profile does not falsely end a source. Fallback source discovery
uses the same bounded preparation mode. No alternative or a read-budget refusal
preserves a retry deadline instead of immediately retrying the same source.
Exploration pauses, missing session read allowance, and incompatible reference
criteria stop optional preparation while existing safety, journal settlement
and cleanup precedence remain in force.

The Scanner measures usable queue occupancy. Weak, parked, requesting or
journal-blocked records remain durable but cannot consume the usable slots
needed to prepare better candidates. Known below-floor profiles stay
reconsiderable; rejecting them is not evidence that the remote audience ended.

## Validation

Tests cover exact-K readiness, score ordering, source fairness constrained by
quality, one-profile outliers, weak tails, latch depletion, restart, explicit
reset, live settings, malformed/stale profile scores, blocked candidates,
immediate planning, bounded preparation, read deferral and the final click
guard. Private offline replay uses a read-only copy and in-memory queue
consumption; it is not a live follow test or evidence of conversion quality.
