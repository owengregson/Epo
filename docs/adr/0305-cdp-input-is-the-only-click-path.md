# 0305 — CDP input dispatch is the only click path

**Status:** accepted · **Area:** adapter/interaction (`src/adapter/tab.ts`,
`src/interaction/cdp-input.ts`, `src/adapter/actor.ts`)

## Context

Epo runs unattended, usually with its window in the background. Two input
transports were tried before this one, and both fail there:

- **In-page `element.click()`.** A synthetic, untrusted event. Instagram's SPA
  ignores it outright for several controls (the nav profile link, the drawer
  entries), and where it *does* work it bypasses the real press the page's
  handlers expect.
- **`webContents.sendInputEvent`.** Documented as focus-dependent, and measured
  as such: with the window backgrounded, every click was dropped. A run left
  overnight did nothing and reported no errors.

## Decision

**Clicks and scrolls are dispatched through CDP `Input.dispatchMouseEvent`**
(`tab.sendInputEvent` → `toCdpMouseParams`), serialized through `inputChain` so
concurrent presses cannot interleave, with `sendInputEvent` kept only as a
fallback when the debugger is unavailable (one health event per attach epoch).

**Locating stays in-page; pressing never does.** A surface locate script returns
the control's viewport rect; the `Interactor` moves a virtual cursor there along
a human-shaped path and presses. This split is why the page scripts return rects
instead of clicking.

**The `Interactor` is a REQUIRED dependency of the Actor.** It used to be
optional, with an in-page-click fallback behind eleven
`interactor && locate ? … : fallback` branches. Production always wired one, so
the fallback arm was unreachable — except in `npm run livetest`, which meant the
mandated live smoke test exercised a path production never takes and **could not
validate the CDP input pipeline at all**. The livetest now builds the same
`ElectronInputDriver` + `Interactor` the composition root does, and the fallback
tier is gone.

The one exception is `clickProfileLink`, used by the identity resolver: it runs
*before* any Interactor exists (it is what names the account the graph is built
for), so it keeps a synthetic click.

## Load-bearing details — do not remove

Every layer here was measured, and removing any one reproduces the
background-run failure:

- the three anti-throttling switches applied before `app.whenReady()`;
- `backgroundThrottling: false` on the tab's `WebContentsView`;
- `Emulation.setFocusEmulationEnabled` — without it the page treats the
  backgrounded window as unfocused and suppresses hover/press affordances;
- the remove-then-add debugger listener re-registration (a doubled listener
  emits every network response twice, which double-counts requests and can
  double-resolve a mutation watch);
- `powerSaveBlocker('prevent-app-suspension')`.

See `docs/HANDOFF.md`, 2026-08-14, for the measurements.
