# 1010 — A live-only console, one stage space, and a store-first boot

Status: accepted

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
splash.

**Five stages, hosted by the renderer (SH).** The stage bar shows Live ·
People · Graph · Prune · Settings in `STAGE_MODES` order (the menu's ⌘1–⌘5;
Settings also ⌘,), equal-width tabs, a live dot on Live while Epo uses the page
from another stage, and on Live a line saying whether Epo is using the page or
when it next will. `StageHost` mounts Graph eagerly, People and Prune on first
activation, Settings on first activation with nothing preloaded beyond its
pushes — so no Settings mount effect (the seed check of defect D1) runs at
boot. Pages stay mounted once opened, open at the top and replay their arrival.
The App asks main for `setStage(stage, modalOpen || !liveRevealed)`; the boot
gate holds `liveRevealed` false until its reveal. Menu requests arrive as the
`stageRequest` push and are ignored while the tour drives the stages.

**Shell services and controls (SH).** `ShellServices` stays `{confirm, toast}`;
the controls get their own context (`useShellControls()`): `showStage`,
`openSettings(target)`, and one control runner for Start / Pause / Stop / Sign
in whose in-flight name is mirrored on `pendingControlSignal`. Start without a
starting account opens Settings at that field; Sign in asks for Live before
`login()`, since main no longer shows the tab on login.

**One subscription per channel, data before the page (SH).** `useLiveFeeds`
subscribes feed, activity, chain list, settings view and facts once, push-first
with keep-alive pulls, and fetches the People data (the default growth window,
every lane's first page, the kept table) before any page mounts. Pages read
Instagram-derived data again only while shown. One ref-counted clock serves
every "m:ss" and "5m ago"; `play()` resolves at once in jsdom or under reduced
motion, so no logic waits on an animation.

**Overlays over native views (SH).** Tooltips and the one popover render at
shell level, outside the console column. On Live the Instagram page covers the
stage body and draws above everything the renderer paints, so a bubble anchored
in the column is placed inside the column, and a tooltip that cannot avoid the
page is not shown (its anchor's label carries the text); a popover that cannot
clear its anchor there opens over it.

**People (SH).** Measured growth only (the static projection band goes with
owner Q30), where Epo finds people (steps, the source in detail, days of people
left, follow-backs) and who is in progress (Up next · Waiting · Following back
· Leaving soon · Kept), in plain words. The detailed source is
`status.resumeTarget` while Epo is stopped, so the page and the engine agree.

**The live column (SB).** `src/renderer/sidebar/**` replaces the overview: the
masthead, Now (the one raised surface), Today, Results and Recent activity over
the footer, at fixed zone heights with reserved slots, so a posture change only
changes content. The posture is `derivePosture` over the shell's signals in one
cached computed (`sidebar/posture-signal.ts`; a push that changes no part of it
keeps the previous object, so no deadline animation re-arms). Now shows one
posture-derived primary plus Stop, a reason line for typed refusals of the
person's own commands (never a raw-key toast), and a Why? popover. Stop asks
nothing; its toast offers Undo. Today carries the one Boost control: one tap with
the saved length (Start Epo and Boost while stopped), a band with one-tap End
while a window is open, and an honest wait while the plan is not wired, the
account is signed out or has no seed, attention is needed, or the preview says
nothing would change or the backlog is unpaid. Results counts nothing from a
not-built status (final-size skeletons) and every Instagram-observed number
carries its age. The feed groups by plan-day, keeps "Since you left" a strict
time boundary, files a single new follow or unfollow from the now line into its
row, and holds still with "↑ N new" while scrolled away. Every sentence comes
from the copy decks under `sidebar/copy/*` (law L-COPY: no banned word, no raw
key, headlines ≤ 15 characters, Prune for the cleanup feature, no literal number).

**The renderer's boot (SB).** The inline splash in `index.html` shows before any
script; `boot/BootGate` renders the app under it and reveals once R4 ∧ R5 hold
(main's boot ready, the first frame's data here, Instagram decided) with the
fonts loaded and the shortest dwell passed, or at main's `revealBy`. The intro
(`boot/intro.ts`) flies the mark into the masthead while the app rises under the
fading splash; the native page stays covered until the reveal and uncovers only
once its first load settled (else the Live placeholder shows); `bootRevealed()`
goes to main exactly once, and a renderer reload while main is live skips the
intro. The first-launch tour opens right after the reveal. Diagnostics streams
the raw log only while its panel is mounted.

## Consequences

- Before the reveal, tab work is limited to the existing home load and own-profile landing.
  The bounded, read-only catch-up runs after the reveal under the startup lease (ADR 0213).
- A store a newer build migrated, a locked file or an unreadable one surface as
  "Can't open data" with per-problem copy, never as zeros.
- A renamed account is confirmed before any username-dependent work: Start is
  queued behind the lease, and a degraded graph wires no own-list source.
- `restartFromSeed` retires the old sources (`'retired'`), which the frontier
  never revisits.
- The window title and Dock badge follow the same posture function the sidebar
  uses.
- A launch mounts no Settings page, so nothing checks the starting account at
  boot; every push channel has exactly one renderer listener; the raw log no
  longer streams to the window (it lives in Diagnostics).
- The live column renders Start/Pause/Stop through `useShellControls()`; the interim overview,
  its cards and their literal-duration copy are deleted.
- A refused command explains itself where the person pressed it; an unknown
  attention reads neutrally and shows its code only on a muted line.
- The app is on screen only once the first frame's numbers are true or plainly
  absent; numbers never count up at boot (tickers arm one frame after mount).

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
- **Keep every page mounted from boot.** The always-mounted hidden Settings view
  is what fired a live seed check at every launch (§13 D1); mounting on first
  activation removes the mechanism, not just the symptom.
- **Clamp overlays by z-order.** The native page draws above every renderer
  layer whatever its stacking, so the only fix is not to place a bubble where
  the page is.
- **Widen `ShellServices` with the controls.** Pages and suites that provide
  only the two services would all have to change; a second context costs one
  provider.

## Amendment — branded development runtime (2026-11-03)

Native QA found that the locally branded Electron executable reports `app.isPackaged = true` even when
`run-desktop.mjs` passes it the development script. Installed-build decisions therefore also require
`process.defaultApp !== true`, using one pure `isInstalledApp` predicate. Script launches display Epo's manifest
version, keep updating off, and retain the development menu and source Dock icon. Installed releases keep their
runtime version and platform update mode. The version, mode and menu regressions passed at `aa31274`; native
re-verification remains recorded separately in the overhaul QA record.

The same native pass found the Settings tour step pointing to a seed field outside the viewport. The follow-up at
`bd41d98` anchors that step to the field itself, scrolls each step's first measurable target into view once without
animation, then remeasures it while retaining Next/Finish focus. Delayed/offscreen-anchor regressions pass; native
confirmation remains pending.
