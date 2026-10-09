# 0804 — Playwright: no at runtime, yes in the lab

**Status:** accepted · **Area:** adapter / lab (`src/adapter/tab.ts`,
`src/surface-lab/**`)

## Context

Every browser-automation question eventually reaches "why not Playwright". The honest
answer needs measuring against what this app actually needs, which is unattended
operation with the window in the background and a hard requirement that a blocked
action be distinguishable from a stale selector.

## Decision

**Keep the tab layer hand-rolled. Adopt `playwright-core` as a devDependency only,
for one command (`surface-lab smoke`), never in a shipped build.**

| Axis | Finding |
|---|---|
| Input trust | `page.mouse` **is** `Input.dispatchMouseEvent`. `src/interaction/cdp-input.ts` already emits the identical params, and Playwright's `mouse.move(x,y,{steps})` is linear interpolation with no timing — the `Interactor`'s Fitts-law travel and wheel plan would sit on top of it anyway. Zero gain. |
| Second CDP client | The tab already holds `webContents.debugger.attach('1.3')`. `connectOverCDP` drives through browser-level `Target.setAutoAttach` and its own session tree. Chromium permits multiple clients, but Electron's `debugger.attach()` has historically thrown when another client owns the target. Betting the ONLY working input path on an undocumented two-client interaction is the wrong risk. |
| `--remote-debugging-port` | Required for `connectOverCDP` against the app's own process. In a shipped build that opens an unauthenticated localhost CDP endpoint on a browser holding `persist:ig` cookies — any local process could drive the user's logged-in Instagram. Disqualifying on its own. |
| Auto-wait locators | Actively harmful here. `getByRole().click()` retries through actionability, which would silently ride out a block interstitial and then time out anonymously — destroying the `ActionBlockedError` vs `AdapterStaleError` distinction ADR 0302/0305 exist to preserve. The header-only anchor with a LOUD IMMEDIATE stale is the safety property. |
| `waitForResponse` | Strictly weaker than `ResponseWatch`. The watch arms before the click, matches by URL **and** the `x-fb-friendly-name` request header, reads the body, and classifies it through the version module. `waitForResponse` gives a predicate over a `Response` and no classification. |
| Genuinely gained | Tracing (`trace.zip` with DOM snapshots + network), HAR record/replay, and a real runner for the live smoke. All of that is **lab** value. |

## The 60-minute spike (run it anyway — cheap, and it settles the argument)

```
0–10  npm i -D playwright-core@1.62.1
      Add EPO_CDP_PORT env → app.commandLine.appendSwitch('remote-debugging-port', port)
      in bootstrap.ts, guarded to dev builds only. npm run dev with it set.
10–20 node -e "chromium.connectOverCDP('http://127.0.0.1:PORT')" → list contexts/pages.
      PASS = the IG WebContentsView appears as a Page.
20–35 THE DECIDING TEST: with Playwright attached, call tab.probeInput() from the
      app (existing diagnostic). Then hard-reload and watch for the app's own
      'detach' health event / 'Another debugger is already attached'.
      Also assert the app's onResponse stream still fires (Network.enable on both
      clients). Any breakage here = the two-client model is not viable.
35–50 With BOTH clients live, background the window (minimize + occlude) and run
      one Playwright page.mouse.click on a known control. Confirm the app's own
      CDP click still lands via probeInput.
50–60 Record the answer in docs/adr/. Whatever the outcome, keep the port flag
      dev-only and NEVER in a packaged build.
```

If steps 20–35 pass cleanly, the OPTION exists for the lab to attach to a running dev
app (nicer for `inspect`). It still does not change the runtime recommendation,
because of `--remote-debugging-port` in shipped builds.

## Consequences

- The four gates stay Jest / tsc / biome / build. The live smoke is a manual job
  whose failure prompts a human, exactly as `npm run livetest` is today — never a
  merge gate.
- The lab pin is exact. `_electron` is an underscore API and its Chromium pairing is
  not contractual; a drift between it and the installed Electron must break one
  manual command, not the build.
- `surface-lab replay` and `surface-lab diff` need no browser at all, which is the
  point: the contract the corpus encodes is checkable in CI without a session.
