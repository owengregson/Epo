# Offline UI verification

Build the checkout under review, then launch it with a fresh profile and the Instagram network block:

```sh
npm run build:dev
EPO_QA_PROFILE=$(mktemp -d "${TMPDIR:-/tmp}/epo-qa.XXXXXX")
EPO_USER_DATA_DIR="$EPO_QA_PROFILE" EPO_BLOCK_NETWORK=1 node scripts/run-desktop.mjs
```

Keep both environment settings on every QA launch. `EPO_USER_DATA_DIR` selects the throwaway profile before app
identity is set; `EPO_BLOCK_NETWORK` prevents the embedded Instagram partition from reaching Instagram. Never copy
cookies or an account store into this profile. Quit this instance before any subsequent Electron check.

The development renderer's `index.html?gallery=1` uses fixtures. Its scenario controls cover sidebar postures,
Settings Easy and Advanced, Prune, People and the boot sequence. Hide the gallery rail when checking the actual
viewport dimensions. Check widths 1024, 1440 and 1920 and heights 640, 800, 920 and 1200, with normal and reduced
motion. A browser fixture check does not validate the native Instagram view, window restoration or keyboard focus;
those require the isolated desktop launch.

The local background probe creates its own temporary profile and loopback page:

```sh
node scripts/background-probe.mjs --soak-ms 10000 --output /tmp/epo-background-qa.json
```

It never loads the account's Instagram partition. Record all scenario results and the dashboard callback rate in
the release's QA record. The plan-derived overhaul requires all ten scenarios to pass and at most 150 dashboard
callbacks per second.

See [the plan-derived overhaul record](plan-derived-overhaul-2026-11.md) for the validation state and the separate
live-account checks.
