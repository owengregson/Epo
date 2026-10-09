# Interaction overhaul — implementation and evidence

The change covers pointer generation, gesture delivery, target validation,
production pacing, browser identity, renderer liveness and power ownership.
Existing unrelated changes in this checkout were preserved.

## Motion and pacing

WindMouse now provides gravity, correlated wind, momentum, braking and bounded
overshoot/correction. Segment lengths drive event timing; viewport constraints,
fractional coordinates and visible target dimensions prevent invalid travel.
This is an independent implementation of the force-model concept, not copied
code from sliced.sh or the reference implementation.

| Reproducible sample | Before | After |
| --- | ---: | ---: |
| 700 px travel, events over 2,400 px/s across 500 seeds | 1,833 | 0 |
| 2,000 px travel, events over 2,400 px/s across 500 seeds | 22,391 | 0 |
| 1 px travel, draws pinned to exactly 120 ms | 471 / 500 | 6 / 500 |
| Busy session, gaps pinned to exactly 45 s with ten recent actions | 83.110% | 0.070% |
| Equal 60 s bounds, zero jitter: distinct millisecond delays in 50,000 draws | 1 | 22,747 |

Safety floors and caps remain intact. Busy-session excitation compresses time
above the floor. Degenerate positive action intervals gain positive-only
variation, so this repair cannot accelerate them. Follower scrolling and page
retries use fresh bounded draws. Correctness polling, watchdogs, verification
deadlines and local UI updates retain their appropriate scheduling semantics.

Reproduction, distributions and limitations:
[motion report](motion-2026-09-21.md), [timing report](timing-2026-09-21.md).

## Page interaction and identity

- Every production pointer caller uses the same native CDP interactor,
  including early profile-link identity resolution.
- Gestures and input events are serialized and acknowledged. Navigation,
  resize, recovery, detachment and cancellation stop obsolete queued work.
- Clicks hold the original DOM node and revalidate hit position, rectangle,
  connection and enabled state immediately before pressing. Overlays and
  replacement rows cannot inherit the planned click during travel.
- Accepted presses release on the same document even if Pause arrives during
  the hold. Ambiguous press/release outcomes require re-observation; they are
  not silently reported as success. Cursor-overlay errors cannot interrupt
  release.
- Scrolling respects viewport bounds and a supplied safe resting point;
  invalid geometry is rejected before input is emitted.
- User agents derive from the actual Chromium runtime and OS. HTTP and
  JavaScript UA, native client hints and language settings were checked in
  Electron. Random browser/OS strings would contradict those native signals;
  the app therefore uses a stable coherent identity instead.
- Ordinary reads do not manufacture user activation. Bundled helpers remain
  inside each invocation, leaving page globals intact.

The native fixture also verified that the original click target is accepted,
while a same-position replacement and a covering element are rejected.

## Background execution

Nine actual Electron window scenarios passed with 72/72 trusted clicks and
asynchronous page acknowledgements. The 333-second hidden soak still delivered
input after 330 seconds, averaging about 57 animation frames/s and 40 timer
ticks/s. Maximum input acknowledgement during that soak was 36.22 ms.

Empirical testing found and repaired three failures that unit tests alone did
not reveal: cold-renderer setup deadlock, native view concealment stalling
input, and a post-navigation hidden compositor throttle. The latter previously
took 193–208 seconds for eight gestures; repaired cases took about eight seconds.
Power assertions and suspend/resume listeners now have explicit ownership and
cleanup. The health canary rejects a live but throttled 1 fps renderer.

[Background report and raw measurements](background-runtime-2026-09-21.md)
include native versions, bundle hashes, state assertions, failed experiments,
official-source research, the macOS rendering-power tradeoff, and replay
commands. A later rebuilt navigation/recovery run passed 16 additional trusted
clicks and all four before/after health checks.

The user subsequently supplied a completed live dry-run log: identity,
acquisition, enrichment, scoring and sentinel checks passed; follow,
follow-back and unfollow were skipped, with zero account actions. That output
also exposed an independent live-harness page-limit mismatch, now repaired and
covered by a local regression. See the [live read smoke report](live-read-smoke-2026-09-21.md)
for the recorded evidence, test scope and configuration correction.

## Verification and remaining limits

Final `npm run check` passed: generated-target/token checks, source/test type
checking, lint, dependency boundaries, page-bundle freshness, **170 passing test
suites / 1,849 passing tests**, and the development build, including the later
live-harness budget regression. One suite and two
tests remain skipped. Existing advisory lint/boundary warnings remain.
Teardown after native view destruction has a separate passing regression.

The runtime evidence uses an isolated local fixture on macOS arm64 with
Electron 44.1.1 / Chromium 152.0.7977.65. The supplied live smoke output validates
the recorded read path; live follow/unfollow and native pointer behavior on
Instagram remain unverified. Windows/Linux, display-off and physical sleep were not
tested. A power assertion cannot execute code through forced OS sleep; the
existing wake recovery remains necessary. These measurements establish the
recorded behavior and bounds, not human-population parity, undetectability or
100% availability under every environment.
