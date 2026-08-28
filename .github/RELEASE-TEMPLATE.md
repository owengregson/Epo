<!--
  Epo release-notes template. The release workflow substitutes the tokens
  LITERALLY (no regex) and strips this comment:
    {{VERSION}}         the release tag (e.g. v3.1.0)
    {{VERSION_NUMBER}}  the bare version (e.g. 3.1.0) — asset filenames
    {{HIGHLIGHTS}}      .github/release-highlights.md (marker-guarded)
    {{CHANGELOG}}       git log <previous>..HEAD, one line per commit
    {{PREVIOUS_TAG}}    the previous release tag (compare link)
  The banner and plates resolve at the TAG ref, so each release page keeps
  its own version-stamped art forever. Voice: benefit first, one idea per
  bullet, no hype words. Layout: Install first (banner → buttons), then
  Highlights → Changes → Notes — keep the page lean, no badge strips or
  instruction walls.
-->

<p align="center">
  <img src="https://raw.githubusercontent.com/owengregson/Epo/{{VERSION}}/project/assets/release/banner.svg" width="860" alt="Epo {{VERSION}}">
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/owengregson/Epo/{{VERSION}}/project/assets/release/headers/install.svg" height="42" alt="Install">
</p>

<p align="center">
  <a href="https://github.com/owengregson/Epo/releases/download/{{VERSION}}/Epo-{{VERSION_NUMBER}}-arm64.dmg"><img src="https://raw.githubusercontent.com/owengregson/Epo/{{VERSION}}/project/assets/release/buttons/mac-arm64.svg" height="46" alt="Download for macOS (Apple silicon)"></a>
  &nbsp;&nbsp;
  <a href="https://github.com/owengregson/Epo/releases/download/{{VERSION}}/Epo-{{VERSION_NUMBER}}-x64.dmg"><img src="https://raw.githubusercontent.com/owengregson/Epo/{{VERSION}}/project/assets/release/buttons/mac-x64.svg" height="46" alt="Download for macOS (Intel)"></a>
  &nbsp;&nbsp;
  <a href="https://github.com/owengregson/Epo/releases/download/{{VERSION}}/Epo-Setup-{{VERSION_NUMBER}}.exe"><img src="https://raw.githubusercontent.com/owengregson/Epo/{{VERSION}}/project/assets/release/buttons/windows.svg" height="46" alt="Download for Windows"></a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/owengregson/Epo/{{VERSION}}/project/assets/release/headers/highlights.svg" height="42" alt="Highlights">
</p>

{{HIGHLIGHTS}}

<p align="center">
  <img src="https://raw.githubusercontent.com/owengregson/Epo/{{VERSION}}/project/assets/release/headers/changes.svg" height="42" alt="Changes">
</p>

<details>
<summary>Every commit since {{PREVIOUS_TAG}}</summary>

{{CHANGELOG}}

</details>

<p align="center">
  <img src="https://raw.githubusercontent.com/owengregson/Epo/{{VERSION}}/project/assets/release/headers/notes.svg" height="42" alt="Notes">
</p>

- First launch: **macOS** — dismiss the dialog, then **System Settings →
  Privacy & Security → Open Anyway** (needed once). **Windows** — More
  info → Run anyway. A no-install build, `Epo-{{VERSION_NUMBER}}-portable.exe`,
  is in the assets below.
- Your database, settings, and Instagram session carry over — updating is a
  drop-in replacement. Installed apps update themselves from the
  `latest*.yml` / `.blockmap` assets below.
- Epo acts on your Instagram account; use it at your own risk (see the
  README).

**Full changelog**: https://github.com/owengregson/Epo/compare/{{PREVIOUS_TAG}}...{{VERSION}}
