# Sidebar revamp — design (2026-09-02)

> **Status (2026-09-02, later):** the owner reviewed the first visual direction and rejected it —
> "extremely lackluster… reuses the same card components over and over… far too basic… scrap it
> and start from the beginning as far as the UI part goes." Sections 2 (layout), 5 (visual
> system) and 7 (the card-based migration) are therefore **superseded**. What survives is the data
> model: the inventory, the data-type → element principle, `Datum<T>`, the projection contract,
> the consequence-preview and explain semantics, and the seams in §6. The UI restarts from zero
> with five independent concepts (see `2026-09-02-sidebar-concepts.md` once written).

**Owner's brief (verbatim):** "apply the same principles to fundamentally redesign the entire
sidebar to be a much more interactive, dynamic surface that better reflects both the information
going into the bot and also the information coming out as it runs. we want things to be much more
understandable with custom dynamic elements running with different data types."

**Scope.** "The sidebar" is the whole console column beside the Instagram tab: the nav rail, the
header and transport trio, the view stage with its cards, the ticker, and the stage-hosted Prune
page. Four parallel design lenses (information architecture · interaction and dynamics · visual
system with a mockup · feasibility and migration) were grounded in the code; this document is the
synthesis. The mockup (`3-mockup.html` in the session scratchpad, published as an artifact) shows
the console in a running-but-parked state at its real width.

## 1. Thesis

1. Today the console is organised by **page**. A page is a filing decision, so one kind of
   quantity gets a different hand-written treatment on every page (a deadline is a ring in
   `LiveStatusCard`, a sentence in `live-status-copy.ts`, and absent on the prune card). The
   revamp organises the console by **epistemic band** and keys every visual element to a **data
   type**. A page then composes elements; it never invents a treatment.
2. v4 hands the sidebar its spine: constants with provenance, `deriveOperatingPlan → Coherent |
   Conflict`, spans whose `parent_id` walk is the answer to "why", durable timers, surface health.
   Three of those have **no renderer consumer today**; several more are computed and dropped
   (`streaks()`, `actionsInLastHour()`, `EpoStatus.refusal` becomes a 6-second toast).
3. The two signature interactions are symmetric: **an input shows its derived consequences before
   commit** (forward), and **an output explains itself back to the rule and the input that produced
   it** (backward). Both terminate in a `Provenance`: an empirical number with a `rev` date, a
   policy dial, or a knob the user can move.
4. The revamp is a **dispatcher, not a rewrite**: signals, push-first subscriptions, WAAPI, the
   anchor positioner, generated tokens, 19 primitives and a liveness test bed already exist and are
   green. The first three widgets need no new IPC at all.
5. Honesty is structural: a widget's value is `Datum<T> = T | Unavailable | Drift` with no fourth
   exit, so a widget cannot fabricate a zero (PRINCIPLES §1/§2, ADR 0303).

## 2. Information architecture — five bands, one rail

| Band | Question | Where |
|---|---|---|
| **INPUT** | what did I tell it | rail slot Setup; every input control carries a consequence strip |
| **PLAN** | what did that derive into, and is it coherent | rail slot Plan; the plan strip in the vitals band |
| **NOW** | what is it doing this second, and until when | the vitals band, always visible on every view |
| **LEDGER** | what has it actually done | rail slots Targets, Queues, Prune; Growth |
| **HEALTH** | can it still trust what it reads | an ambient hairline under the brand mark (DriftMeter as a chip), expanding to a panel on click |

**One addressing space.** Prune folds into the rail (it is a console view wearing a stage costume);
the stage bar keeps only `tab | graph`, and selecting Prune drives the stage as a side effect. The
rail stays horizontal (a vertical rail would spend width the 460 px column cannot spare); each slot
gains a 3 px beacon carrying that view's single live scalar, and the `attention` value
(`ok | attn | blocked`) is **computed in main by the projection**, never by a renderer heuristic:
Now = posture; Targets = runway < 1 day; Queues = unfollows due while parked; Prune = census stale;
Plan = `Conflict`; Setup = unsaved draft / update ready. A conflict created in Settings announces
itself from every view.

**Always visible, at every width:** brand + posture beacon, transport trio with a mode line
(`growth · prune scan · prune run · tour`, each reading its own subject), the **vitals band**, the
ticker's head. Everything else is a panel in the scroller.

**The vitals band** (≈48 px, never scrolls), four cells in causal order: the ring whose arc is the
countdown to the next deadline and whose centre dot is the state; the lead and sub-line
(`PARKED · RECOVERY HOLD` / `41:07 · rung 1 of 3` — drawn honestly as `running` + `parkReason`,
since there is no `parked` engine state); the budget gauge (fill = done, tick = planned draw, hatched
brass tail = the part of the plan `hourlyCap × sessionMass` cannot deliver, end = hard ceiling); the
effective margin as a percentage of the low observed wall with its own danger zone; and an explain
caret that unfolds the cause chain in place.

**Width tiers**, driven by one `tier` value: full ≥ 420 px; compact 320–420 px (widgets step down via
`degradesTo` — rings to chips, plan-vs-actual to sparkline, rosters to a count with drill); spine
< 320 px (rail + vitals only, panels in an overlay drawer). The rule: **a widget that cannot render at
the current tier degrades to a chip that keeps its `explain` affordance** — nothing disappears
silently. Short windows (< 620 px tall) drop nav labels, collapse the chain, close the stream drawer;
the vitals band is the last thing to go. Cards keep the collapse chevron with one new rule: every
card declares a one-line `summary` shown when collapsed.

**The state seam.** The console's right border thickens to 3 px and carries a slow state-tinted
drift while running — the only signal readable while looking at Instagram. Ships **running-only**
(open question 1 resolved conservatively); opt-in for always.

## 3. The widget registry — elements keyed by data type

`src/renderer/widgets/` is the first deliverable. Two hard constraints from the repo: **no zod in the
renderer** (ADR 1009 keeps the bundle dependency-free; schemas are 6–10-line type guards that
narrow `unknown`), and **no `@/types` import** (the boundary gate allows renderer → renderer,
`src/shared`, `src/ipc/contract` only; value types live in the widget module and adapters take
structural slices).

```ts
export type Unavailable = { readonly kind: 'unavailable'; readonly because: string };
export type Drift = { readonly kind: 'drift'; readonly at: string; readonly got: string };
export type Datum<T> = T | Unavailable | Drift;                 // three exits, no fourth

export interface Widget<T> {
  readonly kind: WidgetKind;
  readonly check: (u: unknown) => u is T;                       // the guard IS the schema
  readonly live: Liveness;                                       // mutation | event | tick | draft | demand
  readonly affordances: readonly Affordance[];                   // explain | drill | edit | preview | scrub | pin | filter | transport
  readonly minWidthPx: number;
  readonly degradesTo?: WidgetKind;
  render(value: T, ctx: WidgetCtx): JSX.Element;
  empty(): JSX.Element;                                          // legitimately absent — distinct from unavailable
  unknown(because: string): JSX.Element;                         // never a digit
}
// <Dynamic kind value/> never calls render() unless check() passes; ctx carries ONE clock (nowSignal), explain(), preview(), tier.
```

| Kind | Accepts | Live | Renders |
|---|---|---|---|
| `StateBeacon` | `{state, since, reason?, causeSpanId?}` | posture push | engine/prune/updater/session state |
| `CountdownRing` | `Deadline{dueAt, armedAt, baseMs, reason}` | deadline push + WAAPI arm | `nextActionAt`, `parkedUntil`, `recovery.resumeAt`, prune delay, any timer |
| `BudgetGauge` | `Budget{used, plan, reachable, cap, unit}` | mutation | actions vs plan vs ceiling; hourly velocity; prune daily limit |
| `MarginMeter` | `Fraction` of the low observed wall | draft/mutation | `effectiveMargin` |
| `FeasibilityBar` | `OperatingPlan` (`Coherent \| Conflict{binding, shortfall}`) | draft | plan coherence |
| `PersonaDial` (+ consequence strip) | `Knob<T>{value, options, derives}` | draft, preview-first | the eight ordinal knobs |
| `RangeBand` | `Band{lo, hi, peakLo, peakHi, hardLo, hardHigh}` | draft | the ratio band |
| `KeepList` | `Tokens{items, matchedCount?, protects}` | draft + mutation | whitelist, bio keep-words (with how many mutuals they protect) |
| `FunnelFlow` | `Census<K>` + order + palette | mutation | target funnel, queue census, prune census |
| `PlanVsActual` / `Sparkline` | `Series{points, baselineAt, plan?}` | mutation | growth vs plan; velocity; mismatch rate |
| `CauseChain` | `SpanTree` | demand, keyed by span id | every halt/park/refusal explanation |
| `RungTrack` | `Ladder{rung, max, phase, holdUntil}` | emit | recovery ladder; prune cool-down |
| `TimerTimeline` | `Timer[]` + now | mutation + tick | Chronos rows: holds, cadences, deadlines |
| `DriftMeter` | `Health{parsed, mismatch, novel, lastMismatchAt}` | per parse (throttled) | surface health per endpoint |
| `RosterStream` | `Page<Row>{rows, truncated}` | keyed push | queue rows, prune candidates, chain list |
| `EventStream` | `Stream<Span \| LogLine \| RefusalEvent>` | event | the ticker, the Activity stream, refusal history |

Two rules make this pay: **a widget never re-derives** (the projection sends `Budget{used, plan, cap}`
already labelled — this deletes the `dailyRateView` / `settings-derive.ts` class of defect, where the
renderer hard-codes caps the kernel derives), and **a widget never owns a timer** (one `nowSignal`
in the shell context, ref-counted). Every widget root exposes `data-value` so tests and reduced
motion read one accessor. The closing invariant, as a lint rule over `src/renderer/cards/**`: every
number the sidebar renders comes from a projection payload or a pure derive call over the settings
draft — never arithmetic in a component.

## 4. Interaction — twelve verbs, three gestures

**Verbs** (every element uses them consistently; each has a reduced-motion row that still carries the
fact): *tick* (1 Hz text swap), *stream* (append on push), *settle* (a scalar eases to its new
value), *breathe* (a live process), *arm/disarm* (a deadline registered/served), *explain* (why? →
cause chain), *scrub*, *pin*, *drill*, *compare* (plan vs actual), *preview* (an unsaved input shows
its consequence), *refuse* (a control or Instagram refused — a shake and a pinned, explainable row).

**Gestures** are the only motion forms: *breathe* (2.6 s, dots and hairlines only), *deplete*
(monotone, against a known deadline), *settle* (0.42 s). Nothing else moves.

**Motion derives from the scale.** `design/scale.ts` gains a fourth ramp: frame quantum and
perception thresholds (empirical) → one `MOTION_TEMPO` dial (policy; reduced motion is tempo 0) →
`150 × [1, 1.33, 2, 3]` ms rungs emitted as tokens; the five shipped literals that refuse the ramp
go into `DUR_OVERRIDES` with a reason, and the existing `gen:tokens --check` gate covers motion.
Today timing is spread over 70+ CSS literals and three TS files.

**Animate deadlines, don't tick them.** Every countdown in the app is an absolute deadline, so a
`CountdownRing` arms ONE Web Animations run from the current fraction to zero with
`duration = dueAt − now` and re-arms only when the deadline identity changes; only the `mm:ss` text
reads the clock. This replaces the 1 Hz re-render of whole cards. Reduced motion becomes an
**observed signal** (fed by the media query's `change` event), not a render-time read.

**Inputs that explain themselves.** Every ordinal knob is a `PersonaDial` with a docked consequence
strip whose notch points at the knob: `activityLevel` → daily plan and effective margin; `caution` →
hourly cap and gap floor; `rhythm` → gap median and sessions per day; `dayShape`/`weeklyShape` →
effective hours; `patience` → wait and hold days. The strip is **preview-first**: it reads
`hover ?? focus ?? committed` through a `previewPattern` signal beside the settings draft (the draft
is untouched, so a preview can never be saved); autosave keeps its 600 ms debounce and gains a
fourth chip state, *preview*. A `PlanCoherence` band renders `deriveOperatingPlan`: *Coherent*
states the reachable plan; *Conflict* names the binding fundamental and offers two preview-able
resolutions. A conflict never blocks Start; it persists, and the Overview mirrors it.

**Outputs that explain themselves.** The ticker's decorative beacon becomes a button; the vitals
caret, a refusal row, and a conflict line are three entry points to one `CauseChain`, unfolded in
place on the shipped `.reveal` slide (no modal). The chain renders the span walk in the engine's own
precedence order (`tick → verdict(pacing) → effect(follow) → refused(rate-wall) → recovery-entry →
hold(rung 1)`), capped at six nodes with a "+n earlier gates passed" row, and terminates in a
`Provenance`. A definitive rate-limit refusal becomes a **moment**: pinned at the top of the stream,
timestamped, explainable, never auto-dismissed; ADR 0201's "a definitive refusal skips the streak"
is stated in that popover in one line. The recovery ladder renders as rungs with served ones struck
through and the armed one carrying its own ring.

**Streams and time.** The Activity card becomes a span-backed stream with grouping by cause, filter
chips derived from the closed `SpanOutcome` union, and a last-hour rail that can be scrubbed and
pinned; a pin broadcasts one time cursor for series that already have history. `TimerTimeline`
renders every armed Chronos row on one axis, overdue rows first (§3 durable schedules made visible).

**Transport.** The mode line replaces `title`-only explanations (keyboard users never see a title);
refusals shake the pressed control and pin a row; prune scan progress lifts into the rail via a
`useScanCensus()` hook so the census is visible from any stage.

**Accessibility.** Focus order follows the column; `?` explains the current state, `Esc` closes,
arrows scrub, `P` pins; no single key fires an engine control. `aria-live` is rationed: the ticker
and stream go `off`, one console-level `role="status"` region announces state transitions and
refusals only, halts keep `role="alert"`. Countdowns are labelled with their reason, never live.

## 5. Visual system

Four laws: **two thicknesses** (1 px hairlines; tracks on the `2n+1` ramp with `round(h/2)` radius —
reproduces all three shipped meters, with the 6 px dual-range track as a named override); **three
gestures**; **colour is state, not category** (four state aliases onto the approved palette:
`--st-live`, `--st-ready`, `--st-hold`, `--st-refused`, plus `--st-unknown`; category hue only from
the graph palette and only on proportional marks); **honest empty, drawn** (`live` / `stale` with
age / `unknown` with a reason / `n/a` collapsing to a hairline so layout never jumps).

Tokens are fitted, not invented: rings `30 + 14n` (reproduces the shipped 58 px hero ring),
`--ring-stroke: 4px`, `--ring-dot: 10px`; tracks 3/5/6 px; motion 2.6 s / 1 s / 0.42 s; `--spark-h`,
`--lane-h`, `--seam-w: 3px`, `--vitals-h`. No new hue. `data-park` joins `data-state` on the console
root so a park is a cascade, not a class computed in TSX. Every numeral is tabular; identifiers and
reason keys are mono so `429 feedback_required` reads as a machine fact.

## 6. Data the sidebar needs (seams)

| Need | Provider | Shape / channel |
|---|---|---|
| `causeSpanId: string \| null` on `EngineStatus`, `PruneStatus`, and verdict fields of `ChainTargetDetail` | runtime (G) + store (S) | the ONE contract addition everything backward hangs on |
| `spans:chain(id)` invoke + `spanTail` push | store (S) + shell (I) | `Span[]` root→leaf; last N spans; **open: do `SpanSink` writes fire `store.onMutation`? If not, spans need their own emitter sharing the throttle** |
| `operatingPlan` invoke + push | shell (I) over the kernel (F) | main-computed `OperatingPlan` + `effectiveMargin` + derived set with `Provenance[]` — the renderer may not import the kernel (boundary) and must not bundle derive.ts |
| `timers` projection | store (S) + shell (I) | Chronos rows |
| `surfaceHealth` projection | surface (A) + shell (I) | `SurfaceHealthSnapshot` |
| `PROJECTIONS` grows 3 → 12 rows with `invalidatedBy` and keyed entries (`queueRows`, `targetDetail`, `causes`) | shell (I) | replaces the counter-keyed pulls (`useQueue` is frozen during acquisition walks today — a §2 violation; `useGrowthSeries` keys on `netToday` alone) |
| `attention` per rail slot | shell (I), computed in main | `ok \| attn \| blocked` |

Until a seam lands, the widget renders `unavailable('…arrives with spans')` — its frame and explainer,
never invented rows.

## 7. Migration (lands after wave A's renderer work; every step green on all gates)

| # | Step | Needs | Cards remaining |
|---|---|---|---|
| 0 | Gate: wave A integrated (`GraphStage` split merged, tokens test green, `src/renderer/app/*` quiet) | — | 26 |
| 1 | `widgets/registry.ts` + `Dynamic` + beacon, countdown, budget rendered inside today's cards; `nowSignal`; `reducedMotionSignal`; motion ramp in `scale.ts`; the arrow-icon defect fixed | nothing new | 26 |
| 2 | Vitals band under the header; the state seam (running-only) | — | 26 |
| 3 | Inputs with consequence strips + `PlanCoherence` | `operatingPlan` channel | 24 |
| 4 | Event stream over spans; refusal as a moment | `spanTail` | 23 |
| 5 | Cause chains from three entry points | `causeSpanId`, `spans:chain` | 22 |
| 6 | Timer timeline; rung track | `timers` | 20 |
| 7 | Rail beacons with main-computed attention; Prune into the rail | `attention` | 20 |
| 8 | Retire cards one per change; `cards-remaining` monotone test seeded at 26 | steps 1–7 | ≤ 8 |

Ownership for parallel work (no file owned twice): **W1** registry + steps 1, 2, 7 (`widgets/registry.ts`,
`app/Vitals.tsx`, `app/Nav.tsx`); **W2** step 3 (`widgets/conflict.tsx`, `hooks/useOperatingPlan.ts`,
`cards/settings/*`); **W3** steps 4–5 (`widgets/{stream,cause}.tsx`, `hooks/useSpanTail.ts`,
`cards/overview/ActivityCard.tsx`); **W4** step 6 (`widgets/timeline.tsx`, `cards/prune/PruneScheduleCard.tsx`).
Contended files are append-only (`contract.ts` rows, `projections.ts` array, `styles/index.css` imports).

**Tests.** One render test per widget (value / empty / unavailable asserts no digit / bad shape →
unknown); §2 liveness per view (a pushed projection moves `data-value`, no pull happened); a
reduced-motion suite over the whole registry; a tour-anchor resolution test before any card is
deleted; the dev `?gallery=1` route as the human review surface at three widths.

**Risks.** Re-render storms (widgets take values, never the shell; a test asserts one push re-renders
one widget); `useNow` proliferation (one signal); a widget faking a value (`Datum` has three exits);
console width (gallery at three widths; min-widths in tokens); the tour breaking silently (anchor
test first).

## 8. Open questions for the owner

1. Prune into the rail (one addressing space, keyboard reachable) — accepted here; say if the
   candidate table's stage width matters more.
2. Should `dryRun` change the console posture (a distinct `data-state` and transport tone)? It
   changes what every number means. Proposed: yes.
3. How much refusal history: explain the current state only, or a "last 24 h of refusals" panel?
4. Do the 14 numeric pacing knobs stay writable? If the eight ordinal knobs are the surface, the
   consequence strip becomes the only place numbers appear and `AdvancedCard` shrinks to three items.
5. Preview on hover or focus only? Proposed: both, behind one flag, trial in the gallery.
6. Vitals cost (≈48 px of ≈900): keep, or collapse to a 22 px line when the stage is scrolled?
