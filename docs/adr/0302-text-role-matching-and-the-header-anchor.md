# 0302 — Text/role matching, and the header-only anchor

**Status:** accepted · **Area:** adapter (`src/adapter/page/action-button.ts`,
`src/adapter/versions/*`)

## Context

Instagram's DOM class names are obfuscated and rotate (`_aswp _aswr`). Any
selector keyed on them is dead within weeks. The structure around a control
changes too: the followers/following counts were `/{user}/followers/` links and
are now `<a href="#">` opened by JS — a selector on the old href can never match
again.

## Decision

**Every control is matched by TEXT or ROLE, never by class.** The action button
by its leading state word, the stats by which stat word they name (and which
they do not), the drawer controls by `aria-label`, the confirm row by its text.

**The profile action button is searched ONLY inside the verified `<header>`
anchor.** There is no document-wide fallback tier.

## Why the anchor has no fallback

A broader scope (`main button, button, [role="button"]`) existed once. It could
match a **Follow button belonging to a different account** — a suggestion
carousel, a hover card — while the header was still hydrating. The Actor would
press it, then run its post-click verification against the *same wrong button*,
see it flip to Following, and report success: a ledger row, a state transition,
and a graph edge written for an account that was never followed.

That failure is silent, permanent, and corrupts the knowledge graph. A missing
header button is the opposite: it throws `AdapterStaleError` immediately, which
the recovery ladder treats as drift evidence and a human can act on.

**When Instagram moves the button, the loud failure is the designed outcome.**
Anyone widening this scope is trading a visible bug for an invisible one.

## Supporting rules

- The state matchers are tested in order: `follow back`, `following`,
  `requested`, then the bare `follow` regex — which would otherwise claim the
  leading word of the first two.
- The matchers are PREFIX tests, not exact ones: the button's `textContent`
  carries appended icon alt text (observed live: `"FollowingDown chevron
  icon"`), and the confirm row can read `"Unfollow @name"`.
- A located control must be VISIBLE (non-degenerate rect, centre on-viewport,
  not `display:none`/transparent) before it is pressed. Some menus render the
  matching row twice — one hidden — and a first-DOM-match search kept pressing
  the invisible copy.
- The `smallestMatching` rule (an element whose own text matches but no child's
  does) keeps a search from returning a whole panel instead of its label.

Regression tests: `tests/page/action-button.test.ts`,
`tests/page/confirm.test.ts`, `tests/page/stat.test.ts`.
