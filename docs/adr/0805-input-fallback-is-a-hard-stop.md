# 0805 — The `sendInputEvent` fallback is a hard stop, not a fallback

**Status:** accepted · **Area:** adapter (`src/adapter/tab.ts`)
**Amends:** ADR 0305 (deliberate disagreement — see below)

## Context

ADR 0305 established CDP `Input.dispatchMouseEvent` as the only click path, and kept
`webContents.sendInputEvent` "as a fallback when the debugger is unavailable (one
health event per attach epoch)".

That fallback cannot work in the mode that matters. Electron documents
`sendInputEvent` as focus-dependent, and it was MEASURED as such: with the window
backgrounded every click was dropped. The 2026-08-13 all-night run reported
`clicked: true` for every follow while the page never received a thing.

So the code as written did this: on the first missing-debugger dispatch it fired one
health event, and then it silently dropped every subsequent click — while continuing
to return normally, which the Actor reads as "the press happened" and then verifies
against a DOM that never changed. The engine's own recovery ladder sees a stream of
ordinary failures instead of a dead input path.

## Decision

**Refuse to dispatch.** When the debugger is unavailable, `tab.sendInputEvent`:

1. logs an `error` naming the event type and the debugger state;
2. raises the `input-unavailable` health event once per attach epoch (`recoverTab`
   re-arms it along with the debugger);
3. **drops the event** rather than routing it through a transport measured to swallow
   it.

`checkHealth` already treats a standing health mark as unhealthy even while rAF is
still ticking, so the existing recovery path is what picks this up.

## Why this disagrees with ADR 0305, deliberately

ADR 0305's own reasoning for keeping the fallback was "in which case the Reader is
dead anyway". That is precisely the argument for halting. If the debugger is gone the
Reader observes nothing, the mutation arbitration (ADR 0304) cannot happen, and the
DOM-only verification is exactly the phantom-success path ADR 0304 was written to
eliminate. There is nothing left to degrade TO. Dispatching into a transport that
cannot deliver converts a loud, recoverable failure into an invisible one — which is
the failure mode this whole layer exists to prevent.

## Consequences

- An unattended run with a detached debugger now halts loudly instead of pretending
  to work. That is a behaviour change and it is the intended one.
- `tests/adapter/tab-health-events.test.ts` asserts the new contract directly:
  **nothing** is dispatched (`mock.inputEvents` is empty) and the health event fires
  exactly once per epoch, re-arming after `recoverTab`.
- Every other layer listed in ADR 0305 as load-bearing is untouched: the three
  anti-throttling switches, `backgroundThrottling: false`,
  `Emulation.setFocusEmulationEnabled`, the remove-then-add debugger listener
  re-registration, and `powerSaveBlocker`. Removing any of them still reproduces the
  background-run failure.
- The one synthetic-click exception stands: `clickProfileLink` runs before any
  Interactor exists (it is what names the account the graph is built for) and is now
  declared as an `escape` control citing ADR 0305.

## Alternatives rejected

- **Keep the fallback, escalate the log.** A louder log does not stop the Actor from
  reading a dropped click as a dispatched one.
- **Attempt recovery inline from `sendInputEvent`.** The tab REPORTS health and never
  sets recovery policy (ADR 0305); a reload triggered from inside an input dispatch
  would race the caller's own retry.
