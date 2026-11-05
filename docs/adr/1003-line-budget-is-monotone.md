# 1003 — The line budget is monotone

Status: accepted (2026-09-02)

## Context

`foundation-wiring.ts` is 2,193 lines. `prune-engine.ts` is 1,504,
`engine.ts` 1,125, `GraphStage.tsx` 1,002. None of them got there in one
commit; each grew by twenty lines at a time, every one of which was locally
reasonable. Size is the one code-quality property that is objectively
measurable and that nobody measures, so it is the one that always loses.

A plain "no file over 300 lines" rule fails on 35 files today. Waived
wholesale, it is decoration. Enforced immediately, it blocks every unrelated
change until a multi-week refactor lands.

## Decision

A budget of **300 lines** for authored `src/**` sources (`.ts`, `.tsx`, `.css`;
generated artifacts excluded), plus an allow-list that records each current
violator's **exact current length** — a ratchet, not a waiver.
`tests/tooling/line-budget.test.ts` fails when:

1. an unlisted file exceeds 300 lines (a new oversized file, caught at birth);
2. a listed file **grows** past its recorded length;
3. a listed file drops **to or under** budget, or disappears — it must leave the
   list, permanently, in the same change that paid the debt.

Rule 3 is what makes the list shrink. Without it, debt paid off stays on the
books and the next author quietly spends it again.

`node scripts/gen-line-budget.mjs` re-seeds the file. Re-seeding *downward*
after a split is routine. Re-seeding *upward* is a visible diff in a
version-controlled artifact, which is exactly the review conversation the rule
exists to force — the escape hatch is deliberately not silent, and not a flag.

## Consequences

- Today: 35 files, ~10.5k lines of budget debt. Wave C's exit criterion is an
  empty `allow` array.
- The counter uses `wc -l` semantics (a trailing newline adds no line) so the
  number in the allow-list is the number an editor shows.
- CSS is in scope. `shell.css` (600) and `controls.css` (578) are two of the
  worst offenders in the tree and there is no reason a stylesheet gets a pass.
- During a wave with several agents editing in parallel, a concurrent edit to a
  listed file turns the gate red for everyone. That is the intended behaviour
  outside a wave; inside one, the fix is one command and the allow-list diff is
  the record of who spent the budget.
