# 0211 — Resumable sources and finite exploration reads

Status: accepted; policy values are provisional

The automatic follow-selection policy below is amended by
[ADR 0215](0215-quality-preserving-source-handoffs.md): source fairness applies
only to prepared cohorts above a durable quality floor. Read-source visits can
advance while good candidates from earlier sources remain available.

The previous chain mined one audience until exhaustion or cumulative coverage,
then selected a replacement. Large raw follower counts could keep the bot in one
neighborhood for many days. Rejecting a sufficient local candidate pool could
also declare exhaustion without any list-end evidence. Newly pending follows
were treated as disappointing outcomes, and that parent rate was copied to all
discovered child sources.

`SourceFrontier` persists source visits separately from the global follow-record
queue. Spending a visit changes scheduling eligibility; it does not delete queued
records, reset followback deadlines, erase observed edges, or claim the audience
is exhausted. Only a verified list end marks a target exhausted. Coverage is a
policy deferral. Saved visit counters and recent source shares survive restart.
Intentional restart-from-seed clears the frontier through the explicit command.

Initial policy lives in `src/engine/exploration-policy.ts`:

| Control | Initial value | Purpose |
| --- | --- | --- |
| Live source alternatives | At most 5, seek at least 3 | Keep choices bounded and diversify when viable sources exist |
| Follow allowance per visit | 20 | Yield a productive source without pretending it is depleted |
| Optional refill slice | 2 list pages, 100 new-to-source rows, 20 profile attempts | Bound one visit's read work |
| Queued candidates per source | 10 | Avoid filling the global queue with one large audience |
| Empty plans before deferral | 2 | Stop unproductive local sampling without declaring absence |
| Low-yield retry | 24 hours | Permit changed membership and enrichment evidence |
| Verified-end / coverage revisit | 7 days | Revalidate old sources from the head using cursor age |
| Profile and failed-enrichment retry age | 7 days | Avoid permanent rejection based on an old profile |
| Source exploration opportunity | Every fifth successful follow | Prefer less-used sources when choosing among alternatives |
| Fresh-follow concentration | 40% of the last 100 when at least 3 queues are available | Bound concentration without preventing work when alternatives are absent |

The concentration rule begins after 20 recorded follows. Queue selection chooses
the least-used available source and its highest-scoring candidate, with an
additional lifetime-use preference on exploration opportunities. Visit selection
uses matured source quality, observed overlap and recent share; it reserves the
same periodic opportunity for under-sampled sources. These are scheduling rules,
not guarantees that a particular source can produce enough eligible candidates.
If only one viable source remains, it may continue. Historical sources remain
resumable; the live-frontier limit does not erase their obligations.

Lifetime preference also covers sources with queued obligations outside the live
frontier. Its known count is the maximum of the persisted source tally, the
recent window and successful follow-ledger entries matching the retained record's
`followedAt` exactly. These overlap, so they are not added. A simulated timestamp,
failed follow or unfollow contributes nothing; an old cycle cannot be attributed
to a newly queued source. This is a lower bound when historical source provenance
is unavailable. One grouped store read per exploration selection supplies the
counts; ordinary opportunities need no extra read. Frontier v1 remains unchanged.

Discovery applies source-size and mature-quality gates before truncating the
five candidates. Raw audience size is a viability gate, not the optimization
target. Private fallback sources require an observed active follow from our
account. An already-known tiny follower cannot prevent a bounded enrichment
attempt on unknown alternatives. Source and queue decisions use live settings;
rejected profiles can be reconsidered when settings or observed data change.

Quality uses a fixed horizon equal to the configured followback waiting window.
Younger follows are pending. A follow whose deadline passed while the app was
away remains censored until there is sufficient relationship evidence. An
undated reciprocal observation, or an exact followback event predating our own
follow, is censored rather than counted as a failed or attributable conversion.
Mature cohorts use a prior of 20 observations at a 15% rate; unknown sources use
the mature account-wide baseline. This regularizes small samples, not evidence
that an unknown source will actually yield 15%. One ledger pass computes all
source cohorts, avoiding repeated full scans per candidate or sort comparison.

`ReadBudget` owns one durable rolling 24-hour allowance for deliberate logical
reads. Reservations persist before I/O and are not refunded by failure, restart,
or switching transport. Defaults are 80 profile visits (at most 40 exploration),
200 list-page attempts (at most 24 exploration), and 24 notification reads.
Required profile identity checks, effect reconciliation and own-header refresh
share the reserved profile capacity. Required censuses share the remaining page
capacity. These ceilings are conservative application policy, not documented
platform quotas. A browser page may generate multiple underlying requests; this
ledger does not claim to count every incidental browser subrequest.

Both direct pagination and the dialog fallback consume the same budget. A
budget refusal carries a retry deadline and preserves partial observations and
cursor progress. A refusal before any page is read does not refresh or erase an
old cursor. It is neither exhaustion nor a platform wall and cannot authorize a
fallback request. It must not block already-queued actions, required cleanup or
Stop. Platform walls still take the account-wide recovery path; rotating sources
does not bypass them.

Status includes visit counts, deferral reasons and resume deadlines. Read
progress is emitted after a validated active operation finishes, never merely
because a passive observer wrote to the store. In particular, pages observed
while a dialog scroll is stuck do not keep the watchdog healthy.

Tests cover restart-stable visits and budgets, preservation of global queued
records and cursors, the false-drain regression, fixed-horizon censorship,
bounded same-budget queue diversity, unavailable alternatives, fallback gates,
read-reserve isolation, transport switching, and passive-traffic watchdog races.
The deterministic 100-action simulation proves scheduling concentration under
available candidates; it does not measure real-world conversion, relevance or
Instagram availability. Those require observed mature outcomes after deployment.

## Amendment — 2026-11-02: the allowance derives from the live limits (kernel D6)

The hardcoded ceilings (80 profiles / 40 exploration, 200 pages / 24
exploration, 24 notifications) sat outside the ADR 0605 tiers and ignored the
pattern knobs. Live, a 98-a-day ceiling ran against 80 profile visits, so the
plan could never be delivered and reconciliation alone could starve growth.
The owner's rule: no hardcoded limit; everything goes through the limit system.

`deriveReadAllowance` (`src/kernel/derive-reads.ts`) sizes reads from the
same live `Settings` limits the pattern knobs derive (or the owner set):

| Ceiling | Derivation |
| --- | --- |
| profiles | verify `dailyHardCeiling` + reconcile `⌈dailyHardCeiling × (1 + ORDINARY_FAIL_RATE)⌉` + exploration |
| exploration profiles | `⌈dailyPlanSize / queuedPerSource⌉` slices × (`profilesPerSlice` + `sourceOpenReads`) |
| list pages | `LIST_WALK_MAX_PAGES` + exploration pages |
| exploration pages | slices × (`pagesPerSlice` + `sourceOpenReads`) |
| notifications | `⌈24 / followbackSweepHours⌉` + `sessionsPerDayMax` |
| window | one day |

- Every mutation reads its profile at the click (ADR 0212), and every follow
  comes due once for a relationship check. An unverified click is re-observed
  once more, at the ordinary failure rate.
- Exploration stays a sub-limit, so it can never spend the reserve that
  verifies and reconciles.
- `ReadBudget` reads `limits()` on every check (`toReadAllowance(resolveSettings())`),
  so a settings change moves the allowance at once. It exports no defaults.
- The exploration policy moved into the kernel (`src/kernel/exploration-policy.ts`,
  tier 1 with a guard line per entry). `src/engine/exploration-policy.ts`
  re-exports it.

Laws (`tests/kernel/derive-reads.test.ts`): at every persona × activity ×
sweep point, the non-exploration reserve covers `2 × ceiling`, exploration
covers the plan size, a full census walk fits, and every sweep can read the
feed. Every ceiling is non-decreasing in the activity knob. On the live install
(ceiling 98, plan size 90, hourly sweeps, ≤4 sessions) the allowance is 415
profiles (189 exploration), 227 pages (27 exploration) and 28 notifications.

## Amendment — 2026-11-02: the reopen reads are planned inside D6 (ADR 0213)

The plan-day read allowance carries the reopen sweep's reads as terms of their own: the frontier term
(the launch catch-up plus one head walk per session start, `FRONTIER_PAGES_MAX` pages each) and the
following check's two composed requests inside the census term. The plan, the read budget and the
Settings view size the census term with the same read facts, so the plan's own reads always fit the D6
the budget enforces (law L8). The sweep's reads are tagged by use (`catch-up`, `check`); a refused
read ends its step only, and the next planned check retries it.

## Amendment — 2026-11-02: the refill sizes its reads from the plan (ADR 0607)

An enrichment slice is `min(profilesPerSlice, the open session's explore reads)`; a session with no
explore reads leaves the enrichment to the next session instead of reading a zero slice as a wall. The
acquisition's skip bar is `skipPoolFactor × min(F, queuedPerSource)` with F the plan's follows for the
day. A read refusal that names no instant defers optional reads to the plan-day's end, and the
bootstrap's waits are the loop's idle beat over known events (the frontier's resume instant, the read
deferral), never a fixed beat or a hot loop on a past instant. The engine's freshness windows run in
plan-days: a profile or a failed enrichment stays fresh through today and the six plan-days before it,
so it lapses as `planDayStartAfter(WEEKLY_CYCLE)` of its own plan-day begins. The `ownFollowersPickMax`,
`maxCoverageFraction` and `maxEnrichPassesPerCycle` bounds are read from `EXPLORATION_POLICY`.
