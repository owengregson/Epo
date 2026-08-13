<!--
  Epo release-notes template. release.yml creates each release as a DRAFT
  with an auto-generated changelog; the maintainer shapes the draft with the
  structure below before publishing. Replace the {{...}} tokens by hand:
    {{VERSION}}       the release tag (e.g. v3.1.0)
    {{PREVIOUS_TAG}}  the previous release tag (for the compare link)
  Voice: benefit first, one idea per bullet, no hype words.
-->

# Epo {{VERSION}}

## Highlights

<!-- 2–5 user-facing bullets. What can someone DO now that they couldn't before? -->

-
-

## Changes

<!-- Keep the auto-generated "What's Changed" commit list here, pruned of
     noise (chore/ci bumps can be collapsed into one line). -->

## Install

Download the package for your OS from the assets below.

**macOS**

- `Epo-{{VERSION}}.dmg` — open and drag Epo to Applications (recommended)
- `Epo-{{VERSION}}-mac.zip` — unzip and move `Epo.app` wherever you like

**Windows**

- `Epo-Setup-{{VERSION}}.exe` — NSIS installer (recommended)
- `Epo-{{VERSION}}-portable.exe` — no install; runs from any folder

> **These builds are unsigned.** Code signing and notarization are planned
> for a later release.
>
> - **macOS** will report the app "cannot be opened because the developer
>   cannot be verified". Right-click `Epo.app` → **Open** → **Open** (needed
>   once), or clear the quarantine flag from a terminal:
>   `xattr -d com.apple.quarantine /Applications/Epo.app`
> - **Windows** SmartScreen may warn on first run: click **More info** →
>   **Run anyway**.

## Notes

- Your local database and session data carry over — updating is a drop-in
  replacement.
- Epo automates Instagram actions; use it at your own risk (see the README).

**Full Changelog**: https://github.com/owengregson/Epo/compare/{{PREVIOUS_TAG}}...{{VERSION}}
