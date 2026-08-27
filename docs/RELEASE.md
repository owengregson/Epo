# Epo release engineering — design

How Epo versions, cuts, packages, publishes, and self-updates. The pipeline
shape follows the Mental repo's auto-releaser (version-bump detection on main,
hard gates before any tag exists, draft-then-flip publishing, template-token
release notes); the visual system follows the Epo README design language
(docs/README-GUIDE conventions: graphite plates, caps + tracking, mono data).

## 1. Numbering

Semver in `package.json` — the single home of the version.

- **PATCH** (`3.0.1`): fixes and internal changes; no behavior change a user
  would plan around.
- **MINOR** (`3.1.0`): new capability, backward-compatible. Store migrations
  are allowed (the store runs them forward automatically).
- **MAJOR** (`4.0.0`): breaking — a store reset, a settings reset, or an
  Instagram-adapter overhaul that needs a fresh login.
- A hyphenated version (`3.1.0-beta.1`) publishes as a GitHub **pre-release**,
  never takes the "latest" marker, and is therefore invisible to the
  self-updater (which follows the latest stable release only).

## 2. Cutting a release (the human's whole job)

```bash
node scripts/cut-release.mjs patch|minor|major|<x.y.z[-suffix]>
```

The script bumps `package.json`, regenerates the version-stamped release
banner (`project/assets/release/`), and rewrites
`.github/release-highlights.md` with this tag's marker plus a highlights
stub. The human edits the highlights (2–5 user-facing bullets), commits
everything as `release: vX.Y.Z`, and pushes. That push is the trigger; there
is no manual tagging and no separate schedule — a release ships exactly when
a bump lands, and a push without a bump costs one detect job (seconds).

## 3. The pipeline (`.github/workflows/release.yml`, rewritten)

Mental's philosophy: **the tag is created only after every gate has passed**,
by the workflow, at the verified commit.

```
push to main
  └─ detect      version unreleased? (no tag v<version>) → facts:
  │              version, tag, previous_tag, prerelease, should_release
  ├─ verify      the four gates: tsc · biome ci · jest · esbuild
  ├─ package     macos-latest (dmg+zip) / windows-latest (nsis+portable),
  │              bash shell, artifacts INCLUDE latest*.yml + *.blockmap
  ├─ boot-smoke  linux: the built app must survive 25 s under xvfb
  └─ release     compose notes → tag + DRAFT release with every asset
                 attached → flip live (--latest only for stable)
```

- Draft-then-flip (Mental's immutable-releases lesson): assets attach while
  the release is still a draft, so publishing freezes it complete. Drafts are
  invisible to the updater feed, and flipping preserves the download URLs.
- Banner freshness guard runs in `detect` (which checks out with
  `fetch-depth: 0` for the tag ledger): a forgotten banner regen fails in
  seconds, not after twenty minutes of gates and packaging.
- Artifact names are pinned kebab-case in electron-builder.yml
  (`Epo-Setup-<v>.exe`, `Epo-<v>-portable.exe`, `Epo-<v>-<arch>.dmg/.zip`)
  BEFORE the first release — the defaults contain spaces, which GitHub
  download URLs mangle and the notes template could never predict.
- Roll-forward only: electron-updater never downgrades, and deleting a
  release strands updated users on a version whose feed entry vanished. A
  bad release is fixed by shipping the next patch, never by deletion.
- Prerelease coupling: the GitHub provider decides "prerelease" from the
  semver prerelease component of the TAG, not the GitHub flag — so the
  hyphen rule and the prerelease flag must always agree (the workflow
  derives both from the same version string).
- Notes composition: `.github/RELEASE-TEMPLATE.md` owns ALL layout; the
  workflow only substitutes `{{VERSION}}`, `{{HIGHLIGHTS}}`, `{{CHANGELOG}}`,
  and `{{PREVIOUS_TAG}}` (literal substitution — commit messages with
  backticks or `$` never get mangled). Highlights come from
  `.github/release-highlights.md` only when its first line is
  `<!-- vX.Y.Z -->` for THIS tag; a stale file degrades to a generic line,
  never the wrong copy. The changelog is `git log prev..HEAD --no-merges`.
- The old tag-push trigger is gone; `workflow_dispatch` remains for reruns.
- package-rehearsal.yml keeps running the same package steps weekly, so
  tag-day tooling rot is still caught between releases.

## 4. Release cards (`project/assets/release/`)

Epo's plate language, Mental's structure. All pure vector — GitHub strips
raster hrefs inside SVGs (README-GUIDE §7.1), so the app icon stays out and
the wordmark is set in the system stack like every other plate. Self-lit
graphite (§3.3): ONE file per asset, no theme twins.

- `banner.svg` — 860×120. Instrument-panel frame with edge tick marks
  (Mental's structural motif), "EPO" at 800 weight with plate tracking, the
  version in mono (`v3.1.0`), tagline small underneath. Stamped by the
  generator at cut time. Release bodies reference it by TAG
  (`raw.githubusercontent.com/…/<tag>/project/assets/release/banner.svg`),
  so every release page shows its own banner forever — Mental references
  main and its old releases display the newest banner; the tag ref fixes
  that for free since the tag points at the bump commit.
- `headers/highlights.svg`, `headers/changes.svg`, `headers/install.svg`,
  `headers/notes.svg` — 42h header plates, same formula as the README's 54h
  plates, scaled.
- Generated by `scripts/readme-assets.mjs` (extended), which reads the
  version from `package.json` — one generator, one palette table.
- `.github/RELEASE-TEMPLATE.md` becomes: banner `<picture-less>` img →
  `<code>` chip row (macOS · Windows · unsigned · local-first) → plate-headed
  sections (Highlights / Changes / Install / Notes) → compare link.

## 5. The self-updater

`electron-updater` (runtime dependency, pure JS), GitHub provider — the feed
is the latest stable GitHub Release (`latest.yml` / `latest-mac.yml` +
blockmaps, which §3 now attaches). `publish: {provider: github}` lands in
electron-builder.yml so packaged apps carry `app-update.yml`.

**Platform matrix — what "update itself" means per platform:**

| Platform | Mode | Why |
|---|---|---|
| Windows NSIS | Full: download in background → install on quit (or "Restart now") | electron-updater's NSIS path works unsigned |
| Windows portable | Notify-only → open the release page | A portable exe cannot replace itself |
| macOS (unsigned) | Notify-only → open the release page | Squirrel.Mac refuses unsigned updates; full auto-update turns on when code signing lands (flip one flag) |

macOS builds are additionally **ad-hoc signed** after packing
(`scripts/mac-adhoc-sign.cjs`, electron-builder `afterPack`): with
`identity: null` alone the packaged app's stale Electron signature is
INVALID, and Apple Silicon Gatekeeper shows the dead-end "Epo is damaged"
dialog (no Open Anyway; terminal-only rescue). Ad-hoc signing restores the
normal unidentified-developer flow. This is not Developer-ID signing or
notarization — those remain the later, paid step.
| Dev run (`!app.isPackaged`) | Disabled | electron-updater requires a packaged app |

**Hard rules (each one is load-bearing):**

- `autoDownload = false` always, and `checkForUpdatesAndNotify()` is never
  used (it auto-downloads). On unsigned macOS the signature failure fires
  DURING `downloadUpdate()` (MacUpdater feeds Squirrel.Mac as it downloads),
  so notify-only means the download call simply never happens there.
- Windows portable is detected via `process.env.PORTABLE_EXECUTABLE_DIR`
  (electron-builder sets it) → notify-only, or NsisUpdater would corrupt a
  portable install.
- The explicit "Restart and update" button uses `quitAndInstall()` — for
  NSIS it runs the installer before quitting, immune to the app's
  `before-quit → preventDefault → app.exit(0)` shutdown path. The passive
  `autoInstallOnAppQuit` path stays enabled but is a bonus, not the
  contract, until verified once on a real Windows install.
- The updater is wired ONLY from `main.ts` (like the connectivity monitor)
  and never touches `foundation-wiring` — jest constructs `Foundation`
  directly with no electron mock, and `electron-updater` requires electron
  at module load. Everything testable (mode selection, benign-error
  classification, status shapes) lives in an electron-free module
  (`src/main/update-core.ts`) with its own suite.
- Benign feed outcomes collapse to `idle` (log once, no toast): HTTP 404
  (private repo today), "No published versions" (zero releases today),
  and offline/DNS errors. The only error class surfaced to the user is a
  failed download on the full path (e.g. checksum mismatch).

**Main process** (`src/main/updater.ts`):

- Check on launch + every `UPDATER.CHECK_INTERVAL_MS` (6 h, timing registry,
  `unref` — never keeps the app alive). A check is stateless and cheap, so
  "work due while closed" is satisfied by the launch check (PRINCIPLES §3).
- State machine pushed to the renderer over a new `updateStatus` push channel
  (mirroring `pruneStatus`): `idle | checking | available | downloading |
  ready | error`, with version, notes URL, and download progress. The UI
  mirrors updater state live (PRINCIPLES §2).
- While the repo is private, unauthenticated feed checks 404: logged once at
  info, surfaced as `idle` — never an error toast.
- No silent restarts, ever: `autoInstallOnAppQuit` installs on a quit the
  user initiated; the "Restart and update" button goes through the existing
  confirm flow when the engine or a prune is running.

**Renderer**: a small "Updates" card in Settings (current version, status
line, Check now / Restart and update / Download buttons per state) plus one
toast when an update becomes ready — suppressed while the intro tour is
open (the tour runs over a quiet app). No new settings knobs — the check is
passive and unconfigurable, like the connectivity probe.

**Honesty consequence**: the README's Compatibility row says the app talks
to "Instagram only". With an updater it also calls github.com for the
update feed, so that one row gets the correction. The FAQ's "no Epo server
and no analytics" line stays — both remain true.

## 6. Failure modes considered

- Bump pushed with failing gates → no tag exists; fix forward and the next
  push releases. Nothing to clean up.
- Two bumps racing → `concurrency: auto-release` serializes; the second run
  sees the tag exists and no-ops.
- Release job dies after tagging → rerun via `workflow_dispatch`; detect
  sees the tag and skips, so the fix is `gh release` repair, not a re-tag
  (documented in the workflow header).
- Updater feed unreachable / rate-limited → `idle`, retry at the next tick.
- User on portable/mac clicks Download → browser opens the release page;
  the app never half-installs.
