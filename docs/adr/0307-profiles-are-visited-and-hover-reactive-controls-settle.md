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
   Applied to the rail (notifications, own-profile link) and the drawer
   (Follows filter, Follow-requests entry, Confirm, close). Profile-header
   controls are unchanged — they measured stable.
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
