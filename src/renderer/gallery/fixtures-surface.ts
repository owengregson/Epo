/**
 * Gallery scenarios for the Instagram compatibility surfaces (spec §10.7, owner Q25 and Q39): Epo adapted to a
 * change, unfollows paused, and finding new people paused because follower lists changed shape.
 */
import { basePrune, baseStatus, type Scenario } from '@/renderer/gallery/fixtures';
import type { AreaState, PausedActivity, SurfaceArea, SurfaceSummary } from '@/shared/surface-health';

const SINCE = Date.UTC(2026, 10, 2, 9);

/** A summary where every area reads normally except `area`, which is in `state`. */
function summary(area: SurfaceArea, state: AreaState, paused: PausedActivity[]): SurfaceSummary {
  const areas: Record<SurfaceArea, AreaState> = { profiles: 'ok', notifications: 'ok', 'follow-requests': 'ok', lists: 'ok',
    'relationship-checks': 'ok', 'follow-actions': 'ok' };
  areas[area] = state;
  return { revision: 1, worst: state, areas, paused, adapting: state === 'adapting', attention: [{ area, state, paused, since: SINCE }] };
}

export const SURFACE_SCENARIOS: Scenario[] = [
  {
    key: 'surface-adapted',
    label: 'Adapted to a change',
    status: baseStatus({ state: 'running', surface: summary('notifications', 'adapting', []) }),
    prune: basePrune(),
  },
  {
    key: 'surface-unfollows-paused',
    label: 'Unfollows paused',
    status: baseStatus({ state: 'running', surface: summary('profiles', 'paused', ['unfollows', 'relationship-reads']) }),
    prune: basePrune(),
  },
  {
    key: 'surface-exploration-paused',
    label: 'Finding new people paused',
    status: baseStatus({ state: 'running', surface: summary('lists', 'paused', ['cleanup', 'exploration']) }),
    prune: basePrune(),
  },
];
