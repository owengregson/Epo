# Adapter field notes & capture harness

This directory holds the **live-verified** Instagram shapes that the Adapter
(Reader / Actor / Sentinel, Tasks 7-8) is built and tested against. Those shapes
are captured — never guessed — by the **Task E capture harness**.

## What the harness captures

A one-command Electron app opens a real, visible Instagram window. You log in
once, and it automatically records the RAW artifacts later tasks need:

- **JSON API responses** (raw bodies, pretty-printed): followers-list
  (paginated), `friendships/show_many` (batched relationship status),
  profile-info (follower/following counts), and the activity/notifications feed.
- **DOM snapshots** (`outerHTML`): the profile `<header>` (follow / following
  button area), the followers dialog (`[role="dialog"]` scroll container + row
  structure), and any dialog that appears while you use the page (e.g. the
  unfollow-confirm dialog — captured on a 2s sweep whenever its text changes).
- **Best-effort block/challenge signatures** — anything that surfaces in the
  captured DOM/JSON while a block or checkpoint is shown.

It reuses `InstagramTab` (CDP-based network observation) and depends on nothing
that is not yet built — it captures raw bytes, and a human distils the real
`src/adapter/field-notes.ts` from the output afterward.

## How to run it

```bash
npm run capture
```

This rebuilds `better-sqlite3` for Electron, bundles, and launches the capture
window. Log into Instagram in that window; capture starts automatically once the
`sessionid` cookie is present.

- **Target account:** by default the harness captures **your own** account
  (detected via `accounts/current_user`). To capture a specific account instead:

  ```bash
  PEANUT_CAPTURE_TARGET=<username> npm run capture
  ```

  If your username cannot be detected, the banner will tell you to re-run with
  `PEANUT_CAPTURE_TARGET=<username>`.

- **Manual fallback:** if the followers list does not open automatically, click
  the followers count yourself — passive capture keeps running the whole time.
  To capture the unfollow-confirm dialog, open it manually on a profile you
  follow; the 2s dialog sweep will snapshot it.

Close the window when you are done. The harness then writes its outputs and
prints a summary of what it observed.

## Outputs (feed Tasks 7-8)

Written under `docs/adapter/`:

- `fixtures/raw/<seq>-<classification>.json` — up to 10 raw bodies per
  classification (more are counted in the manifest, not re-saved).
- `fixtures/dom/<name>-<seq>.html` — DOM snapshots.
- `fixtures/manifest.json` — inventory: every observed response
  (seq / url / status / classification / file) + the DOM snapshot list.
- `field-notes-DRAFT.md` — an inventory scaffold with counts, file lists, and
  empty TODO sections for endpoints / selectors / signatures to distil into
  `src/adapter/field-notes.ts` and the final `field-notes.md`.

> **Privacy:** the captured payloads contain your real Instagram data.
> `fixtures/raw/`, `fixtures/dom/`, `fixtures/manifest.json`, and
> `field-notes-DRAFT.md` are git-ignored and **must not be committed**. Only this
> `README.md` and `fixtures/.gitkeep` are tracked.
