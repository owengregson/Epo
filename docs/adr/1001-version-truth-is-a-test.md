# 1001 — Version truth is a test, not a bump list

Status: accepted (2026-09-02)

## Context

`npm outdated` returned four rows on the day this was written, two of them
single patches. The stack was, by that measure, current. It was also wrong in
two places that no bump could fix:

- `@types/better-sqlite3@9.6.0` typed a `better-sqlite3@13.0.3` runtime — four
  majors of hand-written types describing a different library. DefinitelyTyped
  has no 13.x to move to, so "up to date" and "correct" pointed at different
  versions.
- `@types/node` typed one Node while the main process ran another. Electron
  bundles its own Node (44.1.1 → **24.19.0**, verified from the binary); a
  `node:` API that exists only in a newer line type-checks green and throws at
  boot.

The same class of defect lived in the bundler. `esbuild.config.mjs` carried
`target: 'node18'` and `target: 'chrome150'` as literals. Electron 44 ships
Chromium **152**; a stale literal compiles fine and emits down-levelled output
nobody asked for. Three workflows pinned Node `25.x`, a line the app never runs
on. None of this is visible to Dependabot, because every individual version is
the latest one published.

## Decision

**Derive the numbers from the binary, and assert the derivation.**

- `.node-version` holds the major Electron bundles (`24`). Every workflow reads
  it (`node-version-file`), and CI's matrix is generated from it plus an `lts/*`
  canary leg that starts differing on its own the day the next LTS is cut.
- `scripts/gen-targets.mjs` runs `ELECTRON_RUN_AS_NODE=1 electron -p
  'JSON.stringify(process.versions)'` and writes `build/targets.generated.json`
  (`node24` / `chrome152`, plus the three full version strings it derived them
  from). `esbuild.config.mjs` reads its targets from that file and warns loudly
  when it falls back to literals. `npm run gen:targets:check` is a gate, in the
  same shape as `npm run build:page:check`.
- `tests/tooling/deps-verify.test.ts` asserts the agreements, reading INSTALLED
  versions out of `node_modules/*/package.json` — never the ranges in
  `package.json`, which are wishes:
  `major(@types/node) === major(electron's node)`; the targets file matches the
  Electron that is installed; `.node-version` is that same major;
  `electron-builder ≥ 26.16.0`; every `resolved` in the lockfile points at
  `registry.npmjs.org`.
- `@types/better-sqlite3` vs `better-sqlite3` ships as `test.failing` — the
  drift is real, there is no version to bump to, and the fix is the driver swap
  that deletes the dependency. `test.failing` fails when the body starts
  passing, so the expiry is enforced rather than remembered.
- Dependabot grows one group, `electron-toolchain`, because `electron`,
  `@types/node`, `electron-builder` and `@electron/rebuild` are ABI-coupled:
  split across PRs, the tree is red in between by construction.

`electron-builder` is pinned off its `v26` tag. Its `latest` dist-tag is
*behind* (`26.15.3` vs `26.16.0`), so `npm outdated` can never surface the newer
release — a second instance of "latest is not true".

## Consequences

- An Electron bump is now one command (`npm run gen:targets`) and a reviewable
  one-file diff, and CI refuses the bump that forgets it.
- `--check` degrades honestly. `npm ci --ignore-scripts` never downloads the
  Electron binary, so CI compares the recorded `electronVersion` against the
  installed `electron` package instead — the drift a dependency bump actually
  causes. It says which mode it ran in; it never silently passes.
- `esbuild.page.mjs` still carries a `chrome150` literal. It is not wired here
  on purpose: changing it changes the committed `bundle.generated.ts`, which
  `build:page:check` guards, so the two changes must land together in the
  adapter's own change. Until then the literal is stale by two Chromium majors
  and the page bundle is compiled down-level — harmless, and tracked.
