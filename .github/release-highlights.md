<!-- v3.0.2 -->

- macOS builds now open the normal way. v3.0.0 and v3.0.1 hit Gatekeeper's
  "Epo is damaged" dead end on Apple silicon; the app is now properly
  ad-hoc signed, so first launch is just System Settings → Privacy &
  Security → Open Anyway.
- Update checks stay quiet on builds that cannot self-update instead of
  showing an error in Settings → Updates.
