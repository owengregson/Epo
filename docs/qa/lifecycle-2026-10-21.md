# Lifecycle implementation validation — 2026-10-21

## Local native transport check

`node scripts/background-probe.mjs --soak-ms 10000` passed all nine scenarios using the production tab/input driver, a temporary Electron profile, and a loopback fixture. No Instagram session or remote account was loaded.

Dashboard pacing: 120.2 fps on the measured 120.0 Hz display. Global frame-rate limiting remains enabled; the earlier scoped Instagram-renderer workaround is preserved.

| Scenario | Result | Measured interval | Trusted clicks |
| --- | --- | ---: | ---: |
| foreground | PASS | 7.0 s | 8 |
| occluded-unfocused | PASS | 8.4 s | 8 |
| minimized | PASS | 7.7 s | 8 |
| window-hidden | PASS | 8.0 s | 8 |
| app-hidden | PASS | 7.9 s | 8 |
| stage-hidden | PASS | 7.2 s | 8 |
| hidden-after-navigation | PASS | 7.8 s | 8 |
| hidden-after-recovery | PASS | 7.0 s | 8 |
| hidden-long-soak | PASS | 13.5 s | 8 |

The probe also rejected replaced and covered click targets, verified renderer-health checks, exercised hidden navigation and debugger reattachment, and observed timer/input acknowledgments. The additional hidden interval was ten seconds requested (the gesture sequence extended its actual measurement). This is a short regression probe, not a multi-day soak.

Raw evidence: [lifecycle-native-2026-10-21.json](lifecycle-native-2026-10-21.json).

## Architecture and deterministic validation

Three parallel implementation/review tracks covered device lifecycle, network exploration, and absence recovery. Cross-path integration tests cover durable intent, sleep/wake races, identity change, exclusive leases, actual isolated child-process crash/restart behavior, dashboard failure budgets, rotating diagnostics, source fairness, mature outcomes, durable read reservations, journal settlement, unknown dispatched writes, long absences, and partial reconciliation.

`npm run check` verifies generated targets/tokens, production and test types, lint, dependency boundaries, page bundles, all tests and the development build. Final run passed: 192 test suites, 2,043 tests; one suite/two tests were skipped. The production `npm run build` also passed. Dependency checks reported zero errors (the repository permits warning-level migration entries); lint passed with existing warning-level findings. `git diff --check` passed. No line-budget ceiling was increased; large modules were split and the allow-list ratcheted downward.

## Unverified operational conditions

- No live follow/unfollow/accept actions were sent, and the user’s running production instance was not restarted.
- No forced OS sleep, lid-close, display-off, long network outage, or multi-day native soak was performed. Wake and outage transitions use deterministic lifecycle tests.
- The launcher retries abnormal main-process exits. It is not an external event-loop heartbeat monitor, OS startup service, or a guarantee of unattended operation.
- Exploration shares, revisit periods, probation and read allowances are provisional policy values. Their effect on actual network breadth and follow-back yield requires production observation.
