# Background runtime QC — 2026-09-21

> Update (2026-10-21): the global `disable-frame-rate-limit` workaround below
> caused dashboard stutter and is now confined to the Instagram renderer.
> See [the rendering investigation](render-pacing-2026-10-21.md). These
> historical measurements are not instructions to restore the global switch.

The executable fixture is `scripts/background-probe.mjs`. It bundles the actual
`InstagramTab`, `createTabInteractor`, WindMouse implementation, CDP transport,
click guards, startup switches, and `RuntimePower` from this checkout. It uses
a temporary Electron userData/sessionData directory and a loopback HTTP server.
Requests from the tab to any other origin are refused. It does not load an
Instagram account or perform any account actions.

## Measured result

**PASS: nine scenarios**, macOS 26.3 / Darwin 25.3.0 arm64, Electron 44.1.1,
Chromium 152.0.7977.65. All 72 clicks, 2,204 pointer moves, and 39 wheel events
were trusted. All 72 clicks received asynchronous rAF-plus-timer acknowledgments.
Every scenario scrolled the intended container. Maximum main-process timer gap
was 36.82 ms; maximum input acknowledgment latency was 37.63 ms.

| Native state / operation | Duration (s) | rAF frames/s | Trusted clicks |
| --- | ---: | ---: | ---: |
| Foreground | 7.400 | 60.81 | 8 / 8 |
| Occluded and unfocused | 7.138 | 61.64 | 8 / 8 |
| Minimized | 8.203 | 59.98 | 8 / 8 |
| Window hidden | 7.364 | 60.56 | 8 / 8 |
| macOS app hidden | 7.736 | 61.53 | 8 / 8 |
| Tab concealed by dashboard | 7.751 | 60.38 | 8 / 8 |
| Navigation while hidden | 8.029 | 60.53 | 8 / 8 |
| Recovery while hidden | 8.349 | 60.13 | 8 / 8 |
| Hidden soak, gestures before and after 330 seconds | 333.404 | 56.83 | 8 / 8 |

The soak produced 18,947 animation frames and 13,336 timer ticks. The window
remained natively hidden and unfocused, and the second gesture batch arrived
after the full 330-second wait. Raw measurements, window state, identity and
bundle SHA-256: [full report](background-runtime-2026-09-21.json).

After the page-helper isolation and measured renderer-health canary were
integrated, a second run rebuilt the latest source and rechecked hidden
navigation and recovery. Both passed in 7.20 and 7.42 seconds, with 16/16 trusted
clicks and all four before/after health checks healthy. Raw latest-bundle
measurements: [final canary report](background-runtime-final-canary-2026-09-21.json).

The JavaScript and HTTP UA agree on the native Chromium version. UA client hints
retain the native macOS/Chromium/GREASE values and arm64 architecture; the HTTP
language preferences match `navigator.languages`. No forged device values were
needed. `navigator.webdriver` remained the native value (`false` in this runtime).

## Reproduce

```sh
node scripts/background-probe.mjs --soak-ms 330000 --output docs/qa/background-runtime-2026-09-21.json
```

For the shorter final-bundle check:

```sh
node scripts/background-probe.mjs --only hidden-after-navigation,hidden-after-recovery --output docs/qa/background-runtime-final-canary-2026-09-21.json
```

This opens local native windows to measure foreground, occluded/unfocused,
minimized, window-hidden, macOS app-hidden, concealed stage, hidden navigation,
hidden recovery, and a 5.5-minute hidden soak. Each scenario sends eight actual
Interactor clicks, WindMouse travel, and scrolling. Half the gestures happen
after the waiting period, so the long soak verifies input after prolonged
backgrounding. The page acknowledges clicks only after an animation frame and
a timer, modeling the asynchronous page work a received click still requires.
The fixture's embedded tab starts at a nonzero host offset (110, 90), checking
that CDP coordinates remain relative to the target viewport.

The JSON records the runtime versions, compiled bundle SHA-256, native window
state, page visibility/focus, frame and timer counts, maximum timer gaps,
trusted input counts, asynchronous acknowledgments, scroll progress, and
HTTP/JavaScript browser identity. Its three click-guard checks establish that
the original node is accepted while a same-position replacement or covering
element is refused. `--only stage-hidden` runs that one production scenario.

## Regressions found by running Electron

1. **Cold renderer startup deadlocked on debugger setup.** Waiting for CDP
   readiness before the first `loadURL` left the setup commands without a
   started renderer and timed out after 15 seconds. Navigation now starts the
   renderer before waiting for debugger setup to finish.
2. **Native `WebContentsView.setVisible(false)` stalled production gestures.**
   Renderer evaluation, rAF, and timers remained live, but production pointer
   gestures failed to finish before the 90-second probe deadline in two runs.
   An opaque full-window sibling above the still-visible native tab completed
   eight trusted clicks, 236 trusted pointer moves, four trusted wheel events,
   and eight asynchronous acknowledgments in 6.777 seconds. Production now
   conceals the tab by sibling ordering (`TabPlacement`) and restores its
   original layer, keeping its viewport and native visibility intact.
3. **Hidden navigation and reload reintroduced a compositor throttle.** The
   original switches kept JavaScript timers near 40 Hz, but after navigating
   while hidden the measured rAF rate fell to approximately 1.5 fps. Eight
   production gestures took 193.45 seconds after navigation and 208.32 seconds
   after recovery. Individual mouse acknowledgments clustered near one second.
   Refreshing background throttling or focus emulation, subscribing to frames,
   disabling MacWebContentsOcclusion, and a one-pixel resize did not repair it;
   one-pixel captures timed out. A Darwin-only `disable-frame-rate-limit` switch
   repaired the measured failure. The full run's navigation and recovery
   scenarios then completed in 8.03 and 8.35 seconds, around 60 fps, with maximum
   input acknowledgment delays of 37.06 and 36.43 ms. This timing is consistent
   with compositor throttling; the experiment does not isolate every Chromium
   layer affected by the switch. The switch can increase rendering power use:
   this fixture showed no runaway frame rate, but it is not an Instagram battery
   benchmark.
4. **A restore/hide sequence can invalidate the test itself.** On macOS, hiding
   immediately after restore could be undone when the restore animation
   completed. The fixture waits for that transition and asserts the measured
   native state; scenario names alone are not treated as evidence.

## Runtime lifecycle

The existing three startup switches, `backgroundThrottling: false`, CDP-only
input, and CDP focus emulation remain, with the measured macOS compositor
workaround above. `RuntimePower` now owns the
`prevent-app-suspension` assertion instead of discarding its ID. It checks and
reacquires the assertion after resume, coalesces repeated suspend events,
detaches power listeners before graph disposal, consumes wake-sequence
rejections, and releases the owned assertion after teardown. It intentionally
keeps the assertion during quiet periods: pending durable schedules must still
wake the engine. It never requires a display-sleep blocker or foreground focus.

`tests/main/runtime-power.test.ts` covers ownership/idempotence, duplicate
suspend handling, lost assertion reacquisition, and a rejected wake sequence.
It and the existing five sleep/resume tests pass (nine total).

## Sources and limits

- Electron documents that disabling `backgroundThrottling` affects page
  timers, animations, visibility, and frame presentation for the host window.
  [WebPreferences](https://www.electronjs.org/docs/latest/api/structures/web-preferences)
- Electron's ordinary `sendInputEvent` requires host focus. The production
  path continues to use CDP, whose mouse coordinates are viewport-relative.
  [webContents](https://www.electronjs.org/docs/latest/api/web-contents#contentssendinputeventinputevent),
  [CDP Input](https://chromedevtools.github.io/devtools-protocol/tot/Input/#method-dispatchMouseEvent)
- CDP focus emulation simulates an active, focused page. It is separate from
  actual OS window focus, and the report records both.
  [CDP Emulation](https://chromedevtools.github.io/devtools-protocol/tot/Emulation/#method-setFocusEmulationEnabled)
- `prevent-app-suspension` allows display sleep while keeping the application
  and system active; its returned ID identifies the assertion to stop.
  [Electron powerSaveBlocker](https://www.electronjs.org/docs/latest/api/power-save-blocker)
- Electron emits system suspend/resume events, which remain routed to the
  Foundation's existing freeze and ordered wake/revalidation policy.
  [Electron powerMonitor](https://www.electronjs.org/docs/latest/api/power-monitor)
- An idle-system-sleep assertion cannot guarantee execution through lid close,
  explicit system sleep, or low-battery sleep.
  [Apple power assertions](https://developer.apple.com/documentation/iokit/kiopmassertiontypepreventuseridlesystemsleep)
- The long soak exceeds the historical five-minute intensive timer-throttling
  threshold. This is a regression check on the recorded Electron/Chromium
  runtime, not a claim that every Chromium version uses that threshold.
  [Chrome timer throttling](https://developer.chrome.com/blog/timer-throttling-in-chrome-88)
- Electron's implementation separately updates renderer scheduler state and
  native renderer visibility; Chromium's compositor can also reduce begin-frame
  delivery when submitted frames remain undrawn. These are independent from
  JavaScript timer progress, which is why the fixture measures all three layers.
  [Electron 44.1.1 implementation](https://github.com/electron/electron/blob/v44.1.1/shell/browser/api/electron_api_web_contents.cc#L2495),
  [Chromium compositor implementation](https://chromium.googlesource.com/chromium/src/+/main/components/viz/service/frame_sinks/compositor_frame_sink_support.cc)
- The selected flag disables begin-frame limiting and implies disabling GPU
  vsync. Blink selects a renderer-local back-to-back frame source, which explains
  the observed escape from externally throttled frame delivery (an inference
  from the source and experiment). It also relaxes outstanding-frame
  backpressure; 60 fps in this fixture is not a guaranteed cap. Increased
  CPU/GPU work and battery use are a material tradeoff of this macOS workaround.
  [Pinned Chromium switch](https://raw.githubusercontent.com/chromium/chromium/152.0.7977.65/components/viz/common/switches.cc),
  [frame-source selection](https://raw.githubusercontent.com/chromium/chromium/152.0.7977.65/third_party/blink/renderer/platform/widget/widget_base.cc),
  [scheduler](https://raw.githubusercontent.com/chromium/chromium/152.0.7977.65/cc/scheduler/scheduler_state_machine.cc)

This is a local macOS arm64 integration test. It does not establish equivalent
results on Windows/Linux, display-off behavior, physical sleep/resume,
network loss, thermal throttling, renderer crashes, or Instagram server/UI
behavior. No claim of universal availability or undetectability follows from
trusted event delivery. Forced sleep suspends execution; wake recovery is the
appropriate guarantee at that boundary.
