# 0503 — The native rebuild scripts stay until a two-platform smoke test

Status: accepted (2026-09-02) — open question, deliberately not closed

## Context

`npm run rebuild:electron` (`electron-rebuild -f -w better-sqlite3`) and
`npm run rebuild:node` (`npm rebuild better-sqlite3`) prefix five npm scripts —
`start`, `dev`, `capture`, `livetest`, `inspect`, `test` — and one CI step. The
model they encode is "the native addon must be compiled per ABI, and Electron's
ABI differs from Node's".

For `better-sqlite3@13` the evidence says that model no longer holds:

- `node_modules/better-sqlite3/package.json` has `gypfile: false` and **no**
  install or postinstall script; it depends on `node-addon-api ^8`.
- Eight platform prebuilds ship in `prebuilds/`, and `lib/binding.js`
  `getPrebuildPath()` keys **only** on `process.platform`/`process.arch` with
  no ABI check — consulted *before* the `build/Release` fallback.
- `nm -u prebuilds/darwin-arm64.node` imports 60 `napi_*` symbols. Node-API is
  ABI-stable across Node *and* Electron.
- `find node_modules/better-sqlite3/build -name '*.node'` returns **0**: every
  past rebuild produced nothing that is ever loaded.
- `npm rebuild better-sqlite3` measures 0.37 s, because there is no lifecycle
  script to run.

## Decision

Drop `-f` from `rebuild:electron` — the installed CLI documents it as "Force
rebuilding modules, even if we would skip it otherwise", so it was actively
defeating the tool's own skip logic on every launch. Keep both scripts.

"Verified on this Mac under Node 25" is not "verified under Electron 43 on
Windows". Deleting them is a one-line change whenever someone runs the proof;
shipping a broken `npm run dist` because the proof was skipped is not
recoverable in the same afternoon.

## The proof that would close this

1. `npm start` on macOS and on Windows — the store opens, migrations run.
2. `npm run dist` on macOS and on Windows — the packaged app opens its database.

Both with the two scripts removed from every chain. If both pass, delete
`rebuild:node` and `rebuild:electron`, drop the CI step, and correct
`.github/workflows/ci.yml`'s comment.

Keep `asarUnpack: ["**/node_modules/better-sqlite3/**"]` in
`electron-builder.yml` either way — the prebuild still cannot load from inside
an asar archive, and that is unrelated to ABI.
