<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="project/assets/hero-dark.svg">
    <img src="project/assets/hero.svg" width="350" alt="Epo — Instagram growth, engineered">
  </picture>
</p>

<p align="center">
  <b>A safe, observable Instagram follow/unfollow growth engine.</b><br>
  A local-first desktop app that logs in once, then grows an account the patient way —
  one paced action at a time, on a durable event-sourced knowledge graph, with the
  brakes built in rather than bolted on.
</p>

<p align="center">
  <a href="../../releases/latest"><b>Download</b></a> &nbsp;·&nbsp;
  <a href="#getting-started">Getting started</a> &nbsp;·&nbsp;
  <a href="#how-it-works">How it works</a> &nbsp;·&nbsp;
  <a href="#the-safety-model">Safety</a> &nbsp;·&nbsp;
  <a href="#build--package">Build</a>
</p>

<br>

> **Disclaimer.** Using a third-party tool to act on your Instagram account may violate
> Instagram's Terms of Service and can
> get an account actioned or banned. Epo is built to be conservative, but you use it at
> your own risk. Don't run it on an account you can't afford to lose.

<br>

## Features

<table>
<tr>
<td width="50%" valign="top">
<b>⌦ Command Console</b><br>
A single-window instrument panel — live status, targeting, the poaching chain, queues,
and settings. Brushed-graphite, keyboard-friendly, and it tells you exactly what the
engine is doing right now.
</td>
<td width="50%" valign="top">
<b>⏱ Deliberately paced</b><br>
One Instagram action at a time, separated by jittered delays, held inside your active
hours and under a hard daily ceiling. Bursts are structurally impossible — the loop does
at most one thing per step.
</td>
</tr>
<tr>
<td width="50%" valign="top">
<b>🛡 Safety sentinel</b><br>
Every loop iteration classifies the page first. A checkpoint, challenge, or logout halts
the engine immediately with a reason — it never keeps clicking into a wall.
</td>
<td width="50%" valign="top">
<b>🗄 Local-first knowledge graph</b><br>
Everything lives in a local, event-sourced SQLite database (WAL, durable through power
loss). Accounts, edges, the action ledger, and the churn lifecycle are all projections
you can resume from.
</td>
</tr>
<tr>
<td width="50%" valign="top">
<b>🤝 Async reconciliation</b><br>
Manage the same account by hand or with another tool? Epo reads the true follow state
from ordinary traffic and backs off — it only ever unfollows accounts <i>it</i> followed,
and never re-follows someone you already follow.
</td>
<td width="50%" valign="top">
<b>🧩 Version-marked adapter</b><br>
Every Instagram-specific literal lives in one dated module. When Instagram changes its
API or markup, a tiny fragment updates and the rest of the app stays version-agnostic.
</td>
</tr>
<tr>
<td width="50%" valign="top">
<b>💾 Resumes anywhere</b><br>
Target, database, progress, and stats persist between sessions. Lose the internet and the
engine auto-holds, then auto-resumes when you're back; the app always relaunches idle.
</td>
<td width="50%" valign="top">
<b>🧪 Dry-run &amp; tested</b><br>
A full dry-run exercises the entire state machine without touching a button, and the core
engine ships behind a suite of unit tests (no browser, no wall-clock, no real timers).
</td>
</tr>
</table>

<br>

## Getting started

Epo is a desktop app. There are two ways to run it.

**1. Install a build** *(recommended once releases are published)* — grab the latest
`.dmg`/`.zip` (macOS) or installer/portable `.exe` (Windows) from the
[Releases page](../../releases/latest), open it, and log in.

**2. From source:**

```bash
npm install
npm start        # builds and launches the app
```

On first launch, Epo opens an embedded Instagram tab. **Log in there once** (complete any
2FA/checkpoint yourself). The session is stored in a persistent, partitioned profile, so
you won't need to log in again — and clearing your data in Settings is how you log out.

Then, in **Settings**, set a **seed account** (whose followers Epo will poach) and tune
targeting and cadence. Press **Start**. That's it — the console takes over from there.

<br>

## How it works

Epo grows an account by *poaching*: it follows the kind of people who already follow
accounts like yours, waits to see who follows back, keeps them briefly, then lets them go.

1. **Poach.** Starting from your seed, Epo reads that target's followers into the knowledge
   graph (paginated, paced, request-bounded).
2. **Score &amp; queue.** Candidates are ranked — following/follower ratio inside your chosen
   band, activity, privacy — and the best are queued.
3. **Follow.** The churn scheduler follows one queued account, then waits a paced delay.
   Every real action is written to a durable ledger.
4. **Watch for follow-backs.** A request-minimal sweep reads the head of *your* followers
   list and marks reciprocations, cost `O(new)`, never `O(all)`.
5. **Hold, then unfollow.** Reciprocated follows are held for a configurable window, then
   queued for unfollow; non-reciprocators are reclaimed after a timeout.
6. **Advance the chain.** When a target is exhausted, Epo moves to the next one and keeps
   the loop going.

Throughout, an **async reconciler** reads the real relationship state from ordinary
Instagram responses. If you (or another app) followed or unfollowed someone outside Epo,
it heals its own records to match reality and steps aside — Epo only churns accounts it
actually followed, so it never fights another actor or unfollows your manual follows.

<br>

## The safety model

Request volume and burstiness are the main ban vectors, so the brakes are the design, not
an afterthought:

| Guardrail | What it does |
|---|---|
| **One-thing-per-step loop** | Each iteration performs at most one Instagram action, in a fixed precedence. Bursts can't happen. |
| **Paced actions** | A jittered delay separates every action; reads are floored by a short pacing pause. |
| **Active hours** | Nothing runs outside your configured window; the engine sleeps until it opens. |
| **Daily hard ceiling** | A durable, uncrossable cap per day — manual actions count against it too. |
| **Request budget** | Every real Instagram API call is metered; a saturated window parks instead of pushing. |
| **Sentinel** | Classifies the page each step and halts on any checkpoint/challenge/logout. |
| **Interruptible** | Pause/stop takes effect *between* actions instantly; no wait can outlive a control command. |
| **Dry-run** | Exercises the whole lifecycle without a single click. |

<br>

## Configuration

Everything is configured in-app, in **Settings**, and persists across sessions:

- **Seed &amp; session** — the account to poach from; reset/log-out lives here too.
- **Targeting** — the following/follower ratio band and its peak, which follow the slider
  proportionally.
- **Cadence &amp; safety** — active hours, daily limit, request budget, follow-back sweep
  cadence, lifecycle timers (how long to wait for a follow-back, how long to hold).
- **Dry-run** — simulate without acting.
- **Data** — reset settings, or clear all data (which also logs you out), each behind a
  confirmation.

<br>

## Build &amp; package

```bash
npm run dev      # build (dev) + launch
npm test         # jest unit suite
npm run lint     # eslint (flat config)
npm run build    # bundle main + renderer to dist/

npm run dist     # standalone app for the host OS (electron-builder)
npm run dist:mac # macOS .dmg + .zip
npm run dist:win # Windows NSIS installer + portable
```

`npm run dist` produces an installable app under `release/`. Builds are currently
**unsigned** — on macOS, right-click → *Open* the first time (or
`xattr -d com.apple.quarantine` the app); on Windows, dismiss SmartScreen. Signing and
notarization are a later step.

<br>

## For developers

Epo is TypeScript end-to-end, strict mode, bundled by esbuild.

```
src/
  main/        Electron main process — window, IPC, foundation wiring, connectivity
  renderer/    Preact "Command Console" UI (app · views · cards · ui primitives · styles)
  engine/      the paced runtime: churn scheduler, scanner, chain, follow-back watcher
  adapter/     version-marked Instagram surface (reader · actor · sentinel · versions/*)
  rim/         browser-facing ports (acquisition, page readers, reconciler, metering)
  governors/   clock, rate governor, request budget
  store/       event-sourced SQLite knowledge graph (schema · migrations · projections)
```

Design principles: the engine owns all wall-clock time and is fully unit-testable with
fakes (no browser, no timers); the store is the single source of truth; and **all**
Instagram-specific knowledge is quarantined in `src/adapter/versions/<date>.ts`, so a
platform change touches one small module.

```bash
npm test              # the full unit suite
npx tsc --noEmit      # type-check
```

CI runs type-check, lint, tests, and a build on every push and PR; tagged `v*` releases
build macOS and Windows artifacts.

<br>

## License

[MIT](LICENSE).

<p align="center"><sub><b>Epo</b> by <a href="https://github.com/owengregson">@owengregson</a></sub></p>
