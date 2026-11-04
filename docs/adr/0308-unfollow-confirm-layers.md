# 0308 — An unfollow is a bounded sequence of confirm layers; one admission per action

**Status:** accepted · **Area:** adapter
(`src/adapter/{action-admission,unfollow-flow,confirm-capture,actor,response-watch}.ts`,
`src/adapter/page/confirm.ts`), surface (`src/surface/versions/2026-08-12/{controls,literals-dom}.ts`), engine
(`src/engine/mutation-outcome.ts`) · **Date:** 2026-11-03

Amends ADR 0212 (the journal mark happens once per action, before its first press — now the header press for every
unfollow), ADR 0304 (one `MutationWatch` spans every press of an action; after a dispatched press an `err` result means
Instagram showed nothing) and ADR 0307 (settle-then-press now runs once per located confirm layer, after a reading
pause on it). Spec §11 (F1–F5, F7, the passive capture); F6, the journal settlement row, is ADR 0213's.

## Context

Unfollowing from a profile header is not one confirmation. What Instagram shows after the header press depends on the
relationship:

| Variant | After the header press | What the single-confirm Actor did |
|---|---|---|
| **P** — a private account you follow | a menu sheet (`Unfollow` row), then a second dialog ("If you change your mind, you'll have to request to follow … again." `[Unfollow] [Cancel]`) | pressed the menu row and never looked again; waited for a mutation only the unpressed dialog would fire; the dialog stayed on screen |
| **R** — a pending request (`Requested`) | a confirm dialog | admitted at the header press **and again** at the confirm press; the second admission saw the first press's own `dispatched` intent and refused, so the confirm was never pressed (the live incident) |
| public | the menu sheet; its row fires the mutation | worked |

Both failures ended as `blocked / tab-unhealthy / unverifiedClick` with an uncertain intent, the dialog open through
the parks, and — because the engine treated every non-local block as rate-limited — a UI stall fed the rate-wall
ladder; two stalls in a row also tripped `MUTATION_BLINDNESS` ("the mutation table matches nothing") although the
table was fine and the page had simply stalled.

## Decision

1. **One admission per action (F1).** `prepareAction`'s dispatch closure runs `beforeMutation` and `onDispatch` at
   most once, before the header press and after the look-before-act dwell. Every later call — the later confirm
   layers of the same action — re-runs only the check (the stop token, the same profile URL); a refused admission
   refuses every later call too, so nothing is ever pressed after a refusal.
2. **The confirm layers (F2, `unfollow-flow.ts`).** After the header press the flow polls, within the D4 control
   bounds, for evidence or a layer: the mutation's answer (`peek()`), a header flip to the settled state, or a
   pressable confirm control whose layer signature differs from the last one pressed. A located layer gets a
   reading pause (`ui.step-pause`, off under the reference tempo until the plan's tempo is swapped in), then a
   settled press of that same layer only — a re-locate that finds a different signature presses nothing. At most
   `layers.length` presses happen: the surface lists the layers an unfollow can show (`CONFIRM_LAYERS = menu,
   dialog` in `versions/2026-08-12`), so the bound is surface data, not a literal. Later layers search the dialog
   scopes only. A follow runs the same flow with zero layers: a dialog is never pressed.
3. **The locate (F3, `page/confirm.ts`).** Dialog scopes are walked newest first (portals append, so the last in
   document order is on top), `document` last unless `dialogsOnly` drops it, and a control counts only when a hit
   test at its centre lands inside it — a menu fading out beneath the dialog is visible but no longer on top. A hit
   reports its `layer` (`dialog` when its layer also offers the companion control `companionRx`, the dialog's
   Cancel; else `menu`) and the layer's `sig` (index from the newest, role-marked controls, normalized text).
   **There is no press fallback**: a text miss reports nothing to press. Epo runs on an English interface, so a
   miss means an unexpected layer — a Restrict or Block confirm after a mis-pressed row, a notice — where pressing
   the first button could be destructive. `confirmLayer` describes the top layer for the exits and the capture,
   including the one control a two-button layer offers beside its companion, which is reported and never pressed.
4. **One watch across the presses (F4).** The `MutationWatch` armed before the header press is never re-armed (a
   re-subscribe could miss a response). `ResponseWatch` gains `peek()` and `markPress()`; the arrival latency runs
   from the last press, so the meter stops counting hydration and menu animation. An unobserved window counts
   toward `MUTATION_BLINDNESS` only when no confirm layer is on screen.
5. **Leave the tab clean (F5).** When the outcome did not land — an unverified result, Instagram's refusal, a
   drifted control — the top layer still on screen is closed: the dialog's Cancel (`unfollow-dialog-cancel`, dialog
   scopes only), else the menu's Close X (the `drawer-close` descriptor, searched in the confirm scopes), through
   settle-then-press and never through the dispatch closure. A layer nothing closes is a warn. A stop, a stalled tab
   or a check that failed mid-layers presses nothing more. When Instagram showed nothing and the layer is neither
   the one last pressed nor one carrying the confirm text, it is **unrecognized**: never pressed, logged, and
   reported to the injected `SurfaceSink` as a `confirm-unrecognized` drift signal.
6. **An unverified dispatch is a park, never a wall (F7).** After a dispatched press the Actor's `err` result means
   Instagram showed nothing (no response, no refusal text, header unchanged); a response it did send — a refusal,
   an `errors[]` body, an answer the DOM contradicts — throws as a refusal, so an observed `errors[]` is never
   unverified. `normalizeMutationOutcome(outcome, dispatched, 'none')` maps the former to the unverified outcome
   (blocked, uncertain, no cause; `isUnverifiedOutcome` names it), which the engine parks with `park.blocked`
   (pace-up) without `recovery.noteOutcome('rate-limited')`. The unverified-streak breaker (unavailability at
   `driftConfirmThreshold()`, then counting toward the ladder) is built on the same predicate by the plan runtime.
7. **The passive capture.** A layer met after the first, one left on screen or an unrecognized one is captured
   once per distinct layer: its markup through the fixture scrubber's DOM pass with the action's own handle seeded,
   the offered control, and the watch's unmatched POSTs. The default writes one line to the durable runtime log —
   the local diagnostics area, never committed, never uploaded; a harness or test injects its own. The next real,
   already-due private unfollow is both the live test and the capture (spec §22 L5); no probe ever presses Unfollow.

## Consequences

- The header press is dispatched, so a confirm that never appears after it is an honest unverified result rather
  than pre-click drift; drift on a confirm layer now surfaces as `confirm-unrecognized` (and a capture) instead.
  The old self-recovery that pressed the header a second time to reopen a vanished menu is gone: it was a second
  press after dispatch.
- Zero presses on every refusal path (a refused admission, a failed later check, a stop), and nothing in page code
  or the flow presses an unrecognized control; Cancel and the Close X are the only exits pressed.
- `actor.ts` shrinks below its recorded length (757 → 655); the flow and the capture live in their own modules.
- Two seams are still to be wired outside this stream: the production `SurfaceSink` (the parse-health stream's
  surface wiring; until then `NO_SINK`), and the unverified classification's caller — the churn port's cause
  vocabulary has no `unverified` member yet, so `churn-actions.ts` must pass the evidence (`'none'` for the Actor's
  post-dispatch `err`) before F7 takes effect; until then today's mapping holds. A dedicated capture folder, if
  wanted, is one injected `ConfirmCapture` at the composition root.
- The mutation-arrival meter's samples shift down (they no longer include hydration and menu animation).

## Alternatives rejected

- **A structural press fallback** (press the first of two buttons when the text misses): an unexpected layer is
  exactly where that is destructive; the structural match is reported to the capture instead.
- **Re-arming a watch per press**: a re-subscribe can miss a response that lands between the two.
- **Admitting at the confirm press** (today's Following path): the journal mark must precede the first press that
  might fire the mutation, and a Requested header press can fire it inline.
- **Counting every post-dispatch failure as rate-limited** (today): a UI stall is not a wall; it parks, and only a
  streak of them is evidence.
- **A numeric `maxConfirmLayers`** in the surface: the count of the listed layer kinds says the same thing and keeps
  the version module free of a bare number.
