/**
 * The projections served while the graph session is CLOSED.
 *
 * `Foundation` answered ~40 entry points with `if (graph === null) return
 * notBuiltStatus(...)`, and both shapes were literals inside the 2,200-line
 * file — so the one thing the renderer sees before login lived next to the
 * engine wiring. They are pure functions of Settings plus the last known
 * connectivity, so they belong beside the projections registry rather than in
 * the composition root. See ADR 1007.
 *
 * Values are all-zero on purpose, never fabricated: PRINCIPLES §1 — a number
 * we have not observed is not a fact. The two knobs that ARE known before a
 * build (the prune daily limit and its persisted last-run stamp) come from
 * Settings, which is why the prune shape takes it.
 */

import type { FeedView } from '@/shared/feed';
import type { SettingsFacts } from '@/shared/settings-facts';
import { NOT_BUILT_FIELDS } from '@/shared/status-fields';
import type { EpoStatus, PruneStatus, Settings } from '@/types';

/** The Settings facts before the store opens (`why` is the caller's reason): every field honest-unknown. */
export function notBuiltFacts(_why: 'signed-out' | 'loading' | 'error'): SettingsFacts {
  return {
    built: false,
    seed: { kind: 'loading' },
    ownAccount: { isPrivate: null },
    protection: null,
    cleanup: null,
  };
}

/** The feed before the graph exists: empty, nothing to narrate yet. */
export function notBuiltFeed(now: number): FeedView {
  return { items: [], awayFrom: null, windowStart: now, shapedAt: now };
}

/** The prune projection before a graph exists: idle, zeroed, settings-seeded. */
export function notBuiltPruneStatus(s: Settings): PruneStatus {
  return {
    state: 'idle',
    following: 0,
    followers: 0,
    candidates: 0,
    unfollowed: 0,
    remaining: 0,
    dailyDone: 0,
    dailyLimit: s.pruneDailyLimit,
    lastRunAt: s.pruneLastRunAt,
    lastSentinel: null,
    nextActionAt: null,
    scanReady: false,
    scanPhase: null,
    scanAt: null,
    scanEstimates: null,
    graph: { following: 0, followers: 0, notFollowingBack: 0 },
  };
}

/**
 * The growth projection before a graph exists. `loggedIn` and `online` are the
 * only two fields that can be true here — everything else is a count the graph
 * has not yet been asked for: `basis` is 'not-built' and every optional status
 * field is `null` ("not known yet", never a zero).
 */
export function notBuiltStatus(loggedIn: boolean, online: boolean): EpoStatus {
  return {
    state: 'idle',
    currentTargetPk: null,
    currentTargetUsername: null,
    chainIndex: null,
    actionsToday: 0,
    remainingToday: 0,
    plannedToday: 0,
    atHardCeiling: false,
    queued: 0,
    pendingFollowback: 0,
    followedBackHeld: 0,
    unfollowDue: 0,
    lastStep: null,
    lastSentinel: null,
    lastActionAt: null,
    sessionStartedAt: null,
    nextActionAt: null,
    netToday: 0,
    online,
    haltReason: null,
    recovery: null,
    pacing: null,
    loggedIn,
    ...NOT_BUILT_FIELDS,
  };
}
