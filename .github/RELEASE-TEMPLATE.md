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
  bullet, no hype words.
-->

<p align="center">
  <img src="https://raw.githubusercontent.com/owengregson/Epo/{{VERSION}}/project/assets/release/banner.svg" width="860" alt="Epo {{VERSION}}">
</p>

<p align="center">
  <code>macOS (Apple silicon · Intel)</code>
  <code>Windows 10 / 11</code>
  <code>open source (MIT)</code>
  <code>local-first</code>
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
  <img src="https://raw.githubusercontent.com/owengregson/Epo/{{VERSION}}/project/assets/release/headers/install.svg" height="42" alt="Install">
</p>

<p align="center">
  <a href="https://github.com/owengregson/Epo/releases/download/{{VERSION}}/Epo-{{VERSION_NUMBER}}-arm64.dmg"><img src="https://raw.githubusercontent.com/owengregson/Epo/{{VERSION}}/project/assets/release/buttons/mac-arm64.svg" height="46" alt="Download for macOS (Apple silicon)"></a>
  &nbsp;&nbsp;
  <a href="https://github.com/owengregson/Epo/releases/download/{{VERSION}}/Epo-{{VERSION_NUMBER}}-x64.dmg"><img src="https://raw.githubusercontent.com/owengregson/Epo/{{VERSION}}/project/assets/release/buttons/mac-x64.svg" height="46" alt="Download for macOS (Intel)"></a>
  &nbsp;&nbsp;
  <a href="https://github.com/owengregson/Epo/releases/download/{{VERSION}}/Epo-Setup-{{VERSION_NUMBER}}.exe"><img src="https://raw.githubusercontent.com/owengregson/Epo/{{VERSION}}/project/assets/release/buttons/windows.svg" height="46" alt="Download for Windows"></a>
</p>

One click downloads the right package. First launch: **macOS** blocks
un-notarized apps — dismiss the dialog, then **System Settings → Privacy &
Security → Open Anyway** (needed once). **Windows** SmartScreen may warn —
**More info → Run anyway**. A no-install Windows build,
`Epo-{{VERSION_NUMBER}}-portable.exe`, is in the assets below.

**Already running Epo?** Windows installs update themselves in the
background; macOS shows the new version in Settings → Updates and brings
you here.

<p align="center">
  <img src="https://raw.githubusercontent.com/owengregson/Epo/{{VERSION}}/project/assets/release/headers/notes.svg" height="42" alt="Notes">
</p>

- Your database, settings, and Instagram session carry over — updating is a
  drop-in replacement.
- Every other asset below (`.zip`, `.blockmap`, `latest*.yml`) is the
  self-updater's feed — apps update themselves from these files.
- Epo acts on your Instagram account; use it at your own risk (see the
  README).

**Full changelog**: https://github.com/owengregson/Epo/compare/{{PREVIOUS_TAG}}...{{VERSION}}
