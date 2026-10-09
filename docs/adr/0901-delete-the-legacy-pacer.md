# 0901 — Delete the legacy pacer (deletion list; wave B)

**Status:** proposed — deletion scheduled for wave B · **Area:** engine, settings,
renderer, main
**Refines:** ADR 0202 (pacing models), which already says removing it is "a
one-file change plus a settings key". This ADR is the audited version of that
claim: it is four files plus six settings keys, and three of the things the
ideation expected to delete do **not**.

## Context

Two pacing models ship. The organic model (circadian sessions, log-normal gaps,
a daily-volume draw) is the default and the only one the personas, the day-shape
preview and the derived constants describe. The legacy model is a flat
active-hours window plus an operating-rate metronome; `consistency: clockwork`
with narrow bumps reproduces it inside the organic model, so it earns nothing.

It costs: a second gating path in the conductor, a `pacingModel` selector in the
settings UI that greys out seven other knobs, five numeric settings keys that
only it reads, and a whole `EngineRate` sub-surface (`withinActiveHours`,
`atOperatingRate`, `nextDelayMs`) kept alive for one caller.

## Decision (this wave)

**Do not delete yet — isolate.** The deletion crosses settings persistence, the
IPC settings payload and a renderer card, which are three other agents' files
this wave. Instead, wave A confined the model so the deletion is mechanical:

- Gating is now the pure `legacyVerdict()` in `src/engine/pacers.ts`, reached
  through the single `pacing` rule in `src/engine/rules.ts`. Nothing else in the
  conductor branches on the model.
- Which model is in force is a FACT (`PacingFacts.model`), not a class the loop
  holds. `LegacyPacer` survives only to answer "what gap is owed after an
  action?".

## The deletion list (wave B), audited

### Delete outright

| Where | What |
|---|---|
| `src/engine/pacers.ts` | `legacyVerdict()`, `LegacyPacer`, the `'legacy'` arm of `pacingVerdict` |
| `src/engine/decisions.ts` | `msUntilActiveWindow()` — its only caller is `legacyVerdict` |
| `src/engine/engine-waits.ts` | wait key `'engine:active-hours-park'` + its `ENGINE_WAIT_CLASS` row; park reason `'active-hours'` + its `PARK_REASON_BY_KEY` row |
| `src/engine/facts.ts` | `PacingFacts.model`, `PacingFacts.activeHoursStart`, `LedgerFacts.atOperatingRate` |
| `src/engine/engine.ts` | the `planner === undefined` branch of the `pacing` fact source |
| `src/engine/ports.ts` | `EngineRate.atOperatingRate`, `EngineRate.nextDelayMs`; `EngineDeps.pacing` becomes REQUIRED (its absence is the only thing that selects legacy) |
| `src/engine/ports.ts` | `StepResult` member `'waited-active-hours'` |
| `src/settings/settings.ts` | keys `pacingModel`, `minDelayMinutes`, `maxDelayMinutes`, `jitterPercent`; the `AT_MOST` pair `['maxDelayMinutes','minDelayMinutes']`; the three `minDelayMs`/`maxDelayMs`/`jitterPercent` mappings into `RateGovernorConfig` and the prune config |
| `src/renderer/cards/settings/BehaviorCard.tsx` | `PACING_OPTIONS`, `pacingModelHint()`, the "Pacing" `Field`, the `adaptive` flag, `ADAPTIVE_ONLY_KNOBS`, `ADAPTIVE_ONLY_NOTE`, the `gated` branch in `renderKnob`, and the "steady N–M min intervals" summary line |
| `src/renderer/lib/strategy-presets.ts`, `src/renderer/gallery/fixtures.ts` | their `pacingModel` entries |
| `src/main/services/graph-builder.ts` | the `settings.pacingModel === 'organic'` conditional — the planner is always built |
| `src/livetest/steps.ts`, `src/tools/readme/live-charts.ts` | their `pacingModel` / active-hours references |
| tests | `tests/engine/pacers.test.ts` "legacy" describe; the `msUntilActiveWindow` describe in `decisions.test.ts`; the legacy paths in `engine.test.ts`, `tests/main/foundation-pacing.test.ts`, `tests/main/sleep-resume.test.ts`, `tests/renderer/behavior-pacing.test.ts`, `tests/settings/settings.test.ts`, `tests/main/ipc-guards.test.ts` |

### Do NOT delete (the ideation expected these to go; they do not)

- **`activeHoursStart` / `activeHoursEnd`.** They no longer gate anything, but
  they still define the **daily cycle boundary**: `RateGovernor.cycleStartMs()`
  and `msUntilCycleReset()` use them, the organic model's `daily-ceiling-park`
  parks to that boundary, and `pruneCycleStart()` shares it so an overnight
  window's post-midnight tail spends the cycle it belongs to. Wave B should
  **demote them to one derived "day boundary hour"** rather than delete them —
  and that is a behaviour change (an overnight window's cycle moves), so it
  needs its own decision.
- **`src/timing/cycle-plan.ts`.** `cyclePlan()` also produces `plannedToday()`
  (the organic status surface) and `pruneDailyPlan()`. It stays.
- **The `daily-boundary` noise class.** `engine:daily-ceiling-park` keeps it.
  Only `engine:active-hours-park` leaves.
- **`EngineRate.withinActiveHours`.** The PRUNE run loop still truncates at the
  active-hours edge (`PruneEngineDeps.withinActiveHours`). It leaves only when
  prune becomes a mode of the conductor (ADR 0902) and inherits the session gate.
- **`EngineStatus.plannedToday` / `remainingToday`.** The Rate & Safety card and
  the growth chart read them in both models.

## Consequences

- Net: 1 wait key, 1 park reason, 1 `StepResult` member, 4 settings keys, 2
  `EngineRate` members, ~90 lines of engine code, and one settings `Field` with
  its seven-knob greying rule.
- `EngineDeps.pacing` becoming required removes the last "which model am I on?"
  branch in the Engine, and the last optional dep that changes *behaviour* rather
  than wiring.
- Blocked on the owner's answer to open question 6 of the v4 design ("Delete the
  legacy pacing model?"), because it removes user-visible settings.
