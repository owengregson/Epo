# 0306 — Acknowledged gestures and stable browser identity

**Status:** accepted · **Area:** adapter, interaction, shell · **Date:** 2026-09-21

Amends ADRs 0305 and 0805. A gesture used to enqueue synchronous events and
finish before Chromium had accepted them. A stalled transport could accumulate
events, lose a click silently, or replay old coordinates after navigation.

## Decision

Every production caller uses `createTabInteractor`, including capture, live
verification and early identity resolution. CDP remains the only pointer input
transport. Each event is acknowledged before the next event is emitted; a
deadline bounds each dispatch. Navigation, resizing, recovery, detachment and
teardown invalidate the gesture's context. Stop/Pause aborts travel and scrolling.
An accepted press is completed atomically on the same context so the button is
not left held; uncertain press/release acknowledgements use the existing
`TabUnresponsiveError` post-click classification, requiring re-observation.

The gesture captures a CDP remote reference to the original hit control before
travel. Immediately before pressing, it checks that the same connected element
is still the top hit at the planned point, with the expected rectangle and
enabled state. Replaced rows, movement and overlays stop the press. The remote
reference is released after every gesture. CSS coordinates retain fractional
precision, and trajectories remain within the current CSS viewport. Input and
observation are separate: a failing cursor overlay cannot interrupt release.

WindMouse supplies correlated wind, gravity, inertia and terminal damping.
Named policy bounds constrain path length, event spacing, endpoint accuracy and
velocity. Motion timing uses actual segment distances; constraints can lengthen
a duration. These bounds are engineering choices, not measurements of a human
population. The implementation and empirical comparison are documented in
`../qa/motion-2026-09-21.md`.

The first navigation must start before awaiting CDP readiness: a fresh
WebContentsView may not service setup commands until a renderer exists. Recovery
does not clear health marks until reload and debugger setup both finish.

## Background view concealment

Native `WebContentsView.setVisible(false)` retained page timers but stalled
acknowledged cursor input for over 90 seconds in the Electron 44 macOS fixture.
The tab is now concealed by moving it below the existing opaque dashboard in
the sibling view stack. Revealing restores its original position below the
activity veil. Its dimensions and native visibility remain intact. Preserve
the opaque full-window dashboard when changing shell layout.

All pre-existing background layers remain: pre-ready Chromium switches,
`backgroundThrottling: false`, CDP focus emulation and an owned
`prevent-app-suspension` assertion. RuntimePower explicitly owns the power
listeners and assertion through teardown. Forced sleep still requires the
existing suspend/resume recovery sequence.

Electron 44 on macOS also throttled rendering after hidden navigation despite
live timers. A Darwin-only `disable-frame-rate-limit` startup switch repaired
the measured input stalls. It can increase rendering power use; the runtime
report documents both the comparison and the five-minute regression probe.
The renderer canary now evaluates frames per actual elapsed time against a
named 10 fps engineering threshold and retires its callbacks on completion.
A single delayed frame is insufficient evidence of a responsive renderer.

## Browser identity

The runtime user agent comes from native Chromium, preserving its actual
version and OS and removing shell product tokens. Session and WebContents use
the same string. Accept-Language uses native preferred system languages.
Random browser versions, platforms, canvas data and GPU properties are not
fabricated; they would conflict with the real runtime. Native Client Hints,
locale, timezone, screen and hardware APIs remain intact. Ordinary page reads
use `userGesture: false`; actual pointer input supplies activation.

Page helpers are confined to each invocation's function scope. Ordinary
locators, click guards and canaries neither publish `window.__epoPage` nor
overwrite an existing page property. A compiled-script regression verifies
the scope and return value together.

The local runtime probe checks HTTP/JavaScript/Client Hint consistency and
trusted input. It neither contacts Instagram nor demonstrates resistance to
Instagram detection. See `../qa/background-runtime-2026-09-21.md` for the tested
runtime, replay command, exact measurements and limits.

## Primary references

- [Electron WebContents](https://www.electronjs.org/docs/latest/api/web-contents):
  input focus requirements and the meaning of the `userGesture` argument.
- [Electron Session](https://www.electronjs.org/docs/latest/api/session): session
  UA/Accept-Language settings and WebContents overrides.
- [Electron powerSaveBlocker](https://www.electronjs.org/docs/latest/api/power-save-blocker):
  app suspension prevention while allowing display sleep.
- [Chromium input protocol](https://chromedevtools.github.io/devtools-protocol/tot/Input/):
  viewport CSS coordinates and mouse event fields.
- [Chromium runtime protocol](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/):
  remote objects, calls and explicit release.
