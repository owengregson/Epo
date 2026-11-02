# 0211 — Resumable sources and finite exploration reads

Status: accepted; policy values are provisional

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
