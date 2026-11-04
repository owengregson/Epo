# 0405 — A larger, calmer console: semantic type ladder, AA palette, bundled Inter, motion vocabulary

Status: accepted

## Context

The owner, about the whole app: "Right now it's a bit too compact and techy. Make it easier for the average person
to understand by increasing spacing, sizing of elements, etc. Also add more animations to the main page so that it's
more clear what things are going on."

What the console had: a 12 px body on a ladder fitted to an old mockup (8.5 · 9 · 10 · 11 · 12 · 13 · 15 px), six
hand-tuned `cqi` type roles, 24–30 px controls, uppercase tracked eyebrows on every card, a boxed stat grid, and two
text colours that failed WCAG AA (`--faint #66666e` failed on every surface). Motion durations were ninety literals
spread over the sheets, one loop pulsed `box-shadow`, and the face fell back to the system font.

Before any of it was restyled, static **direction boards** (`src/renderer/gallery/direction/`, `?gallery=1`) showed
the proposal at 640/800/920 px heights and 1024/1440/1920 px widths: the live column in seven postures, Settings Easy
and Advanced, People, the splash and the intro, the motion gestures. An independent review asked for eleven fixes;
they were folded into the boards before the restyle (see Decisions below), and the lead signs the direction off in
the owner's absence (spec §18.3).

## Decision

1. **One semantic type ladder** in `design/scale.ts` (generated, ADR 1005): text rungs `15 + [−4, −3, −2, −1, 0, +2]`
   = micro 11 · caption 12 · small 13 · label 14 · **body 15** · lead 17; display rungs `2·round(16·1.25ⁿ/2)` for
   n ∈ {1, 2, 3, 5} = title 20 · heading 26 · state 32 · hero 48. The fluid `cqi` type roles are deleted. Uppercase
   is reserved for badges of three characters or fewer; no sheet uses caps tracking.
2. **Spacing** keeps its fitted fluid rule and gains `--sp-7` 32 and `--sp-8` 40. **Controls** are `32 + 4n` (32 /
   36 / 40 / 44): no hit target below 32 px, stage tabs 36, the posture primary 44. **Radii** 8 / 10 / 14. The size
   containers are generic (`.console, .stage-page, .stage-col`).
3. **Palette**: three values reopened with measured WCAG 2 contrast on every surface — `--faint #8e8e97`, `--muted
   #a8a8b0`, `--danger #d27878` — the rest unchanged. Colour is state: `--st-live/-calm/-hold/-alert/-good/-idle`
   alias existing accents (calm on `--muted`, a visible step below live), each with a faint glow. Boost adds no hue.
4. **Inter Variable** (Latin subset, SIL OFL 1.1) is bundled in `src/renderer/fonts/`, declared first in the cascade
   (`styles/fonts.css`, `font-display: block`), emitted by esbuild's `'.woff2': 'file'` loader; numerals that count
   use tabular figures (`.num`).
5. **Motion that explains change**: tokens `--dur-1…5` = `PERCEPTION × 1.2 × [1, 5/3, 8/3, 4, 7.5]` = 120 · 200 · 320
   · 480 · 900 ms, `--breath` 2.6 s, `--ease`, `--ease-out`, `--ease-in-out`, mirrored in `design/motion-scale.ts`
   (`PERCEPTION_MS`, `DUR`, `BREATH_MS`, `STAGGER_MS`, `BOOT_UI`, `CHART_DEFAULT_DAYS`). The renderer may not import
   the kernel (spec §3 deviation 1), so a test pins `PERCEPTION_MS` to `EMPIRICAL.DISPLAY.perceptionMs` and the CSS
   tokens to `DUR`. Six gestures, each with one meaning and a written reduced-motion form: settle, deplete, arrive,
   breathe, nudge, file-into. At most two infinite loops, both opacity on the compositor (the mark's ring, the Live
   dot); the `box-shadow` pulse is gone. `staggerSections` opens every stage page.
6. **Instruments, not cards**: one raised surface per column (Now); every other zone sits on the column background
   under a hairline.
7. **Geometry and the mark have one home each.** `SHELL_GEOMETRY` (kernel tier 1: 460 px column, 44 px band, the
   500 ms bounds debounce) is read by `shell.ts` and pinned in `shell.css` by a test. The mark's geometry lives in
   `src/renderer/design/brand-mark.ts`; `EpoMark` draws it and the favicon is `brandMarkSvg()` as a data URI, pinned
   byte for byte.

Decisions taken on the boards after the review (recorded for SB, SU and SH, who build on them):

- The Now ring never loops: it is full while a step runs and drains toward the next deadline; static when idle. The
  spec's "indeterminate arc" is drawn as a full arc, which keeps the two-loop law intact.
- A feed row's sentence stays on one line; its reason, list of people or time moves to a 12 px detail line, so
  nothing is cut mid-word. The "Since you left" divider is a strict time boundary.
- Today's title row and the Boost band share one 40 px height; the paused band is one line and "Press Start to use
  Boost." moves to the Now reason line.
- Posture words keep to 15 characters ("Get set up"); the deck's "Let's get set up" and "Can't open your data" break
  that contract and are reported to the lead.
- Settings at the 1024 px minimum wraps its section chips onto rows (never a sideways scroller) and lists "Today's plan
  in detail" as one sentence per session below 700 px of content; Easy's "When Epo works" carries the three session
  styles; "Set by you" is neutral (provenance, not a state); every limit is printed from one fixture value.
- People's funnel bars are true linear shares with a 3 px sliver.
- Under reduced motion the splash shows a still, even hairline (a frozen highlight would read as stuck progress).

**The motion SB wired into the live column.** *Settle*: `NumberTicker` arms one frame after mount, so a first value
never rolls, and reports a later rise for the "+N" chip. *Deplete*: the Now ring and the Boost band each run ONE
linear WAAPI animation per deadline (`armDeadline`), re-armed only when the deadline itself changes; the plan strip's
now marker is one linear move to the strip's end. *Arrive* and *file-into*: the feed's new rows rise into place while
the others glide (`flipInsert`); a single new follow or unfollow travels from the now line into its row; scrolled
away, the list holds still. *Nudge*: two small shakes once per move into an attention. The column's only loop is the
mark's breath while Epo is live (the Live tab's dot is the shell's second); the splash's shimmer runs only before the
app is shown. The intro: the mark flies into the masthead over `--dur-4` while the splash fades and the zones rise a
60 ms stagger apart; the ring and plan blocks draw to their current values; reduced motion is one `--dur-2` cross-fade.
`live-sheets.test.ts` holds the sheets to the tokens and the loop count.

## Consequences

- Every renderer number now has a rule or a test: `tokens.test.ts` (golden, L-TOKENS, the restyle laws, the bundled
  face), `contrast.test.ts` (L-CONTRAST, measured from the stylesheet), `motion-scale.test.ts` (L-MOTION),
  `geometry.test.ts` (L-GEOMETRY), `brand-mark.test.ts` (L-MARK), `direction-boards.test.ts`.
- Text is about three pixels larger everywhere and controls are 8–14 px taller. The fixed-zone live column
  replaces the old scrolling console.
- The Settings stage replaces the old `settings.css`; its temporary `--fs-xs`/`--fs-sm` aliases are removed from
  `tokens.palette.css`.
- `scale.ts` drops to 226 lines and leaves the line-budget list.

## Alternatives rejected

- **Keeping the fitted 12 px ladder and scaling it up** — the old rungs carried roles ("micro badge caps") that the
  refresh retires; a semantic ladder names what a size is for.
- **Fluid (`cqi`) type** — the column is a fixed 460 px, so fluid roles only added hand-tuned clamps that no single
  container width reproduced (ADR 1005's own note).
- **A system font stack** — metrics differ per OS and the console's tabular readouts jitter; one bundled face is
  ≈ 73 KB and loads behind the splash.
- **Moving the mark to `src/shared/`** (spec §12.6) — the static-timing gate scans `src/shared`; its ~30 geometry
  numbers would need allow-list entries only the lead may add. The renderer is the mark's only consumer.
- **A spinning "working" arc** — a third infinite loop with no reduced-motion form; the full ring says the same.

## Amendments to earlier ADRs

- **1005** (tokens are generated from a scale): the ladder rule changes from "fitted to the shipped mockup" to the
  semantic rule above; the fluid type roles and `--h-ticker` are deleted; spacing gains two rungs; controls follow
  `32 + 4n`; the container selector becomes `.console, .stage-page, .stage-col`. Generation, freshness and the golden
  stay as 1005 decided.
- **0402** (WAAPI for the card entrance): `staggerSections` joins `staggerCards` under the same contract (WAAPI owns
  timing and the reduced-motion gate; a no-op in jsdom), with its timings from `motion-scale.ts`; CSS durations come
  from the `--dur-*` tokens rather than literals.
