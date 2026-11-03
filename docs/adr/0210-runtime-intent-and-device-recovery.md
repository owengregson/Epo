# 0210 — Durable run intent and one device recovery owner

Status: accepted

The desktop process, the Instagram renderer, and a growth run have different
lifetimes. Previously a restart of any one of them looked like a new manual
Start. A wake could undo Stop; an offline wait looked wedged; a prune handoff
resumed growth without returning the tab lease.

`RuntimeCoordinator` now owns durable user intent independently of engine state.
Every user command advances an epoch. Wake and watchdog continuations capture
that epoch and may restart only if it still belongs to the current running
intent. A deliberate window close or Quit persists stopped intent. Process loss
does not: the next launch checks identity and the durable blocked state before
asking the engine to perform its reentry reconciliation. This is a recovery
contract, not a promise to work while the computer is asleep or the application
is closed. An external launcher may retry process crashes, but it must not
reinterpret intentional Quit or a terminal blocked state as authorization.

Suspension aborts a shared device signal carried by every tab-driving operation,
stops prune, and stops active growth. Wake admits no new driver until the common
health and sentinel checks finish. A user Stop during those checks does not
prevent the device from becoming ready; it prevents growth from restarting.

All machinery repairs pass through one single-flight coordinator. Three repair
attempts are allowed in a rolling hour, durably across process restarts. The
window exceeds several eight-minute watchdog windows, so repeated watchdog
restarts cannot evade the budget by aging out between attempts. A reload does
not reset this budget. Platform refusals retain their independent rate-limit
recovery ladder. Failures and blocked reasons are stored in a bounded incident
history and included in status projections. Persistence failures block new work
without preventing Stop from reaching the engine.

The watchdog observes explicit progress, not status publication. Offline waits
and registered pacing holds do not trigger repairs. Engine exception handling
separately detects repeated failed steps so a healthy heartbeat cannot conceal
a bot that repeatedly fails to do work.

The tab lease returns to growth before growth resumes. Prune claims carry a
generation, so a stale completion cannot release a newer driver's lease.
Scans, as well as bulk runs, have a tracked drain promise. Scheduled maintenance
uses the same bounded growth handoff as manual scans, so a continuously running
growth engine cannot starve it. Manual operations are mutually exclusive and
share the device cancellation signal.

Standalone manual/prune writes first run the shared effect reconciliation and,
when required, a fresh relationship check under their existing tab ownership.
This does not launch growth. Preparation has its own cancellation lifetime;
an old prune abort cannot cancel a new check, and Stop can cancel that check
before a mutation is admitted. An incomplete check returns the borrowed lease.

The existing dashboard surfaces admission blocks, intentional waits, reentry,
useful progress, and source revisit eligibility. Cancel remains available while
a saved run intent is recovering with no active engine loop. The dashboard
renderer itself has three reload attempts per ten minutes, including failed
and hung loads. Exhausting them stops both drivers and persists an incident.
`npm start`/`npm run dev` supervise abnormal main-process exits with three
delayed retries; clean exits and termination signals never launch a replacement.
No OS login/boot service is installed by this change.

Startup composition failures persist a block before releasing any partially
built resources. Cleanup gets fifteen seconds and the diagnostic drain two
seconds, then the process exits nonzero for the bounded launcher. A repaired
launch can restore controls, but the saved block prevents account activity
until an explicit Start. An intentional shutdown already in progress keeps its
clean-exit semantics. Driver/device cancellation signals are cached by token
pair so read-side generation checks see a stable identity during one operation.

Identity is checked even after graph construction, and before admitted effects.
Changing identity revokes the old run and resets account-specific cadence
timestamps. The first bound identity retains the legacy `epo.db`; subsequent
identities use separate account database files. An automatic restart must match
the identity that authorized the saved running intent. A data clear removes all
account databases and resets that binding.

Regression coverage lives in `tests/main/runtime-coordinator.test.ts` and
`tests/main/runtime-lifecycle.test.ts`, alongside the existing sleep, lease,
teardown and connectivity suites. They use fake browser ports and temporary
databases; they do not establish a multi-day native-device soak result.
`desktop-supervisor.test.ts` launches isolated Node children to exercise actual
crash/clean exits, and dashboard recovery tests use fake timers rather than the
live account. Runtime logs have separate rotation, overflow, shutdown-drain,
and disk-failure coverage.

The driver/device abort signal is cached for a stable pair of underlying tokens.
Generation identity comparisons must not see a new composite signal on every
read. Startup composition failures persist a block even before Foundation
exists, drain cleanup/logs within a bounded deadline, and exit nonzero for the
launcher. An intentional shutdown that already owns exit retains precedence.

## Amendment — 2026-11-02: crash resume after the reveal, under the startup lease (ADR 1010)

A running intent a crash left behind still resumes automatically, but as the
last step of the startup sequence: after the renderer reports the reveal (or
`BOOT.SETTLE_DEADLINE_MS` passes, so the resume never depends on the intro),
after the landing and the account confirmation, under the `'startup'` tab lease
claimed when the store opened. The identity check is unchanged (cookie pk =
authorized account, else `login-required` / `account-changed`). While the lease
is held a user Start is queued — never refused with `manual-running` — and a
Stop cancels the remaining steps and any queued Start. Manual one-offs and prune
scan/run are refused with `'starting'`. The engine still starts idle at every
other launch. A block raised before the graph exists pushes the real status
(`loggedIn` from the cookie) instead of a signed-out one.
