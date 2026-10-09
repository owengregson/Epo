# Adapter field notes & capture harness

This directory holds the **live-verified** Instagram shapes that the Adapter
(Reader / Actor / Sentinel, Tasks 7-8) is built and tested against. Those shapes
are captured — never guessed — by the **Task E capture harness**.

## What the harness captures

A one-command Electron app opens a real, visible Instagram window. You log in
once, and it records the RAW artifacts later tasks need:

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
that is not yet built — it captures raw bytes, and a maintainer distils the real
`src/adapter/field-notes.ts` from the output afterward.

## How to run it

```bash
npm run capture
```

This rebuilds `better-sqlite3` for Electron, bundles, and launches the capture
window. Log into Instagram in that window; capture starts once the
`sessionid` cookie is present.

- **Target account:** by default the harness captures **your own** account
  (detected via `accounts/current_user`). To capture a specific account instead:

  ```bash
  EPO_CAPTURE_TARGET=<username> npm run capture
  ```

  If your username cannot be detected, the banner will tell you to re-run with
  `EPO_CAPTURE_TARGET=<username>`.

- **Manual fallback:** if the followers list does not open on its own, click
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

---

## The scrubbed contract corpus (2026-09, wave A)

The fixtures above are still git-ignored real data. What CI runs against is a
**scrubbed** derivative of them, committed at
`tests/fixtures/surface/2026-08-12/{bodies,dom,manifest.json}`.

```bash
EPO_SCRUB=1 npx jest tests/surface/scrub-fixtures   # regenerate from the local capture
npx jest tests/surface                              # leak + replay + control contracts
```

**How it is scrubbed.** `src/surface/lab/scrub.ts` walks the endpoint schema's
shape and applies an ALLOW-LIST driven by the `pii` metadata declared on each
field (`src/surface/schema/endpoints.ts`):

| field | becomes |
|---|---|
| `pii: 'handle'` | a stable pseudonym — `user_a1`, `user_b1`, … |
| `pii: 'name'` | `Name A1`, `Name B1`, … |
| `pii: 'pk'` | a synthetic id in the reserved 12-digit range starting `7` |
| `pii: 'url'` | `https://example.invalid/pic/<id>.jpg` |
| `pii: 'cursor'` | a row offset survives verbatim; an opaque token becomes `cursor.<id>.len<N>` |
| known, non-PII | passes through verbatim (the facts the tests assert on) |
| **key the schema does not know** | **kept, value replaced by its TYPE NAME** |

DOM snapshots get the same pseudonym tables through a markup pass: CDN URLs,
profile hrefs (including deep links like `/<handle>/followers/mutualFirst`),
avatar alt text, every discovered handle wherever else it appears, and every
digit run of 8+ characters.

**Nothing is committed on trust.** The pipeline preseeds its pseudonym tables
from the WHOLE local capture (a followers dialog names accounts whose bodies the
corpus never keeps), then re-reads each scrubbed file with the originals in hand
and DROPS any file that still carries one — recorded in `manifest.dropped`.
`tests/surface/leak.test.ts` is the gate: structural checks that need no
originals run everywhere including CI, and a direct differential check runs
wherever `fixtures/` exists.

**What the corpus contains** (chosen for SHAPE diversity, not volume — ~130 KB):
four followers pages including one with no `next_max_id` (the end-of-list shape
ADR 0303 is about) and one carrying `groups`; a `friendships/pending/` body whose
`pk` is a NUMBER rather than a string; `show_many`; `friendships/show`;
`web_profile_info`; and five DOM snapshots covering the header action button,
the `<a href="#">` stats, a confirm row shipped as a real `<button>`, one shipped
as nested spans inside a `div[role=button]`, and a list dialog with a scroller.

`manifest.missing` names the corpus's blind spots — the 2026-08-12 capture never
opened the notifications drawer, so `activity-feed` has no body, and
`following-list` shares the followers-list shape and was never separately
recorded. Both are asserted, so "unverified" is stated rather than assumed.

## `surface-lab` — one tool, five subcommands

`src/surface-lab/main.ts` is the front door to what used to be three separate
Electron apps. The three original entry points (`npm run capture`,
`npm run inspect`, `npm run livetest`) keep working unchanged.

| subcommand | needs Electron | what it is |
|---|---|---|
| `capture` | yes | passive capture of real responses + DOM (this document) |
| `inspect` | yes | click-to-capture element instrumentation |
| `smoke` | yes | the live action test |
| `replay` | **no** | re-parse the committed corpus through the active surface |
| `diff` | **no** | corpus shape digest vs the endpoint schemas |

`replay` and `diff` need no browser and no session, which is what lets the
contract the corpus encodes run in CI. `diff` reports three classes —
`required-but-rare`, `novel`, `type` — as an authoring aid; the schemas stay
human-owned (see ADR 0801 on why generating them from fixtures overfits).
