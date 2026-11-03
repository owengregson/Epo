# 1010 — A live-only console, one stage space, and a store-first boot

Status: proposed (2026-11-02; plan-derived overhaul, streams BL + SH)

## Context

Launching Epo showed a white first frame, zeros before the graph existed, a
"Start refused: manual-running" followed by an engine that started anyway, and
an Instagram page that visited the seed's profile at every launch. The causes
were structural:

- The window was shown at construction and the dashboard loaded before IPC was
  registered, so the renderer's first invokes raced their handlers and painted
  not-built shapes as numbers.
- Identity was tab-driven: the lazy build navigated the tab to resolve the own
  username, and a degraded graph retried that navigation on a backoff from
  ordinary IPC reads, so a read path could move the page.
- Nothing owned the tab at launch: the profile landing, the run-intent restore,
  a mounted Settings view's seed check and the scheduled prune all started at
  once, and a user Start was refused while another of them held the page.
- The stage (what covers the tab) was set from three places (`setStage`,
  `login()`'s `tab.show()`, the renderer), an unknown mode was ignored
  silently, and keyboard stage switching died whenever Instagram had focus.

## Decision

**A hidden-window boot with IPC before the dashboard.** `createAppShell` gains
additive options (`startHidden`, `deferDashboardLoad`, `reveal()`,
`loadDashboard()`, `igFirstLoad`), whose defaults are today's window. The launch
builds the window hidden, constructs the Foundation and the module graph,
registers IPC, and only then loads the dashboard; its first `did-finish-load`
reveals the window (`BOOT.SHOW_FALLBACK_MS` reveals one that never finishes).
The window and dashboard paint `#0d0d0f`; dashboard zoom is limited to 1–1.

**Store-first identity; the session never navigates.**
`GraphSession.openFromStore()` opens the graph from the cookie and the store's
own account row, memoized. `ensureBuilt()` delegates to it, so no IPC read can
touch the tab. The degraded-username retry and the tour-hold block on the store
open are gone. `rebuildWith(username)` is the only rebuild, called by
confirm-account, and deferred while the engine runs.

**A startup sequence under one lease.** `BootSequencer` runs R2 (the cookie) and
R3 (the store-first open, `basis:'built'`, or `unavailable` with a typed
`dataProblem` from `classifyOpenError`), claims the `'startup'` tab lease at R3
and runs, behind the splash, step 1 `open-own-profile` (today's landing press)
and step 2 `confirm-account` (the landed URL, else passive identity strategies
1–2: two evaluates, no press, no navigation). `BootView.ig` becomes `ready` when
they finish, or `placeholder` at `BOOT.IG_READY_DEADLINE_MS` (p95 hydration plus
two median navigations, derived), offline, signed out or under the tour hold.
After the renderer reports `bootRevealed()` — or `BOOT.SETTLE_DEADLINE_MS`, so a
crash resume never depends on the intro — the graph's own steps (catch-up) and
`resume-run` run under the same lease, then it is released. Readiness rides
`EpoStatus.boot` (no separate channel). A user Start during the sequence is
queued, never refused (a Stop meanwhile cancels it); manual one-offs and prune
scan/run are refused with `'starting'`; `login()` reuses steps 1–2. Before the
reveal the only tab work is the home load, the landing press with its URL wait,
and confirm-account's passive reads (law L-BOOT). Phases only advance.

**One stage space, one controller.** `StageMode` has one source
(`src/shared/stage-mode.ts`). `StageController` is the only entry point: it
validates (an unknown mode is logged), serializes with the latest request
winning, enters Live through the veil curtain (opaque within
`BOOT.CURTAIN_PAINT_MAX_MS`, re-stack the tab, fade over
`BOOT.CURTAIN_FADE_MS`; unpainted → a plain cut) and leaves Live at once. It
titles the window per posture (`postureHeadline`) and badges the macOS Dock only
for needs-attention and data-unavailable. An application menu carries ⌘1–⌘5 and
⌘, (each asks the renderer through `PUSH.stageRequest`), no page zoom, and
Reload/DevTools only unpackaged.

**The live console (SH, SB).** The sidebar is instruments only; targets and
queues become the People stage; Settings is a stage; Graph preloads behind the
splash. The stage hosting and People page sections belong to SH's part of this
record.

## Consequences

- Launch adds zero Instagram traffic: the home load and the own-profile landing
  already happened at every launch; they now run behind the splash.
- A store a newer build migrated, a locked file or an unreadable one surface as
  "Can't open your data" with per-problem copy, never as zeros.
- A renamed account is confirmed before any username-dependent work: Start is
  queued behind the lease, and a degraded graph wires no own-list source.
- `restartFromSeed` retires the old sources (`'retired'`), which the frontier
  never revisits.
- The window title and Dock badge follow the same posture function the sidebar
  uses.

## Alternatives rejected

- **Show the window, then hide the tab with native visibility.** Native
  visibility stalls CDP input ACKs (ADR 0306); concealment stays re-stacking.
- **A separate `epo:boot` channel.** Readiness would race the first status;
  riding `EpoStatus.boot` keeps it atomic with the first built data.
- **Run the catch-up behind the splash.** 20–60 s behind a splash is not a
  launch; it runs after the reveal under the same lease.
- **Keep resolving the username through the tab on reads.** That is how a read
  path moved the page; the store already knows the account, and confirm-account
  checks it once, passively.
