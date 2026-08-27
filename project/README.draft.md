<!-- ════════════════════════════════════════════════════════════════════
  EPO README, DRAFT FOR THE DESIGN/ART AGENT
  ════════════════════════════════════════════════════════════════════
  This file is the finished copy and final layout for the new README.
  Every image below is a placeholder path. Create each asset, keep every
  path exactly as written, and do not rewrite the prose. When all assets
  exist, this file replaces README.md at the repo root (fix the relative
  asset paths at that point: they are written root-relative already).

  BRAND
  - Product: Epo. Tagline: "Instagram growth on autopilot."
  - The brand mark is the metallic lowercase "e": a flattened 8 with a
    sharp slot cutout, one continuous silhouette, brushed-metal body
    with the shine living in the edge. That concept stays the mark.
  - REDO ALL EXISTING WORDMARKS. project/assets/hero.svg, hero-dark.svg,
    epo-mark.svg, and epo-mark-light.svg are to be re-drawn from
    scratch as one new lockup system (mark + "epo" wordmark + tagline).
    Do not reuse the current files. Keep the metallic-e concept for the
    mark itself unless the user says otherwise.
  - Look: brushed graphite, instrument-panel, metallic neutrals. It
    should feel like the app's Command Console. Every asset that
    carries color ships in a light and a dark variant, wired through
    <picture> as laid out below.

  ASSETS TO CREATE (display sizes as used below)
   1. project/assets/hero.svg + hero-dark.svg
      860w hero lockup: mark, wordmark, tagline. REDO, see above.
   2. project/assets/buttons/download.svg   46h, "Download for macOS / Windows"
      project/assets/buttons/releases.svg   46h, "All releases"
   3. project/assets/headers/<name>.svg     54h section headers, one each:
      features, how-it-works, autopilot, safety, getting-started,
      settings, faq, compatibility, developers
   4. project/assets/icons/<name>.svg       40px feature icons:
      local      (your data stays home)
      pace       (one action at a time)
      sentinel   (it knows when to stop)
      reconcile  (your own follows are safe)
      resume     (it holds its place)
      console    (watch it work)
   5. project/assets/diagrams/loop.svg + loop-dark.svg
      ~820w diagram of the growth loop as a cycle:
      pick a seed > read followers > choose > follow > watch for
      follow-backs > let go > next target (loops back).
   6. project/assets/divider.svg            22h footer divider
   7. project/assets/social-preview.png     1280x640 repo social card
   8. LIVE PANELS. Two SVGs are rendered by a scheduled GitHub Action
      into a "readme-live" branch and referenced below from
      raw.githubusercontent.com. Design the TEMPLATES the workflow
      fills in (the workflow itself is a separate engineering task;
      it runs nightly, and the pace panel calls the real planner in
      src/timing so the plan changes every night):
      - status/compat.svg + compat-dark.svg  ~820x90 strip:
        "Checked against live Instagram" with a pass/hold state, the
        check date, and the current adapter version date (the newest
        file in src/adapter/versions/).
      - charts/pace.svg + pace-dark.svg      ~820x300 chart:
        one planned day. Dots on a 24-hour axis, a shaded active-hours
        band, a dashed daily-cap line the dots stay under.
   9. Optional, later: release-note banners and headers under
      project/assets/release/, matching this system.
  ════════════════════════════════════════════════════════════════════ -->

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="project/assets/hero-dark.svg">
    <img src="project/assets/hero.svg" width="860" alt="Epo: Instagram growth on autopilot">
  </picture>
</p>

<p align="center">
  <a href="../../releases/latest"><img src="project/assets/buttons/download.svg" height="46" alt="Download for macOS / Windows"></a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="../../releases"><img src="project/assets/buttons/releases.svg" height="46" alt="All releases"></a>
</p>

<p align="center">
  <b>Instagram growth on autopilot.</b><br>
  Epo is a desktop app that grows your Instagram account for you. It follows people who
  are likely to follow you back, gives them time, then cleans up after itself. It runs
  slowly on purpose, inside limits you set, and it shows you everything it does.
</p>

<br>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/owengregson/Epo/readme-live/status/compat-dark.svg">
    <img src="https://raw.githubusercontent.com/owengregson/Epo/readme-live/status/compat.svg" width="820" alt="Checked against live Instagram: current status, check date, and adapter version">
  </picture>
</p>

<br>

> **Before you start.** Tools like this one are against Instagram's terms of service.
> An account that runs one can be restricted or banned. Epo is careful by design, but
> the risk never reaches zero. Do not run it on an account you cannot afford to lose.

<br>

<p align="center">
  <img src="project/assets/headers/features.svg" height="54" alt="What you get">
</p>

<table>
<tr>
<td width="50%" valign="top">
<img src="project/assets/icons/local.svg" width="40" alt=""><br>
<b>Your data stays home</b><br>
Epo is a desktop app with no server behind it. Everything it learns about your account
lives in one database file on your computer, and you can erase that file any time.
</td>
<td width="50%" valign="top">
<img src="project/assets/icons/pace.svg" width="40" alt=""><br>
<b>One action at a time</b><br>
The engine does one thing, waits a varied delay, then does the next. It works only
inside your active hours and never passes the daily cap. Bursts cannot happen; the
loop has no room for them.
</td>
</tr>
<tr>
<td width="50%" valign="top">
<img src="project/assets/icons/sentinel.svg" width="40" alt=""><br>
<b>It knows when to stop</b><br>
Before every step, Epo reads the state of the page first. A checkpoint, a challenge,
or a signed-out session halts the engine at once, and the console shows the reason.
</td>
<td width="50%" valign="top">
<img src="project/assets/icons/reconcile.svg" width="40" alt=""><br>
<b>Your own follows are safe</b><br>
Use Instagram normally on any device while Epo runs. It notices what you did by hand
and works around it. It only ever unfollows accounts it followed itself.
</td>
</tr>
<tr>
<td width="50%" valign="top">
<img src="project/assets/icons/resume.svg" width="40" alt=""><br>
<b>It holds its place</b><br>
Quit the app, lose the connection, or let the laptop sleep. Epo pauses cleanly and
continues where it stopped. Work that came due while it was closed is done first the
next time it runs.
</td>
<td width="50%" valign="top">
<img src="project/assets/icons/console.svg" width="40" alt=""><br>
<b>Watch it work</b><br>
The console shows the plan, the queues, and every action as it happens. Counts move
while a scan is still running, because the screen mirrors the database, live.
</td>
</tr>
</table>

<br>

<p align="center">
  <img src="project/assets/headers/how-it-works.svg" height="54" alt="How it works">
</p>

Epo grows an account the old way: follow people who are likely to follow back, give
them time to notice you, then move on. One full pass looks like this:

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="project/assets/diagrams/loop-dark.svg">
    <img src="project/assets/diagrams/loop.svg" width="820" alt="The Epo growth loop: pick a seed, read its followers, choose, follow, watch for follow-backs, let go, then move to the next target">
  </picture>
</p>

1. **Pick a seed.** Choose an account whose followers would probably like yours too.
   A peer, or a bigger account in your niche.
2. **Read.** Epo reads the seed's follower list into its local database, one page at
   a time, at a reading pace.
3. **Choose.** It scores every profile and keeps the promising ones: active accounts
   whose follower numbers sit inside the range you set.
4. **Follow.** It follows one chosen account, writes that action to its ledger, and
   waits. Then the next one.
5. **Watch.** On a schedule, it checks the newest entries in your follower list and
   marks who followed back. It reads the new names only, never your whole list.
6. **Let go.** Accounts that followed back stay followed for a time you choose, then
   Epo unfollows them. Accounts that never followed back are unfollowed sooner. If a
   profile's bio contains one of your protected words, Epo leaves that account alone.
7. **Move on.** When a seed runs dry, Epo advances to the next target in your chain
   and keeps going.

While all of this runs, you can use Instagram yourself on any device. Epo reads the
true state of your account from the pages it already loads and repairs its own records
to match. It never unfollows an account you followed by hand, and it never re-follows
someone you already follow.

<br>

<p align="center">
  <img src="project/assets/headers/autopilot.svg" height="54" alt="A day on autopilot">
</p>

The picture below is not a mock-up and not an average. A scheduled job runs the same
planner that ships inside the app, plans one day, and draws it. The job runs again
every night, so the day you see here is always a fresh one.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/owengregson/Epo/readme-live/charts/pace.svg">
    <img src="https://raw.githubusercontent.com/owengregson/Epo/readme-live/charts/pace.svg" width="820" alt="One planned day of Epo activity: paced actions inside the active-hours window, under the daily cap">
  </picture>
</p>

<p align="center">
  <sub>Each dot is one planned action. The shaded band is the active-hours window. The
  dashed line is the daily cap. The plan stays under the cap by a different amount each
  day.</sub>
</p>

<br>

<p align="center">
  <img src="project/assets/headers/safety.svg" height="54" alt="The brakes">
</p>

The two things that get growth accounts flagged are volume and bursts. So the brakes
are part of the engine itself, and the important ones cannot be switched off:

| Brake | What it does |
|---|---|
| **One step, one action** | Each pass of the loop performs at most one Instagram action. |
| **Varied pauses** | A delay with some randomness separates every action, and reads are paced too. |
| **Active hours** | Outside the window you set, Epo sleeps. |
| **The daily cap** | A hard ceiling on actions per day. It survives restarts, and actions you take by hand count against it too. |
| **A request budget** | Every call to Instagram is counted. When a window's budget is spent, Epo parks and waits. |
| **The page check** | Every step starts by classifying the page. A checkpoint, challenge, or logout means an immediate halt, with the reason on screen. |
| **Instant controls** | Pause and Stop act between actions, immediately. No delay outlives your click. |
| **Practice mode** | The whole lifecycle runs with no real actions, so you can watch a full rehearsal first. |

<br>

<p align="center">
  <img src="project/assets/headers/getting-started.svg" height="54" alt="Getting started">
</p>

1. **Download** the latest build for macOS or Windows from
   [the releases page](../../releases/latest).
2. **Open it.** The builds are not signed yet. On a Mac, right-click the app and
   choose *Open* the first time. On Windows, choose *More info*, then *Run anyway*.
3. **Sign in once.** Epo opens Instagram's own sign-in page inside the app window.
   Enter your details there and finish any two-factor prompt yourself. The session is
   saved on your computer, so this is a one-time step.
4. **Set your plan.** In *Settings*, pick a seed account, then check the hours, caps,
   and timers. The defaults are careful on purpose.
5. **Press Start.** The console takes it from there.

<br>

<p align="center">
  <img src="project/assets/headers/settings.svg" height="54" alt="What you can tune">
</p>

Everything is set in the app, under *Settings*, and every choice survives a restart:

| Group | What you tune |
|---|---|
| **Seed and targets** | The seed account, and the chain of targets after it. |
| **Choosing** | The follower-ratio range Epo should look for, and where its sweet spot sits. |
| **Pace** | Active hours, the daily cap, the request budget, and how often Epo checks for follow-backs. |
| **Lifecycle** | How long to wait for a follow-back, how long to keep one, and your protected bio words. |
| **Practice mode** | Run the whole plan with no real actions. |
| **Data** | Reset your settings, or erase everything and sign out. Both ask you to confirm. |

<br>

<p align="center">
  <img src="project/assets/headers/faq.svg" height="54" alt="Questions people ask">
</p>

**Does Epo need my Instagram password?**
No. You sign in on Instagram's own page, shown inside the app. Your password goes to
Instagram and nowhere else. The signed-in session is stored on your computer, the same
way a browser stores one.

**Can my account still get banned?**
Yes. No tool can promise otherwise, and you should distrust any tool that does. Epo
keeps volume low, stays inside your hours and caps, and halts the moment Instagram
pushes back. That lowers the risk. It does not remove it.

**How fast will I grow?**
Slowly, and that is deliberate. The caps keep each day's work small, so results build
over weeks. Speed is what gets accounts flagged.

**Can I use Instagram normally while it runs?**
Yes, on any device. Epo works around what you do by hand and never touches your own
follows.

**Does my computer have to stay on?**
Epo works while the app is open, inside your active hours. If the connection drops or
the machine sleeps, it holds and resumes on its own. After a full quit it reopens
idle and waits for you.

**Where does my data live?**
In one database file on your computer. There is no Epo server, no sign-up, and no
analytics. The app talks to Instagram and to nobody else.

**What does it cost?**
Nothing. Epo is open source under the MIT license.

<br>

<p align="center">
  <img src="project/assets/headers/compatibility.svg" height="54" alt="Compatibility">
</p>

| | |
|---|---|
| **Runs on** | macOS (Apple silicon and Intel) · Windows 10 and 11 |
| **Needs** | An Instagram account you own. No other software, no browser plug-ins. |
| **Talks to** | Instagram only. There is no Epo server. |
| **Your data** | One local SQLite file. *Settings → Clear all data* erases it and signs you out. |

<br>

<p align="center">
  <img src="project/assets/headers/developers.svg" height="54" alt="For developers">
</p>

Epo is TypeScript end to end, strict mode, bundled by esbuild: an Electron shell
around a Preact renderer and an event-sourced SQLite store.

```
src/
  main/         Electron main process: window, IPC, wiring, connectivity
  renderer/     the Preact "Command Console" UI
  engine/       the paced runtime: scheduler, scanner, chain, follow-back watcher
  timing/       cadence: active hours, delays, per-cycle volume plans
  adapter/      version-marked Instagram surface (reader · actor · sentinel · versions/*)
  rim/          browser-facing ports: acquisition, page readers, reconciler, metering
  governors/    clock, rate governor, request budget
  interaction/  input dispatch that keeps working while the window is in the background
  store/        event-sourced SQLite knowledge graph: schema, migrations, projections
  settings/     durable settings
```

Three rules shape the code. Facts stream: every parsed profile, edge, and event is
written to the store the moment it exists, and only absence-based verdicts wait for a
verified-complete walk. The UI mirrors the graph: the renderer redraws from store
projections on mutation, which is why counts move mid-scan. And every Instagram
literal, from URLs to JSON paths, lives in `src/adapter/versions/<date>.ts`, so a
platform change touches one dated file. The full set is in
[docs/PRINCIPLES.md](docs/PRINCIPLES.md), and it is enforced in review.

Verification. All four must be green before a change is done:

```bash
npx jest             # unit suite: in-memory, no browser, no real timers
npx tsc --noEmit     # type-check
npm run lint         # biome
npm run build:dev    # bundle
```

DOM-level adapter changes also need `npm run livetest` against a real session.

Build and package:

```bash
npm start            # build and launch
npm run dist         # installable build under release/ (electron-builder)
npm run dist:mac     # macOS .dmg + .zip
npm run dist:win     # Windows installer + portable
```

CI type-checks, lints, tests, and builds every push; a `v*` tag builds the macOS and
Windows apps. Deeper notes live in [docs/](docs/): [PRINCIPLES.md](docs/PRINCIPLES.md),
[HANDOFF.md](docs/HANDOFF.md), and the adapter notes in [docs/adapter/](docs/adapter/).

Licensed [MIT](LICENSE).

<br>

<p align="center">
  <img src="project/assets/divider.svg" height="22" alt="">
</p>

<p align="center"><sub><b>EPO</b> by <a href="https://github.com/owengregson">@owengregson</a></sub></p>
