/** Empty projections while the graph session is closed: no plan or account facts have been read. */

import type { FeedView } from '@/shared/feed';
import type { SettingsFacts } from '@/shared/settings-facts';
import { NOT_BUILT_FIELDS } from '@/shared/status-fields';
import {
  type AreaReport, type MeterReading, SURFACE_AREAS, SURFACE_METERS, type SurfaceMeter, type SurfaceReport,
} from '@/shared/surface-health';
import type { EpoStatus, PruneStatus } from '@/types';

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

/** The surface report before anything was read: every area unseen, nothing recorded, no meter sample. */
export function notBuiltSurfaceReport(now: number): SurfaceReport {
  const area = (a: AreaReport['area']): AreaReport => ({
    area: a, state: 'unseen', paused: [], lastReadAt: null,
    today: { canonical: 0, normalized: 0, recovered: 0, failed: 0, walls: 0, rowIssues: 0, fieldIssues: 0 },
  });
  const unsampled = (): MeterReading => ({ n: 0, p50: null, p95: null });
  return {
    // No surface has been read yet, so none is named.
    surfaceId: '',
    generatedAt: now,
    areas: SURFACE_AREAS.map(area),
    changes: [],
    meter: Object.fromEntries(SURFACE_METERS.map((m) => [m, unsampled()])) as Record<SurfaceMeter, MeterReading>,
    copyText: '',
  };
}

/** The prune projection before a graph exists: idle and zeroed until the plan and store open. */
export function notBuiltPruneStatus(): PruneStatus {
  return {
    state: 'idle',
    following: 0,
    followers: 0,
    candidates: 0,
    unfollowed: 0,
    remaining: 0,
    dailyDone: 0,
    dailyLimit: 0,
    lastRunAt: null,
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
 * The growth projection before a graph exists: `loggedIn` and `online` are the only fields that can be true;
 * every count is one the graph has not been asked for, `basis` is 'not-built' and every optional status
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
    loggedIn,
    ...NOT_BUILT_FIELDS,
  };
}
