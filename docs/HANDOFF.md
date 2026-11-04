# Peanut v3 — Overnight Build Handoff

> **2026-11-03 (plan-derived overhaul continuation; offline verification in progress) —** Owner:
> "Read docs/superpowers/plans/2026-11-03-plan-derived-overhaul-handoff.md and continue the overhaul from it until completion."
> The final retirement stream is merged, including the Cautious floor change to 70 s. The integration now uses the day
> plan for action spacing and interaction timing, with durable Boost, bounded reopen checks, Settings Easy/Advanced,
> Prune, the new sidebar and the store-first launch. Review reproduced these remaining causes:
>
> 1. Session boundaries lost planned actions, while repeated re-plans could count used work twice or reclaim discarded
>    work. Prune also needed the ledger's per-session unfollow share.
> 2. The first following list mixed existing stock with today's outside activity; later Epo follows and delayed private
>    acceptances could be charged again as manual follows.
> 3. Recovery, mutation arbitration and list completion had paths around transport or partial-evidence checks. Stored
>    profile counts could substitute for missing fresh follow proof.
> 4. Protection and Practice edits during a visit or between confirmation layers could arrive after the last policy
>    check. An already-open accept pass could likewise keep a stale allowance.
> 5. Delayed renderer reads could overwrite pushes; derived Settings views can change without a document revision;
>    initial queued or parked work could show an incorrect posture.
> 6. Numeric cleanup-share overrides did not reach plan allocation. Refused v1 migration lost schedule constraints,
>    and failed bookkeeping consumption or backup restoration could reuse another account's freshness stamp.
> 7. Probation slowed sessions after placement without respecting the quiet-hours wall, leaving planned actions
>    that could never run.
>
> FIXES (ADR 0105, 0607, 0608, 0213, 0214, 0308, 0806, 0904, 1010, 1011):
>
> - Realize session budgets at their exact boundaries; preserve used and forfeited work through re-plans, respect the
>   quiet-hours wall, and apply the ledger's kind budgets to Prune.
> - Separate following stock from dated outside gains and exclude successful Epo/manual writes from duplicate charges.
> - Require transport-qualified, complete evidence for destructive verdicts and current count proof before a follow.
> - Recheck current protection and Practice at each press using the action's existing visit, with one admission and
>   journal dispatch. Revalidate accept passes against the current plan.
> - Retire the v1 runtime bridge, fixed scan timing and obsolete renderer state; preserve frozen migration inputs and
>   raw protection. Keep current pushed state authoritative through bootstrap and Settings changes.
> - Apply numeric cleanup-share overrides to the plan and its digest. Preserve refused-v1 quiet hours, slower reads,
>   lower caps, slower motion and tour state; bind migration bookkeeping durably to its account before consumption.
> - Fit probation inside the same quiet-aware close as normal sessions, reduce its kind allocations to fit, and carry
>   probation to the next viable session when the current slot cannot hold one slower action.
>
> The full gates at `42ee233` and `86a716d` each passed **425 suites / 4,402 tests**, five skipped, zero TODO, and
> boundaries **0 errors / 56 warnings** (97 at the original overhaul start). Plan QC passed **1,260 days / zero breaches**,
> all three lifecycle reachability tests passed, and the generated catalog is current. The cleanup audit found no new
> blocker: pending wiring is empty, static timing contains only reasoned GEOM/HARNESS entries, and the saved Knip
> comparison has no added findings (remaining advisory findings are recorded, not claimed to be zero).
> The isolated normal-motion gallery at `44ea8d4` passed **756 checks**. At `04f5688`, the full reduced-motion matrix
> passed **756 checks** and the three populated normal-motion scenarios passed **36 settled checks**. The background
> probe passed **10/10 scenarios**, including stage-hidden and never-shown boot, at about **120 callbacks/s**; its exact
> bundle hash is recorded. Native QA at `86a716d` exercised the intro, offline placeholder, stage shortcuts, Settings
> save/Undo, Practice persistence, Protection navigation and clean quit. It found the Electron version in the footer,
> a tour step that did not scroll to the seed field, and search results underneath the plan summary.
> The branded-runtime classification fix is merged at `aa31274` with focused tests passing; native re-verification is
> pending. Tour scrolling and search stacking repairs are ready at `bd41d98`, with focused tests passing and integration
> and native verification pending. Offline completion, the final post-fix
> gate/native observations and the pre-live checkpoint are still pending. Exact revisions, artifacts and upgrade notes
> are in the
> [validation record](qa/plan-derived-overhaul-2026-11.md).
> No live-account check has run in this continuation. The integration has not opened the real Epo profile. Phase L
> remains sequential and supervised; back up the full profile again before L1, mutations require explicit target
> consent, and L4 requires a night away. Empty/null biography semantics still need live evidence; null remains absent
> and fail safe. Legacy parser comparators stay until L1 and L4 show zero disagreements.

> **2026-11-02 (read allowance derived, not hardcoded) —** Owner: "it
> shouldnt be hardcoded everything should be via our dynamic limit system."
> `ReadBudget`'s 80/40/200/24/24 defaults are gone. Kernel D6
> (`src/kernel/derive-reads.ts`, ADR 0211 amended) derives every ceiling from
> the live `Settings` limits: daily ceiling, plan size, sweep cadence and
> sessions. The governor reads `limits()` on every check, so settings changes
> apply at once. `EXPLORATION_POLICY` moved into the kernel (the engine file
> is a shim). Tests build budgets with `tests/kit/read-limits.ts`. Live
> install: 415 profile visits a day (189 exploration), 227 list pages, 28
> notification reads. That covers the 98-a-day ceiling, which 80 never could.

> **2026-11-02 (latest — "it didn't do anything all day") —** The log showed
> two return checks (25 profile visits each), then `holding {reason:
> reconcile-backoff}` until the next morning, and no follows all day. The live
> `lifecycle_state` showed `phase: reconcile, reason: absence`, with the epoch
> stamped at the 14:16 session resume, although the engine had run all night.
> Three defects compounded:
>
> 1. **The engine's own holds counted as absence.** `lastActiveAt` moved only
>    on progress, so any park over 1 h looked like the owner had left. That
>    covers the overnight session park, active hours, ceilings and long idle
>    beats. Every resume re-ran the return check and reset return probation,
>    so probation could never finish.
> 2. **Every return was a census.** `requireFresh` re-read EVERY managed
>    record, one visit each (55 here), against an 80-visit rolling allowance
>    that per-follow verification also draws from. Two returns spent the day.
> 3. **A known reopen time was noised as a retry.** The budget wait went
>    through `retry-backoff` (0.5–2×), so 11.5 h became 19.9 h, and the
>    caption said "couldn't read follow-backs".
>
> FIXES (ADR 0212 amended):
>
> - Every engine wait brackets `reentry.holdUntil(deadline)` /
>   `endHold(now)`. A hold is presence up to its deadline. Time slept PAST
>   the deadline, a stop, or a restart mid-hold is still away. This is
>   in-process only.
> - `reentry.requiresCensus()` is true only for `clock-change` /
>   `legacy-state`, and a later absence cannot downgrade an owed census. An
>   absence reconciles what its timers made due.
> - A budget deferral parks as `engine:read-budget-park` (`daily-boundary`:
>   never before the reopen, ≤ 40 min after), reason `read-budget`, caption
>   "profile-read allowance used · resumes …".
>
> On the live DB the next start needs 0 visits: all 32 due records carry
> evidence from the last day. The spent allowance reopens from ~01:52 local
> as the morning's debits age out.

> **2026-11-02 (later — relationship checks burst through profiles) —** During
> "checking relationships after N days away" the follow-back reconciliation
> visited ten profiles back to back with no gap, parked ~30 s, reopened the
> notifications drawer and repeated (owner: "going so fast through the profiles
> it could get flagged … do it more human like"). FIXES (ADR 0307 amended):
> the ONE shared `TabProfileVisitor` rests a log-normal dwell (median 9 s,
> 5–30 s, `MOTION.profileDwell*`) since the previous visit ended — every caller
> is paced, none can burst; a reconciliation batch that made progress
> continues at the next step instead of parking (`ReconciliationRunner` →
> `progress`); a continuation batch skips the feed it already read. Verified
> live: consecutive profile navigations ~9–11 s apart. Note: the 10-21 read
> budget still caps reconciliation at 80 profile / 24 notification reads per
> rolling day — a large cohort pauses there by design.

> **2026-11-02 (the notifications drawer moved to GraphQL; its close X is half-covered) —**
> Symptom (`npm run start`): `rim.follow-notifications: no activity-feed response
> after click`, then `engine: holding {reason: enrich-backoff}`. One cause, found
> live with the read-only `EPO_PROBE=verify` (traffic recorder attached): the
> drawer's client stopped calling `news/inbox` / `friendships/pending` and reads
> the same stories / request rows through GraphQL
> (`PolarisActivityFeedStoriesViewQuery` on `/api/graphql`,
> `PolarisActivityFeedFollowRequestsViewQuery` on `/graphql/query`). The
> `enrich-backoff` hold was the follow-back reconciliation's wait wearing the
> enrichment key. FIXES (ADR 0307 amended): GraphQL endpoint definitions for
> the `activity-feed` / `friend-requests` kinds, matched by operation name,
> schemas accepting either container and unwrapping to the REST shape;
> extractors unwrap (`adapter/versions/2026-08-12.notifications.ts`);
> `follow-notifications` routes by URL + operation name; the reconciliation
> wait parks as `reconcile-backoff` ("couldn't read follow-backs"). Found on
> the way: the drawer's header now covers the lower half of the close X in
> every view, so every drawer close was refused (the drawer stayed open until
> the next navigation) — `locateLabeled` reports the exposed sub-region as
> `aim` (8×8 hit-test grid) and the Interactor presses inside it. Verified
> live: profiles read, drawer open → Follows → requests → close, feed 24/100
> follow events, requests 5 rows (none confirmed), no shadow disagreement.
> `surface.ts` split (`projectors.ts`) and left the line-budget list; the
> literals (+19) and the adapter façade (+2) ceilings re-seeded — new IG facts
> must live there.

> **2026-10-21 (autonomous lifecycle architecture) —** Durable run intent and bounded device/process recovery; account-isolated graphs; journaled growth/prune/manual/request mutations; shared admission and read budgets; resumable source frontier; evidence-based return reconciliation and probation. See [ADR 0210](adr/0210-runtime-intent-and-device-recovery.md), [ADR 0211](adr/0211-resumable-source-frontier-and-read-budgets.md), [ADR 0212](adr/0212-journaled-mutations-and-return-reconciliation.md), and the [validation record](qa/lifecycle-2026-10-21.md). This supersedes the old deferred discovery/cursor/manual-identity notes below. Existing user changes and the verified rendering-lag fix are preserved. The running production account was not restarted or exercised by the lifecycle implementation.

> **2026-10-09 (prune unfollow refused: the unfollow menu animates) —** A live
> prune stopped on its first candidate: `adapter stale … control moved, disabled
> or covered` with the cursor resting on the menu's Unfollow row. Measured
> (`EPO_PROBE=unfollow-hover`, opens the menu, never confirms): the header
> button is stable (hover and hydration), but the menu SCALES IN over ~100 ms —
> the confirm row is first found at 672×64.8 and settles at 560×54. The 250 ms
> poll pinned a mid-animation rect and the click guard correctly refused the
> press after the row shrank under the cursor. Fix: `confirmUnfollow` uses
> `settleAndPress` (ADR 0307 amended). Intermittent before (a poll landing
> after the animation pressed fine — why the @instagram check passed).

> **2026-10-08 (dead endpoints — live probes, profile reads by VISIT, settle-then-press) —**
> Symptom: no observation of any kind since ~2026-09-20. Diagnosed with live,
> account-safe probes (`npm run probe`; the owner asked that nothing risk
> flagging the account, so the passive `traffic` phase came first — it records
> only what Instagram's OWN client requests — and every composed read was asked
> ONCE, stopping at the first wall). Findings: `GET /api/v1/users/<pk>/info/`
> answers **429 with an empty body** and `accounts/current_user/` a **200 HTML
> page redirected to `/`** (the envelope classifier read that as a rate
> limit); the web client calls neither. `topsearch`, followers/following,
> show_many and friendships/pending answer JSON; the news inbox is now a
> **POST**. A two-request header experiment ruled out a request-contract
> change (Epo's `x-ig-app-id`-only request = the client's full header set).
> Separately, the nav rail is now a hover-expanding icon rail that
> **re-renders its nodes when the cursor arrives**, so the click guard refused
> every rail press — the notifications drawer never opened (follow-back
> detection + follow-request handling blind). FIXES (ADR 0307): profiles are
> **visited** — `rim/profile-visit.ts` (`TabProfileVisitor`) navigates and
> `rim/profile-observer.ts` (`ProfileObserver`, now the single always-on
> profile reader that replaced graph-builder's inline harvester) hands it the
> page's own `PolarisProfilePageContentQuery` body after writing it to the
> store; outcomes `ok | gone | walled | unanswered | tab`; `gone` = the page's
> "Sorry, this page isn't available" (`profile-unavailable` control, a span in
> `main`; document is 200, no profile query fires). Enricher, acquisition pk
> resolution, seed check (private-seed visibility now from the body's
> `friendship_status`, no `friendships/show`), livetest, capture and the probe
> all read profiles this way. `profileInfoScript` / `currentUserScript` /
> `friendshipShowScript` and the topsearch/current_user literals are deleted
> (a test pins it) — Epo now composes ONLY the list-page reads. Rail and
> drawer controls use `settleAndPress` (`adapter/settle-press.ts`: hover with
> `MOTION.hoverSettleMs`, locate again, press). The own-profile rail link
> navigates same-document, which the input queue reports as post-click
> uncertainty — the landing and identity now verify it by URL. The identity
> resolver no longer asks `current_user`. Surface: activity feed declared
> POST; mutation notes updated; `CONTROLS` split into
> `versions/2026-08-12/controls.ts` (surface.ts 532 → 393). Verified live
> (`EPO_PROBE=verify`): own + followed profile `ok` with counts/flags,
> nonexistent `gone`, drawer open/Follows/requests/close, POST inbox parsed
> (55/100 follow events), pending parsed (9, none confirmed); one follow +
> unfollow of @instagram: `usePolarisFollowMutation` /
> `usePolarisUnfollowMutation` observed and arbitrated `ok`. Probe kept:
> `traffic` (start here next time) and `verify`; the one-off diagnosis phases
> were removed (evidence lives in ADR 0307). Behaviour notes: a profile read
> is now a page load (slower passes); the enricher's wall streak also counts
> visits that never answer; a tab that cannot navigate ends the pass.
> Suite: 1869 tests; `npm run check` green; boundaries 0 error / 132 warn
> (was 133). Checkpoint before the change: `refs/backups/pre-endpoint-fix-2026-10-09`.

> **2026-09-18 (Instagram retired `web_profile_info` — profile read rebuilt) —**
> Symptom: every seed check failed with `kind: rate-limited, status: 429`, and
> the tab logged `body was not valid JSON … Unexpected token '<'`. Not a rate
> wall and not the account: `/api/v1/users/web_profile_info/` now answers a
> 21,600-byte HTML shell under HTTP 429 for EVERY request shape (no headers,
> the full app-id/csrf/www-claim/asbd set, Chrome 128 and Chrome 152 alike)
> while, on the SAME session and minute, profile pages return 200 and
> followers-list / following-list / friendship-show / news-inbox /
> friendships-pending all return healthy JSON. Instagram's own web client no
> longer calls it — a recorded profile load fires `POST /api/graphql` with
> `x-fb-friendly-name: PolarisProfilePageContentQuery`. So: a retirement, not
> a throttle. REPLACEMENT (verified live, `2026-08-12` amended in place, no
> `doc_id` and no `fb_dtsg`/`lsd` scraping — those rotate every IG release):
> a profile read is now two plain `x-ig-app-id` GETs in ONE in-page script —
> `topsearch` (`/api/v1/web/search/topsearch/?context=blended&query=<u>`)
> resolves username → pk on an EXACT case-insensitive username match, then
> `/api/v1/users/<pk>/info/` returns the counts. No exact match is reported as
> a synthetic 404 so `classifyEnvelope` reads it as `gone`, exactly like the
> real 404 a dead pk returns. `/users/<pk>/info/` carries NO
> `friendship_status`, so `checkSeed` pays one extra `friendships/show/<pk>/`
> read for a PRIVATE seed only (`Foundation.viewerFollows`). PASSIVE harvest
> kept (PRINCIPLES §1): the Reader routes the GraphQL profile body by its
> operation name — endpoint matchers gained an optional `friendlyName`, since
> `/api/graphql` serves ~14 other Polaris queries per profile load and a
> URL-only match would drift-log all of them — and the mime gate now accepts
> `text/javascript`, which is how that body is served. Two endpoint kinds
> replace `web-profile-info`: `profile-info` (fetched) and `profile-graphql`
> (observed); both project through ONE shared user reader, because the field
> names are identical (`follower_count`, not the retired `edge_followed_by.
> count`) and only the container differs. The corpus body for the dead
> endpoint left the manifest (kept on disk as `.retired`); `profile-info` and
> `profile-graphql` are listed as documented blind spots until a fresh
> `npm run capture` lands real bodies — unit tests cover them meanwhile. Line
> budget re-seeded: the nine files this touched grew, and `store/schema.ts`
> (+1) and `store/schema/tables.ts` (dropped, now 298) came from uncommitted
> wave-B work already in the tree.

> **2026-09-02 (Epo v4 framework — design + wave A landed, wave B pending) —**
> Owner's ask: rebuild the framework so correctness, safety and
> maintainability hold by DESIGN, constants derive from the codebase's
> fundamentals, everything on latest runtimes. Design:
> `docs/superpowers/specs/2026-09-02-epo-v4-framework-design.md` (§9 waves,
> §10 six owner questions); rationale in 25 new ADRs (06xx kernel and
> fundamentals, 07xx store v4, 08xx surface, 09xx runtime, 10xx toolchain,
> renderer, shell). Frameworks REJECTED with reasons: Effect, xstate,
> kysely/drizzle, Vite/Vitest, pnpm workspaces, Storybook, electron-trpc,
> Playwright at runtime (a remote-debugging port is a security hole).
> Landed in wave A (eight parallel owners): `src/kernel/` (brands, units,
> ONE Outcome algebra, `Res`, Schedule, Scope, parse-with-zod, capabilities,
> Module/Session, fundamentals → policy → derive → overrides with a golden
> test: 49 constants derive exactly, 41 are policy dials, 18 are explained
> overrides); `node:sqlite` is THE store driver (`src/store/driver/`, ADR
> 0702; `better-sqlite3`, its types and `@electron/rebuild` are uninstalled,
> the rebuild scripts and `asarUnpack` are gone, `npmRebuild: false`; a
> test asserts none creeps back), migration 12 adds `timers` + `spans`
> (user_version 13) behind Chronos (durable timers) and SpanSink; the tables
> manifest; `src/surface/` holds the IG surface as a validated zod document
> running in SHADOW mode beside the legacy adapter (0 disagreements over 36
> captured bodies; scrubbed fixtures only under `tests/fixtures/surface/`,
> real captures in `docs/adapter/fixtures/` stay git-ignored), plus Verdict /
> Arbiter / ResponseWatch, a SurfaceMeter, the input-fallback hard stop and
> a `surface-lab` Electron entry (`npm run surface`); shell/IPC gained the
> PUSH contract, GUARDS that validate and never throw, the PROJECTIONS
> registry, UpdaterModule and GraphSession; runtime gained Facts + eleven
> pure rules with a precedence property test, `decidePruneCandidate`,
> `EFFECT_POLICY` as data (`ACTIONS_FAILING_HALT` derives to 7, the shipped 8
> is an override); renderer moved to `@preact/signals` in the shell context,
> generated tokens (`npm run gen:tokens`), `GraphStage` split (149 lines), a
> dev gallery route; toolchain truth is tests: `deps-verify` (types agree
> with the Electron-bundled Node, esbuild targets derive from `.node-version`
> via `gen:targets`), dependency-cruiser boundaries (`npm run boundaries`,
> 0 errors / warnings are the wave-B backlog), a monotone 300-line budget
> over `.ts/.tsx` (37 files / 9862 lines seeded), knip advisory,
> `noImplicitOverride`. Integration fixes this pass: arrow icons that
> `GrowthCard` rendered blank, the deprecated string overload of
> `isRateLimitHalt` (use `isRateLimitHaltKey` for strings), the kernel barrel.
> WAVE B (not started): Outcome algebra across adapter→rim→engine (delete
> `ActionRateLimitedError` / `ActionBlockedError` / `action-result.ts`),
> Chronos await + Scope + TabCap in the conductor, prune as a mode, the
> events-log migration with rebuild + shadow diff, Foundation dismantled into
> lifecycle / manual-ops / prune-control, legacy pacer deletion (ADR 0901),
> surface ENFORCE per endpoint, `listEndProbeCursor` opaque cursor,
> `esbuild.page.mjs` hardcoded chrome150 → derived targets, the `src/types.ts`
> barrel split (34 cycles, 65 renderer allow-list warnings), `causeSpanId` on
> status projections + `spans:chain` / `spanTail` / `timers` /
> `surfaceHealth` / `operatingPlan` channels, delete the `engineStatus` alias
> and `onPruneStatus/offPruneStatus`, SurfaceMeter persistence,
> `npm run livetest` for every DOM-level surface change. Suite: 1725 tests /
> 154 suites; `npm run check` green. Checkpoints (full tree, untracked
> included): `refs/backups/v4-wave0-2026-09-02` (before),
> `refs/backups/v4-waveA-2026-09-02` (after). Sidebar revamp runs in
> parallel: the card-based visual direction was rejected by the owner; the
> data model in `docs/superpowers/specs/2026-09-02-sidebar-revamp-design.md`
> survives, five from-zero UI concepts are being produced with the design
> skills (see `2026-09-02-sidebar-concepts.md` once written).

> **2026-09-02 (maintainability refactor — five adversarial reviews, five
> parallel implementation passes) —** Design + decisions in
> `docs/superpowers/specs/2026-09-02-maintainability-refactor-design.md`;
> rationale in 22 ADRs under `docs/adr/` (01xx main, 02xx engine, 03xx
> adapter, 04xx renderer, 05xx store/tooling). Frameworks REJECTED with
> measurements (Tailwind, CSS Modules, animation libs, xstate, kysely/drizzle,
> vitest/tsup, electron-trpc, zod-for-settings); ADOPTED: jsdom render tests,
> page scripts as real TypeScript, a Web Animations stagger helper, a typed IPC
> contract, contexts over prop drilling. Headlines: `foundation-wiring.ts`
> 2724→2208 (electron injected, `buildGraph()`/`TabLease`/`shell.ts`/
> `bootstrap.ts` extracted — capture/inspect were running WITHOUT the
> anti-throttling switches, fixed; single-instance lock); `engine.ts`
> 2081→1125 (ordered `GATES` table, `Pacer` port, `target-pipeline.ts`,
> `decisions.ts`, typed `HaltReason`, one `WaitRunner` for both engines, one
> `applyOutcome`); `knowledge-store.ts` 1614→684 (nine repos behind the same
> facade, column manifest, migrations as `{id,name,sql}`, `username_history`
> change-check); `versions/2026-08-12.ts` 1450→992 (in-page logic now
> `src/adapter/page/*.ts`, bundled into a committed, freshness-tested
> `bundle.generated.ts`; JS-click fallback deleted — `Interactor` is required;
> the livetest finally drives the production CDP input path); renderer CSS
> bundle 489 KB→66 KB (FontAwesome replaced by `ui/icons.ts`), `App.tsx`
> 402→207 across six hooks, `index` prop drilling gone, stylesheets re-cut by
> feature, 4 render suites on a fake bridge — and a real bug: the one-shot
> "Started" toast never fired (watch effect re-ran on its own arming render).
> Cross-cutting: `tests/**` is now type-checked (`npm run typecheck`) and
> linted (`biome ci src tests`); shared fakes in `tests/kit/`; `src/shared/`
> for renderer+engine pure code; renderer→engine import removed. Deferred
> (high risk / cross-layer): prune as a conductor mode, rim walk-engine
> unification, tab split, `GraphStage` split, `observations` table decision,
> the vestigial ABI rebuild scripts (need a two-platform proof — ADR 0503),
> LICENSE (AGPL text vs MIT declaration — owner's call). NEEDS
> `npm run livetest`: every DOM-level path (page bundle, interactor-only
> Actor, harness scrolling). Suite: 1262 tests / 114 suites, typecheck + lint
> + build + page-bundle check clean. Git checkpoints of the tree before/after:
> `refs/backups/pre-refactor-2026-09-02`, `refs/backups/post-refactor-2026-09-02`.

> **2026-09-02 (follow rate-limit detection — the response is the arbiter) —**
> User report: after enough outgoing follows Instagram throttles ("you're
> following too fast" on mobile); on the web the button clicks and the state
> just doesn't change — no dialog. Root cause: the Actor's only success
> arbiter was the header button's TEXT, but the web client flips it
> optimistically and snaps it back when the server refuses, so a throttled
> follow read as either a phantom `ok` (the flip was polled) or an anonymous
> `failed` (the snap-back was) — and the tab already observed the mutation
> response via CDP without anyone routing it. Now: `InstagramTab` also records
> `Network.requestWillBeSent` (method + lower-cased headers → `TabResponse`);
> the surface gained `matchMutation` (REST `…/web/friendships/<pk>/follow|unfollow/`,
> `friendships/create|destroy/<pk>/`, and GraphQL by the `x-fb-friendly-name`
> header), `extractMutationVerdict` (`status`/`message`/`spam`/feedback text,
> GraphQL `errors`/`data`), and `mutationRefusalSignatures`;
> `classifyMutationResponse` (ig-surface, version-agnostic numbers) yields
> `ok | rate-limited | auth | refused | drift-suspect`. The Actor arms a
> `MutationWatch` (new `src/adapter/mutation-watch.ts`) BEFORE every action
> click and lets the response decide: `rate-limited` → new
> `ActionRateLimitedError` → churn-actions `{blocked, cause:'rate-limited'}` →
> the growth engine enters the recovery ladder on the FIRST one (no streak to
> prove; `ChurnScheduler.lastBlockedCause`), the prune run halts with
> `haltReason:'rate-limited'` (remainder runnable; PruneRunCard says so) and the
> woven feed suspends. No response in `ADAPTER.MUTATION_RESPONSE_TIMEOUT_MS`
> (12 s) → the DOM verification decides exactly as before (a warn names the
> gap so a surface drift is diagnosable). NOT yet live-verified: the exact
> mutation URL the current web client fires — if the log shows "no mutation
> response observed" after clicks, capture the request and extend
> `MUTATION_TABLE`/the friendly-name test in `versions/2026-08-12.ts`.
> Suite: 1044 tests, tsc + lint + build clean.

> **2026-08-15 (LIVE unfollow debug — verdict) —** Two live labs against real
> Instagram (scratchpad `unfollow-lab*.ts` → `dist/lab/`, using the user's
> session): 6/6 unfollows succeeded, 5 of them the EXACT usernames that failed
> in the 23:55–00:10 run — including a byte-for-byte production-path run
> (`churnActions.unfollow` → interactor Actor, real Sentinel, default polls).
> DOM dumps confirm the adapter's model: menu = `[role=dialog]`, item text
> exactly "Unfollow" (span in a `div[role=button]`), confirm locatable 1.5 s
> post-click, header flips to "Follow" ≤2 s after confirm. Ledger forensics
> also showed the failed run was WORSE than the log read: only the FIRST
> unfollow succeeded; the "success" log lines print pre-verification and every
> later verification failed too. Verdict: Instagram was rejecting that run's
> unfollow mutations server-side (SPA reverts the button; menu intermittently
> not opening) — an account-level unfollow throttle, since lifted. Hardening
> added: `PRUNE_CONSECUTIVE_FAIL_HALT` (4 straight failed unfollows →
> `halt('actions-failing')`, remainder stays runnable) alongside the earlier
> block-probe / blocked-mapping. `InstagramTab.captureScreenshot()` added for
> future triage. Suite: 552 tests, tsc + lint + build clean.

> **2026-08-15 (block interstitials ≠ drift) —** A live prune run showed
> PERFECT alternation: every unfollow after a successful one threw
> `AdapterStaleError` on the confirm control — the signature of Instagram
> replacing the unfollow menu with a block interstitial ("Try Again Later")
> on every second action, which the Actor could not tell apart from selector
> drift (each one burned a candidate as `fail`). Now: when an expected control
> is missing or a verified click fails to change state, the Actor PROBES the
> screen (the Sentinel's dialog-text probe) — a block-signature match throws
> the new `ActionBlockedError`, which churn-actions maps to `'blocked'`
> (record/candidate untouched; prune parks 30 s and retries, halting only when
> persistent; growth leaves the record for later). Non-matching dialog text is
> warn-logged (200-char head) so any future stale is diagnosable, then drift
> still escalates loud. Robustness alongside: the unfollow-confirm matcher is
> now a PREFIX match (`\b` — "Unfollow @name" variants), and both confirm
> scripts search ALL `[role=dialog]`/`[role=alertdialog]` scopes instead of
> only the first. Suite: 551 tests, tsc + lint + build clean.

> **2026-08-14 (§3 durable schedules + prune runnability) —** New
> `docs/PRINCIPLES.md` §3: configured cadences persist last-run and OVERDUE
> WORK RUNS FIRST at startup. Follow-back check already qualified
> (`sweepLastRunAt` + engine step order runs it before actions); the
> scheduled-prune watcher now evaluates `immediate: true` at launch instead of
> one interval later. **Prune runnability bugs** (user report: scanned ~10 min
> earlier → empty list, grayed Run, "Last run" seemingly stuck): (1) a STOPPED
> or halted run silently dropped its unvisited remainder in memory — every
> early exit now hands it back runnable, like truncation; (2) `SCAN_FRESH_MS`
> 15 min → 6 h, made safe by a new LIVE-GRAPH GUARD in the run loop (a
> candidate whose follows-us edge appeared after the scan is skipped, never
> unfollowed); (3) the candidates list now populates from the saved census
> whenever unvisited rows exist, even when expired for running (Run stays
> gated on freshness); (4) `PruneStatus.scanAt` + a "Last scan" row (with an
> "expired — scan again to run" note) so the state is legible. Suite: 547
> tests, tsc + lint + build clean.

> **2026-08-14 (live UI mirror + follow requests + prune fixes) —**
> **§2 "The UI mirrors the graph, live"** (docs/PRINCIPLES.md): the store now
> fires `onMutation` on every write; the Foundation coalesces bursts
> (`POLL.GRAPH_PUSH_THROTTLE_MS`) into fresh dual-status pushes, so counts tick
> DURING scans/sweeps. `PruneStatus.graph` carries live
> `store.relationshipCounts()` — "Not following back" scrolls while the scan
> walks. **Follow requests** (private-account oversight): the notifications
> pass now also clicks the drawer's "Follow requests" entry, observes
> `friendships/pending/` (rows stored as they parse), and auto-accepts via
> real Confirm clicks — capped (`RIM.REQUEST_ACCEPT_CAP`), paced, each accept
> VERIFIED by the head row changing; accepted requesters get follows-us edges
> + `followed_back` records. Setting `autoAcceptFollowRequests` (default on,
> Cadence card toggle). Drawer etiquette: clicks the "Follows" filter on open,
> scrolls the list up to 2 rounds for older pages (merged/deduped), and leaves
> via the X control (bell-toggle fallback). **Prune fixes**: candidates list
> auto-populates from the persisted snapshot on launch (new
> `prune:candidates` IPC); scan-end counts carry the GHOST BUFFER (scraped +
> deactivated ghosts = the number Instagram displays) in status, snapshot, and
> scan result. Suite: 545 tests, tsc + lint + build clean. NOTE: the whole
> notifications-drawer interaction set (bell, Follows filter, requests entry,
> Confirm buttons, X close) is designed from the live web UI but not yet
> live-verified — watch the first hourly check's log lines.

> **2026-08-14 (facts stream — mandated principle) —** New `docs/PRINCIPLES.md`
> §1 ("facts stream; verdicts wait for completeness") + repo `CLAUDE.md`
> binding future sessions to it: every observed fact commits to the store the
> moment it is parsed; only absence-based verdicts (lost followers, candidate
> sets, baselines) may gate on a verified-complete walk. Violations fixed:
> prune-scan relationship edges used to land only at census end (an aborted
> scan lost every edge it saw) — both own-list sources now write each row's
> profile + edge per row (`ingestRow`: followers → follows-us edge; following →
> `reconcileOwnFollow`, healing drift on sight); `ingestScanCensus`'s additive
> half is now an idempotent re-confirmation, its absence half unchanged. The
> seed check stores its paid-for profile observation; notification follow
> events store the username the feed carried. Streaming contracts documented on
> the `onObservation` ports. Suite: 538 tests, tsc + lint + build clean.

> **2026-08-14 (v4 follow-back + UI truth) —** Follow-back detection now reads
> the NOTIFICATIONS feed instead of paging the whole own-followers list: the
> Actor clicks the nav bell (`locateNotificationsLinkScript`, aria-label
> matched), the drawer's `/api/v1/news/inbox/` response is observed via CDP and
> parsed (`extractActivityFeed`: `story_type` 101 OR "started following you"
> text — either signal admits, so one drifting doesn't blind us), and pending
> records seen in the feed transition to `followed_back` with the hold anchored
> at the EVENT time (clamped to ≥ our own follow). One click + one request per
> check → default cadence is now HOURLY (`followbackSweepHours: 1`; the 1h chip
> exists in Cadence). New `src/rim/follow-notifications.ts`; the watcher's
> paged sweep, head-watermark meta, and `maxPagesPerCheck` are removed
> (`AdapterBackedOwnFollowersSource` now serves only the prune census).
> Queue-order truth: records queued before migration 7 carry NULL scores
> forever, collapsing both `nextDue` and the queue display to pk order —
> `Scanner.rescoreQueued()` backfills them at engine start (the live DB's 29
> legacy records all have counts, so they rank fully). Chain UI: the seed node
> no longer hardcodes "exhausted & chained" — labels are status-truthful
> (current → `followed N`). Suite: 535 tests, tsc + lint + build clean.

> **2026-08-14 (latest) — Background-run survival.** After CDP input dispatch,
> actions STILL failed in the background. An instrumented Electron lab
> (BaseWindow + offset WebContentsView, per-scenario measurement) proved why:
> stock Chromium marks a blurred/occluded/hidden/minimized window's page
> `visibilityState: hidden`, stops rAF entirely (0 vs 180 frames/1.5 s), and
> clamps timers ~15× (→ ~1/min after 5 min) — CDP clicks still ARRIVE
> (trusted), but Instagram's SPA cannot hydrate or advance its UI, so actions
> time out. Fix (re-measured: all background states now identical to
> foreground): `disable-renderer-backgrounding` +
> `disable-background-timer-throttling` + `disable-backgrounding-occluded-
> windows` switches in `main.ts`/`livetest-main.ts`, `backgroundThrottling:
> false` on the IG tab, `Emulation.setFocusEmulationEnabled` at debugger
> attach, and a `powerSaveBlocker('prevent-app-suspension')` (App Nap would
> throttle the MAIN process timers pacing the motion profile; also keeps the
> system awake with the display off). New `InstagramTab.probeInput()` runs on
> an `actions-failing` halt and logs decisively whether input reaches the page.

> **2026-08-14 (later) — Input pipeline: CDP dispatch.** The 2026-08-13
> overnight run failed every single click while reporting `clicked: true`:
> `webContents.sendInputEvent` (the Interactor's transport) only works while
> the host window is FOCUSED — an unattended background run drops everything
> silently. The tab now dispatches all pointer input via CDP
> `Input.dispatchMouseEvent` on its already-attached debugger
> (`src/interaction/cdp-input.ts` converts the Electron-shaped driver events;
> wheel deltas negate back to DOM semantics). CDP injection is the
> Puppeteer/Playwright mechanism: trusted events, focus/occlusion-independent.
> Fallout fixes from the same run: a failed own-followers sweep now THROWS
> instead of resolving empty (an open-failed scrape had stamped the followers
> BASELINE off a read of nothing); and the engine halts with `actions-failing`
> after 8 consecutive failed actions across records (systemic-breakage breaker
> — that night burned 17 candidates + 71 ledger rows clicking into the void).
> `EngineStatus.haltReason` now travels to the UI (LiveStatusCard alert). The
> live DB was repaired by hand: baseline meta cleared, the 17 never-followed
> abandoned records re-queued, the 71 phantom `fail` ledger rows deleted
> (backup at `epo.db.bak-2026-08-14`). Suite: 527 tests, tsc + lint clean.

> **2026-08-14 — Full-codebase remediation pass.** A four-way adversarial audit
> (engine / rim+adapter / store+governors / wiring+renderer) surfaced ~55 real
> defects; all substantive ones are fixed. Headlines:
> **Action integrity** — the Actor's document-wide fallback selector is gone
> (it could click ANOTHER account's Follow button mid-hydration and "verify"
> against it); `outgoing_request` is now parsed, so pending requests to private
> accounts are no longer destroyed by the reconciler; `friendships/show` error
> bodies are SHAPE_MISMATCH, not "no relationship"; a user Stop now surfaces as
> `ActionAbortedError` → `blocked` (record untouched) instead of burning
> retries; interactor clicks guard against degenerate rects.
> **Census integrity** — prune's list walks carry a completeness verdict end to
> end and a truncated census FAILS the scan instead of driving unfollows; a
> complete census is authoritative (records lost followers — the net-growth
> chart's loss side is real now); prune excludes chain targets, retries blocked
> candidates, stops at the active-hours edge, and a cap-truncated run keeps its
> remainder runnable.
> **Effectiveness** — the operating-rate knob actually gates the loop (ceiling
> counts BOTH ledgers); enrichment failure no longer burns targets/chains
> (walled cycles back off; dead accounts are marked `enrich_failed_at`);
> follow-back sweeps use a positional head watermark plus a zero-request
> store pass (a prune census no longer blinds them); `TargetDiscovery` is live
> (store-backed hubs), and the own-followers fallback enriches before ranking.
> **Wiring/UI** — prune/manual ops wait for a genuinely parked engine (pause ≠
> quiesced); teardown drains in-flight manual ops before closing the DB;
> settings autosave sends only edited keys (no more whole-object clobbering of
> prune/backend fields); restart-from-seed is a real backend op; control
> refusals surface as toasts; settings are sanitized on every load/update.
> Suite: 517 tests, tsc + biome clean.

**As of:** 2026-08-12, overnight session. **Branch:** `v3` (pushed to `origin/v3`).
**Status:** The whole system is **assembled, remediated, and green** — **216 unit tests**, clean
`tsc`/`eslint`/`build`. A Fable adversarial review of the *assembled* system found CRITICAL integration
defects (each part was unit-correct; the composition was not — most importantly the candidate-enrichment
pass was missing, so the engine could enqueue nothing and would **livelock hammering Instagram**). **All
of them are now fixed and re-verified** (see `docs/superpowers/specs/2026-08-12-peanut-v3-remediation.md`
and the `fix(remediation): ...` commits): enrichment is wired, the refill loop is provably livelock-safe
(bounded cycle → exhaust → advance), actions are paced one-per-iteration, budget/sentinel refusals no
longer burn the queue, manual ops are ceiling-gated + refused while the engine runs, and the loop is
concurrency-safe and interruptible.

**LIVE GATE PASSED (2026-08-12).** `npm run livetest` returned ALL PASS on a real account and a real
churn target: identity, acquire (multi-page scroll), enrich (real `web_profile_info` counts), score+plan
(correct sweet-spot ranking), follow (post-click verified), follow-back check, unfollow (net-zero), and
Sentinel — every mechanical action the app performs is validated against live Instagram. Three live
selector fixes were needed and made along the way (all in `field-notes.ts`/`actor.ts`, evidence-driven
via `npm run inspect`): username resolution via the profile link, opening the followers modal by
text-matching the `<a href="#">` stat, and treating "no scroll container" as non-fatal. The system is
ready to run for real (§5b).

---

## 1. What Peanut is

A personal Instagram growth engine (Electron desktop app) that runs a **self-chaining follow/unfollow
strategy**: pick a target account, poach its followers (the "numbers users" most likely to follow
back — ranked by the ratio sweet spot), follow them, wait for the follow-back, hold, then unfollow —
netting followers. When a target's viable candidates are exhausted, it **promotes the best discovered
account to the next target and chains onward**, ~indefinitely, with an own-followers fallback so the
chain never dead-ends.

## 2. The strategy, precisely

- **Ratio sweet spot** (`r = following ÷ followers`): eligible band `0.90–1.50`, peak plateau `1.0–1.2`,
  excluded past `0.5`/`3.0`. Private accounts get a score boost. Verified / out-of-size-band excluded.
- **Lifecycle:** `queued → followed (pending follow-back) → followed-back (hold) → unfollow → done`,
  or timeout-reclaim if no follow-back. Timers configurable (default 4-day wait, 2-day hold).
- **Follow-back detection is request-minimal:** `show_many` lacks `followed_by`, so detection reads our
  OWN followers incrementally (new followers appear at top; O(new), not O(all)).
- **Chaining:** yield stats (follow-back rate, pool size, mutual overlap) pick the next target; a
  minimum-yield gate decides promote-discovered vs own-followers fallback.

## 3. Architecture (Fable-designed, layered)

- **Knowledge graph** (`src/store/`) — SQLite (`better-sqlite3`), event-sourced: every Instagram fact is
  an `observe()`d observation → projected current state (per-field provenance/confidence merge, identity
  by numeric `pk`). Directed edges for follows/follow-backs. Durable action ledger + request log. The
  SINGLE module allowed to touch SQL (lint-enforced).
- **Governors** (`src/governors/`) — durable daily action cap + in-code hard ceiling (read from the
  ledger, survives restart), global request budget (counts *real* responses), injectable clock.
- **Instagram Adapter** (`src/adapter/`) — the single versioned surface: `Reader` (parses intercepted
  JSON via `field-notes.ts`, the live-captured source of truth), `Actor` (the ONLY DOM-touching code —
  text-matched buttons, hydration waits, post-click verification, loud `AdapterStaleError` on drift),
  `Sentinel` (block/challenge/logout detection), `tab.ts` (embedded `WebContentsView` on a persistent
  session, CDP response observer, real Chrome UA).
- **Rim** (`src/rim/`) — adapter-backed ports: `FollowerAcquisition` (budgeted scrape + pk-from-URL edge
  back-fill + cursor persistence), `ChurnActions` (budget/sentinel-gated actions), own-followers
  source/target-source, request metering.
- **Engine** (`src/engine/`) — the pure components (Scorer, Churn Scheduler, Follow-back Watcher,
  Scanner, Chain Controller) + the **conductor** (`engine.ts`): an interruptible loop that does at most
  **one Instagram action per iteration with a paced delay between**, enforces active-hours/ceiling/
  budget/sentinel gates, runs the follow-back sweep on cadence, and advances the chain. Burst-prevention
  is proven by an event-ordered test.
- **Composition + UI** (`src/main/`, `src/renderer/`) — the composition root wires the graph and runs
  the Engine behind IPC controls (start/pause/stop/status); the renderer is the dashboard beside the
  live Instagram tab.

## 4. Running it

```bash
npm install          # first time (native better-sqlite3 build)
npm run dev          # builds + launches Electron (auto-signs the Electron binary for macOS 26 Gatekeeper)
npm test             # 188 unit tests
```

Notes: the app auto ad-hoc-signs the Electron runtime on launch (macOS 26 XProtect was trashing the old
unsigned Electron 31; we're on Electron 43 + a `fix:electron` prelaunch step). `better-sqlite3` is
rebuilt for the Electron ABI on `dev`/`start` and for Node on `test` — the scripts handle the toggle.

## 5. THE LIVE GATE (needs you — the only blocker)

**Quickest first check — the live action smoke test.** Before running the full app, validate every real
Instagram action in a couple of minutes (paced + bounded, safe for a real account):
```bash
PEANUT_TEST_FOLLOW=<a_throwaway_or_friend_account> npm run livetest    # add PEANUT_TEST_DRY=1 for no real clicks
```
A window opens; log in; it then runs Identity → Acquire → Enrich → Score+Plan → Follow → Follow-back
check → Unfollow → Sentinel, each with jittered paced delays (~30–75s between the follow and unfollow),
exactly one follow+unfollow (net-zero), a real ~300/hr budget, and a Sentinel check before each action
that aborts on any block. It prints a `STEP | STATUS | DETAIL` table + total actions/requests. This is
the fastest way to confirm the live adapter works (esp. the enrichment fetch + button selectors) without
waiting for engine cycles. Uses a throwaway temp DB. If a step FAILs, that's the targeted thing to fix.

**§5b — running the engine for real (recommended first-run posture).** After `npm run livetest` is
green, launch `npm run dev`, set your seed + tune Settings, and Start. For the FIRST real run, be
conservative: turn **dry-run ON** in Settings for one session to watch the loop pace and pick candidates
without any real clicks; then turn dry-run off with a **low operating rate** (e.g. 10–15/day) and watch
the first few real follows land ~3–7 min apart. Confirm the Activity log shows one action per interval,
the Rate panel decrements, and the Sentinel stays `ok`. Ramp up only once you've seen a full
follow→follow-back→hold→unfollow cycle behave.

**The manual gate (optional, superseded by §5 livetest)** — launch `npm run dev`, then in the app:
1. **Login** — click Login; log into Instagram in the right-hand tab (2FA fine). Quit + relaunch to
   confirm the session persists. Status should flip to `loggedIn` and the dependency graph builds
   (log: "dependency graph built" with your `ownPk`/`ownUsername`).
2. **Read followers** — enter a small target, Read Followers. Confirm `observed > 0` and (in
   `<userData>/peanut.db`) `accounts` rows appear and `edges` to the target are written. No "useragent
   mismatch" warnings (the UA fix).
3. **Follow one / Unfollow one** — on a test username. Confirm the real action in the tab, an
   `action_ledger` row (`ok`), and the edge added/removed. The Actor verifies the post-click state.
4. **Start engine** — watch it do one action at a time with a 3–7 min gap; Pause/Stop interrupt
   instantly; the dashboard status updates live.
5. **Safety** — point the tab at a `/challenge/` or logged-out URL and confirm actions refuse with a
   sentinel reason and the loop halts.

If anything fails live (most likely: a selector needs adjusting for the current IG DOM, or
`current_user` username resolution), capture the terminal log + what you saw and it's a targeted fix —
the adapter is the one versioned place to update.

## 6. Deliberately deferred (not bugs — design choices)

- **`TargetDiscovery` real implementation** — finding a "popular hub" *within* a poached network needs
  signal we don't yet collect (who the followers themselves follow). Until designed, discovery returns
  empty and the chain advances via the fully-built **own-followers fallback**. See engine-arch §7.
- **Live validation of the churn loop end-to-end** — unit-proven; needs a real run (part of §5).
- **Dashboard visual polish** — built to the metallic-minimal design; needs your eyes in the running app.
- **Two known efficiency residuals** (correctness is fine; deferred as optimizations, tracked in the
  remediation doc): the follow-back sweep does a bounded head-scrape rather than a true one-scroll-per-
  page increment (finding 7), and the persisted scrape cursor isn't yet replayed to skip already-read
  pages (finding 8). Both just mean *slightly* more requests than optimal, well within the budget.
- **Manual follow/unfollow ledger identity** — the manual live-gate buttons key the ledger by username
  (the store has no username→pk reverse index yet); the durable ceiling still counts them, so the safety
  guarantee holds. The engine's own actions use real pks. A `manualActionPk()` seam is left for later.

## 7. Branches & docs

- `v2` (GitHub) — your prior uncommitted TypeScript/Electron WIP, snapshotted and **backdated to
  2026-02-17** (when you actually did it), preserved for history.
- `v3` (GitHub) — this rebuild. Merge to `main` when the live gate passes.
- Design docs (all in `docs/superpowers/specs/`): `...-v3-design.md` (product + knowledge graph),
  `...-v3-engine-architecture.md` (the conductor + review-fix requirements), `...-v3-ui.md` (dashboard).
- `docs/adapter/README.md` + the Task E capture harness (`npm run capture`) — how the live IG shapes
  were captured; re-run it if Instagram changes and the adapter needs re-verification.

## 8. How it was built

Fable dictated the architecture (the specs above) and orchestrated; implementation was delegated to
subagents — Opus for thin precise-spec work, Fable for the judgment-heavy keystones (Engine conductor,
adversarial reviews). Two adversarial reviews were run and their findings folded back into the
architecture (the hydration waits, pk-from-URL edges, budget-from-real-responses, one-action-per-tick
pacing all came from that). Isolated git worktrees kept parallel subagents from colliding.
