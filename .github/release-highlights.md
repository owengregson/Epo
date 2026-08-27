<!-- v3.0.1 -->

- Epo now updates itself: Windows installs download new versions in the
  background and apply them on restart; macOS shows new versions in
  Settings → Updates and brings you to the download page.
- Intel Macs get native builds again — `Epo-3.0.1-x64.dmg` joins the
  Apple-silicon build (v3.0.0 shipped arm64 only).
- Release notes, packages, and the update feed are now produced by one
  gated pipeline: nothing is published unless the full test, packaging,
  and boot checks pass first.
