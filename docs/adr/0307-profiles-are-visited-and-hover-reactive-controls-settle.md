# 0307 — Profiles are visited, not fetched; hover-reactive controls settle before a press

**Status:** accepted · **Area:** adapter, rim, surface · **Date:** 2026-10-08

Amends ADR 0301 (literals stay in `src/surface/versions/*`), 0304 (response
arbitration is unchanged and re-verified) and 0306 (post-click uncertainty is
re-observed, never treated as failure).

## Context

From about 2026-09-20 the app produced no observations at all. Live probes
against the owner's session on 2026-10-08 (`npm run probe`; the passive
`traffic` phase records only what Instagram's OWN client requests) found:

| Read / control | Live answer | Instagram's own client |
|---|---|---|
| `GET /api/v1/users/<pk>/info/` (profile counts) | **HTTP 429, empty body** | never calls it |
| `GET /api/v1/accounts/current_user/` | **200 HTML, redirected to `/`** | never calls it |
| `GET /api/v1/web/search/topsearch/` | 200 JSON | — |
| `GET /api/v1/friendships/<pk>/followers/` · `/following/` | 200 JSON | the same endpoint |
| `POST /api/v1/friendships/show_many/` · `GET /friendships/pending/` | 200 JSON | the same endpoints |
| `POST /api/v1/news/inbox/` (was a GET) | 200 JSON | the same endpoint |
| `POST /api/graphql` `PolarisProfilePageContentQuery` | 200, full profile + `friendship_status` | fired on every profile page load |
| nav rail Notifications / own-profile link | click guard refused every press | — |

The header experiment ruled out a request-contract change: Epo's
`x-ig-app-id`-only request and the client's full header set got the same 200
JSON from the followers endpoint. The walls are per endpoint, and they hit the
two endpoints the web client does not use — the same pattern as the
2026-09-18 `web_profile_info` retirement.

The rail: Instagram's left nav is now a collapsed icon rail that expands on
hover and **re-renders its nodes as the cursor arrives** (measured: the node
located before travel is disconnected by the first 2 ms sample after arrival;
the control goes 48×56 → 214×16.5). Drawer controls rescale on hover (close X
16 → 16.8 px over ~200 ms). The click guard (ADR 0306) holds the node located
before travel, so it correctly refused every rail press: the notifications
drawer never opened and follow-back detection and follow-request handling went
blind.

## Decision

1. **A profile is read by VISITING it.** `TabProfileVisitor` navigates to
   `/<username>/` and waits for the page's own profile body through the
   `ProfileObserver` — the single always-on reader that parses every profile
   body the tab loads once, writes it to the store (PRINCIPLES §1), and only
   then wakes a waiting visit. Outcomes are typed: `ok` (with the viewer flags
   `following` / `requested` / `followsUs`), `gone` (the page renders "Sorry,
   this page isn't available" and fetches no profile), `walled` (the Sentinel
   names a wall), `unanswered` (drift until proven otherwise), `tab`. The
   enricher, acquisition's pk resolution, the seed check, the livetest, the
   capture harness and the probe all read profiles this way. Consumers depend
   on `rim/profile-visit-port.ts`, which stays outside the `src/types.ts`
   barrel cycle.
2. **Epo composes only the list-page reads.** `profileInfoScript`
   (`topsearch` → `users/<pk>/info`), `currentUserScript` and
   `friendshipShowScript` are deleted from `IgSurface`, with their literals; a
   test pins that they are never reintroduced. The relationship a private seed
   needed `friendships/show` for is in the visited profile's own
   `friendship_status`. The `profile-info` and `friendship-show` endpoint
   kinds remain as OBSERVE-only routes.
3. **Hover-reactive controls settle before a press.** `settleAndPress`
   (`src/adapter/settle-press.ts`) rests the cursor on the control
   (`Interactor.hover`, dwell `MOTION.hoverSettleMs`), locates it AGAIN and
   presses the settled rect. The guard still protects the short final travel.
   Applied to the rail (notifications, own-profile link), the drawer
   (Follows filter, Follow-requests entry, Confirm, close) and — amended
   2026-10-09 — the unfollow menu's confirm: the menu SCALES IN over ~100 ms
   (the row is first found at 672×64.8, settles at 560×54), so the 250 ms
   poll could pin a mid-animation rect and the guard refused the press as
   "control moved" (a live prune failed on its first candidate). The header
   action button needs none of this: measured stable under hover AND from its
   first appearance during hydration (`EPO_PROBE=unfollow-hover`).
4. **In-page navigation clicks re-observe.** The rail's own-profile link
   navigates same-document; the route change can start before the release is
   acknowledged, which the input queue reports as post-click uncertainty
   (ADR 0306, unchanged). The profile landing and the identity resolver now
   verify such a press by the URL instead of reporting a failed click.

## Rejected

- **Compose the GraphQL profile query** (replay the client's `doc_id` with
  scraped `fb_dtsg`/`lsd`): synthetic requests on an operation that rotates
  every Instagram release — the fragility the 2026-09-18 fix avoided.
- **Hover cards** (`PolarisUserHoverCardContentV2Query`): lighter, but carry no
  bio or mutual count, which the bio keep-list and scoring read.
- **Keep `users/<pk>/info/` at a slower pace**: walled for ~3 weeks, never
  called by the web client; continuing to request it is the risk, not the cure.
- **Ignore same-document navigations in the input queue**: the tab test pins
  that they invalidate gestures on purpose; the uncertainty is correct, the
  callers were wrong to read it as failure.

## Consequences

- A profile read costs a page load (~5–8 s with pacing) instead of two JSON
  requests, and composes nothing an observer of the account could tell apart
  from a person opening a profile. Enrichment passes take longer; the wall
  streak now also counts visits that never answer.
- Verified live end to end on 2026-10-08 (`EPO_PROBE=verify`): own profile and
  a followed profile `ok` with counts and flags, a nonexistent username `gone`,
  drawer open → Follows → requests → close, the POST news inbox parsed (55/100
  follow events), pending requests parsed (9 rows, none confirmed). One
  follow + unfollow of @instagram (`EPO_PROBE=follow`): both GraphQL mutations
  (`usePolarisFollowMutation` / `usePolarisUnfollowMutation`) observed and
  arbitrated `ok`.
- When an endpoint dies next, start with `EPO_PROBE=traffic`: it records what
  Instagram's own client calls, with zero composed requests.

## Amendment — 2026-11-02: the drawer reads through GraphQL; aim at the exposed part

Live (`EPO_PROBE=verify`, read-only): the notifications drawer's client no
longer calls `news/inbox` or `friendships/pending`. It reads the SAME stories
through `PolarisActivityFeedStoriesViewQuery` (`/api/graphql`,
`data.xdt_activity_inbox`) and the SAME request rows through
`PolarisActivityFeedFollowRequestsViewQuery` (`/graphql/query`,
`data.xdt_friendships_pending_users.users.edges[].node`). Follow-back detection
saw "no activity-feed response after click", and the engine parked under
`enrich-backoff` — a mislabel: the reconciliation wait reused that key.

- **Routing by operation name, one kind per datum.** Each kind gained a GraphQL
  endpoint definition (URL + friendly name); its schema accepts either
  container, the version document unwraps the GraphQL branch to the REST shape
  (a zod `transform`), and the legacy extractors unwrap the same way
  (`adapter/versions/2026-08-12.notifications.ts`). `follow-notifications`
  routes by `kindOf` (URL + operation name), not URL alone. The REST forms stay
  routed — the same kinds, either container.
- **Aim at the exposed part.** The drawer's header now covers the lower half
  of its 16×16 close X in every view; the click guard correctly refused a
  press there. `locateLabeled` reports `aim` — the exposed sub-region, from an
  8×8 hit-test grid (`exposedAim`) — and the Interactor chooses the point
  inside it while the guard still identifies the control by its full rect.
  Absent when the whole control is exposed, or none of it is (then the guard
  refuses, loudly).
- **The reconciliation wait parks as `reconcile-backoff`** ("couldn't read
  follow-backs"), so a failed follow-back read is never reported as an
  enrichment wall.
- `projectors.ts` was split out of the version document (line budget).

## Amendment — 2026-11-02 (later): profile visits are paced like browsing

A live "checking relationships after N days away" run visited ten profiles
back to back (~25 s), parked ~30 s, reopened the notifications drawer, and
repeated — a burst-then-stop rhythm no person browses at, and one that drains
the 24-a-day notification allowance in under twenty minutes.

- **The shared visitor paces every visit.** `TabProfileVisitor` rests a
  clamped log-normal dwell (`MOTION.profileDwell*`: median 9 s, σ 0.45,
  5–30 s) measured from the END of the previous visit, before navigating. One
  visitor serves enrichment, relationship checks, effect reconciliation,
  acquisition and the seed check, so no caller can burst. A Stop ends the
  dwell at once.
- **Reconciliation progress continues instead of parking.** A batch that
  observed something returns `progress`; the engine takes the next step at
  once (the visitor supplies the spacing), so batches of ten no longer show
  as bursts separated by holds.
- **A continuation batch does not reopen the drawer** — the feed was read
  when the sequence began.

## Amendment — 2026-11-02: the reopen sweep's composed reads stay list pages (ADR 0213)

Decision 2 holds for the reopen sweep. The followers head walk reads our own followers list from the
head with the walker's list-page script, and the following check reads our own following list with the
ordered whole-list response plus the plain end probe the web client itself makes; both are list-page
reads under the walker's whole-list rule. No profile-info or friendship read is composed for them, and
the own header comes from the landing's own profile load or one visit.

## Amendment — 2026-11-03: one plan-derived activity clock (ADRs 0607, 0213)

The visit-only dwell and reconciliation-batch rules above are superseded. The graph shares one activity clock
across profile visits, list walks and the notifications drawer: each operation enters after a `dwell.visit` draw
at the current session tempo, measured from the previous operation's end. The reference dwell remains a kernel
prior, not a separate fixed visitor delay. Reconciliation batches are removed; persisted frontiers handle reopen
reads, and the click-time visit verifies each unfollow once (ADR 0213).
