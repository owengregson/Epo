# Epo interface cleanup after owner review

The owner rejected the overhaul's visual quality after offline verification at `fc87208`. That
verification established behavior and basic geometry; it did not establish consistent spacing or a
finished composition. The seven supplied crops are examples, not the complete scope of this cleanup.
Live account checks remain paused.

## Layout decisions

- One generated spacing scale: 2, 4, 8, 12, 16, 20, 24, 32 and 40 CSS pixels. Nested containers no longer
  change the value of a padding token. Responsive rules change columns and wrapping instead.
- Content determines card height. Absent progress, reasons, chart history and census metrics do not
  reserve empty rows. Intentional reading-width limits and useful plot space remain.
- Now separates its status and transport controls with the same 16 px rhythm as its outer inset.
  The middle sidebar content scrolls as one region. Today keeps its heading, frames the schedule and
  gives Boost an attached secondary action row.
- Settings uses compact modes, plain section navigation and a narrow section selector. Choice labels,
  values and selection indicators align without an extra selection-only row.
- People and Prune share 24 px page gutters and 16 px content insets. Source details use dividers
  inside their existing panel. Long explanations wrap, while account handles may truncate deliberately.
- Growth charts measure the plot's CSS width and keep a fixed 180 px height. Widening the window no
  longer enlarges the chart's type. Absent history remains distinct from a measured flat series.
- Prune's census uses five metrics or a balanced three-plus-two arrangement. An unknown census is an
  explanation, without empty metric tiles. List controls align with the surrounding content.
- Graph starts with a compact legend that can be expanded. Its body scrolls independently, keeping
  collapse and help reachable; empty and unavailable graphs have no competing legend. Navigation
  gives each page equal space and suppresses the secondary graph count when the stage is narrow.
- An empty source has one explanation below its trail, rather than three otherwise empty subsections.
  Populated source metrics retain their individual sections.

## Evidence and acceptance

Durable evidence lives in
`~/.claude/projects/-Users-owengregson-Documents-Peanut/overhaul-handoff-2026-11-03/results/codex-design-cleanup/`.
The independent `audit.md` records the baseline findings and the visual review rubric. It is not an
approval of the cleanup. `shared-first/` and `settings-first/` are intermediate captures, retained to
show what the next inspection changed. Their passing overflow checks do not mean their design passed.

The cleanup review covers rendered sidebar postures, every Settings section, People,
Prune, Graph, the actual stage navigation, dialogs, placeholders and the tour. The review checks
hierarchy, balanced insets, useful space, alignment, complete labels and consistent states. Narrow and
short windows are reviewed alongside normal and wide layouts, with normal and reduced motion.

## Review-driven corrections

The first inspection still found a narrow choice-grid collision, recommendation-only empty rows,
quiet-hours padding compounding, repetitive Timing prose, faint schedule markers and a mismatched
sticky activity background. These were corrected and captured again. Timing now shares its common
constraint explanation, while each input retains accessible guidance, recommended value and range.
Its section height decreased from 6,207 to 3,853 px in the narrow fixture and from 4,514 to 3,605 px
at the standard width. Prune separates immediate-run progress from gradual cleanup and avoids
repeating the same counts inside its Run card.

The broader surface review also found a real Tour focus race: Chromium refuses focus while a new
highlighted card is hidden awaiting its anchor measurement. Focus now waits for the current step's
measured anchor, without stealing it during later geometry tracking. A chart resize during its reveal
could likewise restore the old clip endpoint; completion now reads the current endpoint. Both have
regressions demonstrated failing before their fixes.

The next rendered review caught Graph's legend covering the empty message and clipping its own help,
and a six-digit graph count crowding navigation. Those were corrected and recaptured. A separate
native keyboard check then showed that the Tour still lost focus after advancing, despite the gallery
focus assertion passing. Chromium still computed inherited visibility as hidden during the layout
effect, including a lazy Settings transition. The handoff now waits for actual visibility, stops after
focus is established, and cancels on step change or close. Tab and Shift-Tab stay inside the card.

Diagnostics now keeps its filter/search and action groups together when wrapping. Its section tracker
observes section owners rather than a nested duplicate marker, and recognizes the final section at
the bottom of the page. The census fixture also initially confused raw candidates with the actionable
run total, making an idle meter appear started. Tracing the producer confirmed the production meter
was correct; only the fixture needed correction. Visited progress remains distinct from successful
unfollows, including skipped and practice-mode work.

Normal-motion capture also reproduced retained overflow from a finished stage entrance, despite every
child fitting its viewport. Releasing the animation's forward fill restores the ordinary transform;
the same Chromium probe changed from overflow to exact viewport width. Boost's preview initially
clamped over its own trigger in a short window. It now uses the shared anchor placement to flip fully
above the button when needed, preserving an 8 px gap and its scroll/resize dismissal.

## Verification

- Normal motion at `e0b3dc4`: 19 representative scenarios across five window sizes, **95 checks**,
  no geometry failures, renderer errors or unexpected network requests. This precedes the final
  marker contrast, Prune composition, Settings and Tour follow-ups.
- Combined reduced motion at `e13c43f`: all 63 existing scenarios across 1024×640, 1024×920,
  1280×720, 1440×920 and 1920×920, **315 checks**, no failures/errors/blocked requests.
  Easy and Advanced also have continuous section captures at each size. This precedes the Tour
  focus repair and final gallery coverage additions.
- The initial `surfaces-first/` run intentionally remains as failed evidence: it found the Tour focus
  race and could not exercise Boost focus in its hidden window. It is not final acceptance.
- Focused source tests passed for Prune, chart resizing, Settings saves/navigation/timing controls,
  sidebar postures and Tour measurement/focus. The combined full gate is the final authority.
- Full gate at `4f74b52`: **433 suites / 4,436 tests passed**, one suite and five tests skipped;
  generated targets/tokens, TypeScript, lint, page freshness and development build passed. Boundaries
  remained **0 errors / 56 warnings**. Follow-up source changes require another gate.
- Integrated normal motion at `5613210`, `combined-normal-verified/`: **30 checks** over six scenarios
  at the same five sizes, including continuous Easy/Advanced sections and the corrected empty source.
  No failures, errors or unexpected requests. The separate `settings-schedule-verified/` check confirms
  the rail and narrow selector both identify Schedule after scrolling settles at 1024 and 1440 px.
  This precedes only the final open-Boost-preview placement change.
- `surfaces-normal-verified/` and `surfaces-reduced-verified/` each passed 62 checks at `5613210`.
  Their original geometry checks did not detect the Boost trigger overlap; those runs do not qualify
  that interaction. The final surface runs add an explicit no-overlap and gap assertion.

Native CUA replay at `05fe51a`, in a fresh signed-out profile with network blocked and reduced motion,
passed all eight steps with Return, both Tab boundaries, the visible starting-account target with Next
focused, Finish, the Settings shortcut, search-result placement and clean quit. No manual refocusing
or developer-tools intervention was needed in this final run. Separate Chromium real-input traces
cover both normal and reduced motion; synthetic gallery keys alone are not the native-focus evidence.

Final source `17d2d01` passed the complete gate: **435 suites / 4,445 tests**, one suite and five tests
skipped, zero TODO. Generated targets/tokens, TypeScript, lint, page freshness and development build
passed. Boundaries remain **0 errors / 56 warnings**. Full log: `final-gate-4/Peanut.log`.

At that source, `surfaces-normal-complete/` and `surfaces-reduced-complete/` each passed **62 checks**
at 1024×640 and 1440×920, plus the deliberately shorter Boost stress viewport. There were no geometry
failures, renderer errors or unexpected requests. Coverage includes Graph's empty/populated/recovery
states and scrollable legend, census/protected rows, Diagnostics and its current-section mark, stage
counts, loading/offline Live, three confirmations, all eight tour steps, activity expansion/bottom,
and Boost placement/dismissal. At both widths the final preview ends exactly 8 px above its trigger,
with no overlap. These final surface runs supersede the earlier failed or incomplete overlay evidence.

The independent `review-pass-two.md` enumerates 54 newly inspected images, alongside the earlier
audit: 28 normal surface images, eight reduced-motion samples, 16 combined Settings/empty-source
images and two final Boost images. The lead separately inspected integrated Settings at both widths,
empty source, census, Graph, Diagnostics, confirmations, native tour/search and final Boost placement.
No unresolved visual defect remains in that inspected scope. This is technical and agent review;
the owner's visual judgment is separate and has not been assumed.

All QA used synthetic gallery data or fresh signed-out profiles. The real Epo profile and account
were not opened, copied or exercised. Live account checks remain paused under the existing handoff.
