# Live counts + slot-machine tickers + scroll reset + Humanizer — design

Date: 2026-08-13 · Branch: `feat/live-counts-humanizer`

Coordination constraint: a parallel branch is refactoring timing
(`src/timing/` — sleep/DelayPolicy/DelayManager) and touches
`engine.ts`, `prune-engine.ts`, `actor.ts`, `followers-page-reader.ts`,
`profile-enricher.ts`, `foundation-wiring.ts`, `connectivity.ts`, and renderer
hooks. Everything here therefore prefers NEW files; edits to those shared files
are minimal and additive (new optional fields/callbacks, new branches), and no
delay/sleep computation code is changed — the Humanizer keeps its own local
sleep + randomized timing that the merge can later unify onto `src/timing/`.

## 1 · Live mid-scrape counts

Today `PruneEngine.performScan` only learns counts AFTER each whole-list scrape
resolves, so the UI shows 0/0 for minutes on a large account. Additive pipeline:

- `FollowersPageReader.collect` gains an optional `onProgress?(observedCount)`
  on `CollectArgs`, invoked whenever the observed pk set GROWS (once per parsed
  page, not per user — a page is the natural batch).
- `PruneScanOpts` (in `prune-engine.ts`) gains optional `onProgress?(n)`;
  `own-following-source.ts` / `own-followers-source.ts` `fetchAllPks(opts)`
  thread it into `collect` (one new line each).
- `performScan` passes phase-specific progress callbacks that update
  `followingCount` / `followersCount` incrementally and call a new
  `emitStatusThrottled()` (~4 emits/sec max via `clock.now()`, so the IPC
  stream is never flooded; the existing end-of-scan `emitStatus()` still fires
  unconditionally so the final numbers always land).
- Renderer: `PruneScanCard` prefers the LIVE pushed projection while
  `state === 'scanning'` (the cached session scan otherwise masks it).

Growth path: the growth engine's status projection (`EngineStatus`) carries no
mid-scrape counter field, and adding one means editing `engine.ts` +
`foundation-wiring.ts` status plumbing — both mid-refactor on the timing
branch. Deferred as a follow-up (noted in the report); the overview's headline
numbers still animate via NumberTicker whenever status pushes change them.

## 2 · NumberTicker (slot-machine digits)

- `src/renderer/ui/NumberTicker.tsx` — value formatted with `commas()` (plus an
  optional signed prefix), split into columns keyed FROM THE RIGHT so the units
  digit is always the same column (rolling reads correctly on count-ups).
  Each digit column is a vertical reel of 0–9 shifted with
  `transform: translateY(-N em)` and a ~420 ms transition on the shared `EASE`
  curve; separators (`,`, `+`, `-`) are static spans. Under
  `prefersReducedMotion()` it renders plain text (instant swap).
- Pure column math lives in `src/renderer/lib/ticker.ts` (unit-tested under
  the node jest env, which cannot render DOM).
- Styles appended to `primitives.css` (`.nt`, `.nt-reel`, `.nt-sep`) — em-based
  so the ticker inherits any tier (`.g-num`, `.stat .v`).
- Adopted: Prune scan stats (Following / Followers / Not following back),
  GrowthCard headline net total, LiveStatus "Net today" + "Actions today".

## 3 · Scroll reset on view open

The scroll container is each mounted `.view` section (`overflow-y: auto`,
`id="view-<key>"`). New hook `src/renderer/hooks/useScrollReset.ts`: an effect
on the active `ViewKey` that sets that section's `scrollTop = 0`. Wired with
one added line in `App.tsx` (`useView.ts` itself is left untouched — the timing
branch edits renderer hooks).

## 4 · Humanizer

New package `src/humanizer/` making synthetic input indistinguishable from a
human: real trusted OS-level events via `webContents.sendInputEvent`, never
`el.click()` / `scrollTop =` when a Humanizer is wired.

- `motion-profile.ts` — PURE math, injectable rng, fully unit-tested:
  - `cursorPath(from, to, rng)` — quadratic-Bezier path with a small
    perpendicular arc, optional overshoot-and-settle past the target, per-step
    gaussian jitter; ends exactly on the target.
  - `pathTimings(...)` — total duration from a Fitts's-law model
    `T = a + b·log2(D/W + 1)` with gaussian noise; per-step delays ease-out
    (fast mid-flight, slowing on approach).
  - `clickPoint(rect, rng)` — 2D gaussian around a point slightly off-center,
    clamped to an inner margin of the rect (never exact center, never edges).
  - `scrollTicks(deltaPx, rng)` — wheel-tick plan: deltas accelerate then
    decay, occasional micro-pauses, slight over-scroll with corrective
    back-ticks, total ≈ requested ±5 %.
  - `holdDurationMs(rng)` — 40–120 ms press.
- `input-driver.ts` — `InputDriver` port (`mouseMove/mouseDown/mouseUp/wheel`)
  + `ElectronInputDriver` over a minimal `{ sendInputEvent }` sink; tests use a
  recording fake. Wheel deltas use DOM semantics (positive = content down) and
  the Electron impl negates for `sendInputEvent`.
- `humanizer.ts` — facade `Humanizer` with `moveTo`, `click(rect)`,
  `scroll(rect, deltaPx)`; tracks the virtual cursor position; own local sleep
  (injectable) — deliberately NOT the engine sleep helpers (timing-branch rule).
- Integration (all additive):
  - `tab.ts`: new `sendInputEvent(event)` method exposing the view's
    webContents (the tab stays the only Electron-touching layer).
  - `versions/2026-08-12.ts` + `IgSurface`: new OPTIONAL locate-script builders
    (`locateActionButtonScript`, `locateConfirmUnfollowScript`,
    `locateFollowersStatScript`, `locateFollowingStatScript`,
    `locateScrollContainerScript`) that find the SAME elements as the existing
    click scripts but return `getBoundingClientRect()` rects (and, for the
    action button, its state + would-click/needs-confirm decision) WITHOUT
    clicking. Existing click scripts untouched.
  - `actor.ts`: optional `humanizer` in `ActorOptions`; four tiny private
    helpers route each click/scroll site through locate-script + Humanizer when
    both the humanizer and the surface's locate script exist, else the
    unchanged JS-click path. No restructuring of existing flow.
  - `foundation-wiring.ts`: construct `Humanizer(new ElectronInputDriver(tab))`
    next to `InstagramAdapter` and pass it into the adapter → actor (additive
    optional ctor arg on `InstagramAdapter`).

Every randomized range carries a justification comment; all randomness flows
through one injectable rng so tests are deterministic.

## Tests

- `tests/rim/followers-page-reader.test.ts` — onProgress emission (+ sources).
- `tests/engine/prune-engine.test.ts` — incremental counts + throttled emits.
- `tests/renderer/ticker.test.ts` — column math.
- `tests/humanizer/motion-profile.test.ts` — path endpoints/monotonicity,
  click-point bounds/distribution, scroll-tick sums, hold bounds.
- `tests/humanizer/humanizer.test.ts` — event sequences via the recording
  driver (move → down → hold → up; wheel bursts inside the rect).
- `tests/adapter/actor-humanizer.test.ts` — humanizer-routed clicks + JS
  fallback unchanged.

## Merge hazards for the timing branch

- `prune-engine.ts`: new `onProgress` field on `PruneScanOpts`, new private
  `emitStatusThrottled` + `lastProgressEmitAt` — keep both when merging.
- `followers-page-reader.ts`: new optional `onProgress` arg + one call site in
  the parse closure.
- `actor.ts`: new optional `humanizer` + private helpers; the existing
  `sleep`/`waitFor` untouched — the timing branch may replace them freely.
- `foundation-wiring.ts`: Humanizer construction is 3 additive lines near the
  adapter.
- Humanizer sleeps/randomized delays are self-contained in `src/humanizer/`;
  unify onto `src/timing/` primitives after the merge.
