# 0214 — Protection covers every automatic unfollow; the `kept` state

Status: accepted (reverses the 2026-08-31 follow-back-only bio rule)

## Context

Epo kept two lists the user could edit: a prune whitelist (people never pruned) and a bio keep-list. Each was
read by one path only. The whitelist guarded the bulk prune and the woven prune feed; the bio list guarded only
follow-backs at the click (`mutation-policy.ts:89-92`). The lifecycle unfollows did not consult either list:
the no-follow-back reclaim, the hold-expired rotation and the recovery healer's requeues. So a person the user
had asked Epo to keep could still be unfollowed by the growth loop, and a stale bio in the store could stand in
for the profile Instagram served at the click. A record that could not be judged deferred and was offered again
at once, which blocked the queue behind it.

## Decision

- **One pure predicate** (`src/shared/unfollow-protection.ts`) judges every automatic unfollow on every path:
  P1 the reclaim, P2 the rotation, P3 the churn execution, P4 the healer's requeues, P5/P6 the prune run, P7 the
  woven feed, P9 a manual unfollow (a typed `protected` refusal) and P10 the prune-run mode rule. It covers people
  (by pk once linked, never by a former username), bio words (Unicode-folded, `anywhere` or `whole-word`) and
  verified accounts. Precedence: paused → protected → unknown (a configured rule lacks its fact) → clear. It never
  reads follow-back state, and adding a rule never turns protected or unknown into clear (law L-PROT).
- **Two layers.** Selection judges stored facts with no visit: a protected record moves to `kept`, a paused index
  holds it where it is. The click is authoritative and judges the fresh body's own fields, never the folded
  store row, after the edge write and before the follow-back logic (spec §9.7 step 5). A protection verdict
  consumes the work as `ActionReviewedError`; sources and the starting account are a consuming `protected('source')`.
- **`kept` is a non-blocking state** (migration 14 columns `kept_reason`, `kept_match`, `kept_at`, and the shared
  `recheck_at` / `check_failures`). A protected record leaves the queue. An unreadable one is re-read on a
  plan-derived schedule: one plan-day × 1, 2, 4, 8, then 8 (`derive-parks.ts`). The `ProtectionReconciler`
  re-judges kept records in one transaction, with no Instagram traffic. It runs at graph open, before every
  selection pass when the plan-day or the rules changed, and on a settings reload.
- **Fail closed.** While the settings document is `needs-review` or `unavailable`, every automatic unfollow
  pauses (verdict `paused`). Follows continue. `EpoStatus.unfollowsPaused` names the reason.

## Consequences

- No path unfollows a protected account, whether or not it follows back. Epo still follows protected accounts,
  and kept records keep their passive follow-back stamps, so the statistics stay true.
- An account whose bio or verified flag cannot be read is kept, never unfollowed. It does not block the records
  behind it, and it is read again at most once per window.
- The whitelist and the bio keep-list are no longer prune settings. The v1 files keep them for older builds, and
  the migration folds them into the predicate's rules monotonically (law L-MIG).

## Alternatives rejected

- **Protecting only follow-backs (the 2026-08-31 rule):** a keyword the user typed did not protect a
  non-follower, which surprised the owner. It also left P1, P2 and P4 unguarded.
- **Judging the click on the stored row:** the account fold keeps an old bio when a body lacks `biography`,
  which hides exactly the drift the rule exists to catch.
- **A deferral for unreadable records:** it re-offered the same unfollow every step, and a protected or unreadable
  head blocked the queue.
- **Former usernames as a rule:** someone else could take an old handle and inherit the protection.

## Amendment — edits while an action is being prepared

The fresh profile visit produces a local guard bound to that action's own observation. Before the first dispatch
and every later confirmation-layer press, the guard reads the current protection index, source/request membership
and surface pause. A new keyword, account entry, verified rule or paused protection state can therefore stop the
press even when saved after the visit. It never repeats the visit, admission or journal-dispatch mark. Practice
mode is also read again before a physical press. A refusal after the initial header press remains an uncertain
action for ordinary journal settlement; the guard does not guess whether the server changed the relationship.
