# Dashboard stutter and frame pacing — 2026-10-21

## Reproduction and cause

The user reported device-wide lag and especially slow left-sidebar tab changes
when launching with `npm run start`. Gallery previews appeared smooth, so they
were insufficient to validate the reported failure. The user confirmed the lag
in the actual production launch, then confirmed that the same launch was smooth
after the scoped fix, with their existing Instagram session loaded.

`applyBackgroundSurvivalSwitches()` appended `disable-frame-rate-limit` globally
on macOS. This propagated to the dashboard, Instagram and veil renderers and
implicitly disabled GPU vsync in the shared GPU process. Sidebar transitions
could generate work far faster than the display could present it. The GPU
process command line in the production launch included `--disable-gpu-vsync`;
after the fix it no longer did, and only Instagram's renderer retained
`--disable-frame-rate-limit`.

The global switch had fixed a real but separate background-navigation failure:
simply removing it made hidden-page CDP mouse acknowledgments take about a
second each. The local input fixture reproduced that regression. Disabling
GPU vsync alone and a tiny CDP screencast did not repair it.

## Fix

Remove `disable-frame-rate-limit` from the application-wide switches. Pass it
through `InstagramTab`'s `webPreferences.additionalArguments` on macOS only.
This retains the renderer-local frame source needed for hidden navigation,
while leaving dashboard/veil rendering and the shared GPU compositor paced.
Keep the existing timer, native visibility, focus and power policies.

There are no changes to the interface's appearance, animations, routing or
account operations.

## Measurements

Local runtime: Electron 44.1.1 / Chromium 152.0.7977.65, macOS arm64, 120 Hz
display. Diagnostic animation-callback counts below measure work scheduled,
**not frames actually presented**. The probes deliberately keep rAF active to
measure pacing; the manual production check above validates the visible result.

| Diagnostic workload | Global workaround | Normal dashboard pacing |
| --- | ---: | ---: |
| Dashboard, callbacks/s | 2,667 | 120 |
| Dashboard + veil, callbacks/s | 1,633 | 120 |
| GPU-process CPU, dashboard + veil (Electron metric) | 26.74% | 3.03% |
| Instrumented full app, 12 sidebar presses with Instagram loaded, worst callback gap | 211.6 ms | 9.4 ms |
| Same full-app sequence, callback gaps over 33 ms | 7 | 0 |

The initial A/B probes restored global pacing to isolate the cause. The final
fix additionally retains Instagram's local workaround; the background probe
and the user's actual `npm run start` check exercise that final configuration.
Measurements are local samples, not guarantees of a particular frame rate on
every machine or under every Instagram workload.

## Regression checks

- `tests/main/render-pacing.test.ts` guards the scope on macOS, Windows and
  Linux: application startup never disables frame limiting or GPU vsync;
  only the macOS Instagram view receives the renderer switch.
- 246 tests passed across renderer behavior, tab health/placement, runtime
  power, the new pacing guard and the source line budget.
- Type checking and production build passed. Biome checks passed for the
  bootstrap and new test.
- `scripts/background-probe.mjs` now checks an animated dashboard's maximum
  callback rate as well as the tab's minimum progress and acknowledged input.
  The old test only checked liveness, so unlimited rendering could pass it.
- Final local input report: `render-pacing-2026-10-21.json`. All eight scenarios
  passed, including minimized/hidden windows, a covered tab, hidden
  navigation and recovery. Every scenario checks eight trusted clicks and
  their asynchronous acknowledgments, scrolling and renderer/main timers.
  Dashboard pacing measured 120.27 callbacks/s; all 64 clicks and asynchronous
  acknowledgments arrived; the slowest input acknowledgment was 35.65 ms.
- Reinstating the global switch in the isolated probe correctly failed the
  new guard: 1,023.04 dashboard callbacks/s versus the 150.00 upper bound for
  this display. Input liveness still passed, reproducing the old test's blind
  spot. This expected failure is not a failure of the corrected configuration.

Reproduce without touching an account:

```sh
node scripts/background-probe.mjs --output /tmp/epo-pacing.json
```

To verify that the new pacing check detects the original configuration, append
`--disable-frame-rate-limit --only foreground`; dashboard pacing must fail even
though input liveness passes. Use this flag only in the isolated probe.

The previous five-minute background soak was not repeated for this change.
Windows/Linux and forced system sleep are not covered by the macOS integration
run; platform selection is covered by the unit tests.

## Runtime references

- [Pinned Chromium switch definition](https://raw.githubusercontent.com/chromium/chromium/152.0.7977.65/components/viz/common/switches.cc):
  disabling frame limiting also disables GPU vsync.
- [Pinned Blink frame-source selection](https://raw.githubusercontent.com/chromium/chromium/152.0.7977.65/third_party/blink/renderer/platform/widget/widget_base.cc):
  renderer-local frame-source selection explains why the narrower workaround
  can preserve hidden input; the local integration results verify that behavior.
- [Electron WebPreferences](https://www.electronjs.org/docs/latest/api/structures/web-preferences):
  `additionalArguments` belongs to the renderer process.
