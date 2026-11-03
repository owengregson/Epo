/**
 * The surface's area states (spec §10.6–§10.7), pure: persisted drift signatures and per-plan-day health in,
 * one state per area out, worst first `unreadable | paused | adapting | limited | ok | unseen`, with the
 * activities each area pauses. The surface gate reads these, so a pause survives a restart and lifts only
 * when clean canonical reads have resolved the signatures behind it.
 */

import {
  type AreaState, type PausedActivity, SURFACE_AREAS, type SurfaceArea, type SurfaceGate, type SurfaceSummary,
} from '@/shared/surface-health';
import type { DriftEndpoint } from '@/surface/sink';

/** What the view reads of one unresolved drift signature. */
export interface DriftRowView {
  readonly endpoint: string; readonly cls: string; readonly path: string; readonly detail: string;
  readonly hintPattern: string | null; readonly firstSeenAt: number; readonly lastSeenAt: number; readonly seen: number;
}

/** What the view reads of one plan-day's health row. */
export interface HealthRowView {
  readonly day: string; readonly endpoint: string; readonly walls: number;
  readonly lastReadAt: number | null; readonly lastOkAt: number | null;
}

export interface AreaView {
  readonly area: SurfaceArea;
  readonly state: AreaState;
  readonly paused: readonly PausedActivity[];
  /** When the signatures behind the state were first seen (null for ok and unseen). */
  readonly since: number | null;
}

const AREA_OF: Readonly<Record<string, SurfaceArea>> = {
  'profile-graphql': 'profiles', 'profile-info': 'profiles', 'activity-feed': 'notifications',
  'friend-requests': 'follow-requests', 'followers-list': 'lists', 'following-list': 'lists',
  'show-many': 'relationship-checks', 'friendship-show': 'relationship-checks', mutation: 'follow-actions',
};

/** The area an endpoint's reads belong to; an unattributed routing signal belongs to none. */
export function areaOf(endpoint: DriftEndpoint | string): SurfaceArea | null {
  return AREA_OF[endpoint] ?? null;
}

const FAILURE = new Set(['mismatch', 'ambiguous', 'transport', 'rows-unreadable']);
const CONTINUATION = new Set(['more-without-cursor', 'cursor-veto', 'end-claim-false', 'no-continuation-evidence',
  'incomplete-stream']);
const ABSENCE = new Set(['expected-absent', 'unexpected-null']);
/** A relationship key: an absence there means a follow state cannot be confirmed. */
const RELATIONSHIP_KEY = /(^|\.)(friendship_status|following|followed_by|outgoing_request|incoming_request)(\.|$)/;
/** Keys every click verdict depends on (spec §7.3): an absence there keeps unfollows waiting. */
const VERDICT_KEY = /(^|\.)(biography|is_verified)$/;

const RANK: readonly AreaState[] = ['unreadable', 'paused', 'adapting', 'limited', 'ok', 'unseen'];

function detailOf(row: DriftRowView): Record<string, unknown> {
  try {
    const parsed = JSON.parse(row.detail) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A failure that, repeated and newer than the last good read, makes an area unreadable. */
function failing(row: DriftRowView): boolean {
  if (FAILURE.has(row.cls)) return true;
  if (row.cls === 'unrouted') return row.hintPattern === null;
  return row.cls === 'wall' && detailOf(row).family === 'server-error';
}

/** The activities one signature pauses in its area; empty when it pauses nothing. */
function pausesOf(area: SurfaceArea, row: DriftRowView): PausedActivity[] {
  const absent = ABSENCE.has(row.cls);
  switch (area) {
    case 'profiles':
      if (row.cls === 'recovered' || (absent && RELATIONSHIP_KEY.test(row.path))) return ['unfollows', 'relationship-reads'];
      return absent && VERDICT_KEY.test(row.path) ? ['unfollows'] : [];
    case 'lists':
      return CONTINUATION.has(row.cls) || absent || row.cls === 'rows-unreadable' || row.cls === 'row-issue' ? ['cleanup'] : [];
    case 'follow-requests':
      return CONTINUATION.has(row.cls) || absent || row.cls === 'rows-unreadable' || row.cls === 'recovered'
        ? ['follow-back-decisions'] : [];
    case 'relationship-checks':
      return absent && RELATIONSHIP_KEY.test(row.path) ? ['relationship-reads'] : [];
    default:
      return [];
  }
}

/** A drifted list page in the sense of spec §10.6: it counts toward pausing exploration. */
const driftedListPage = (row: DriftRowView): boolean =>
  CONTINUATION.has(row.cls) || ABSENCE.has(row.cls) || row.cls === 'rows-unreadable'
  || (row.cls === 'recovered' && detailOf(row).role === 'source-rows');

const adaptingRow = (row: DriftRowView): boolean =>
  row.cls === 'recovered' || (row.cls === 'unrouted' && row.hintPattern !== null) || row.cls === 'confirm-unrecognized';

const earliest = (rows: readonly DriftRowView[]): number | null =>
  rows.length === 0 ? null : Math.min(...rows.map((r) => r.firstSeenAt));

/** Every area's state from the unresolved signatures and the retained health rows; `today` is the plan-day key. */
export function deriveAreas(rows: readonly DriftRowView[], health: readonly HealthRowView[], today: string,
  threshold: number): readonly AreaView[] {
  return SURFACE_AREAS.map((area): AreaView => {
    const mine = rows.filter((r) => areaOf(r.endpoint) === area);
    const reads = health.filter((h) => areaOf(h.endpoint) === area);
    if (mine.length === 0 && reads.every((h) => h.lastReadAt === null)) return { area, state: 'unseen', paused: [], since: null };
    const lastOk = Math.max(...reads.map((h) => h.lastOkAt ?? Number.NEGATIVE_INFINITY), Number.NEGATIVE_INFINITY);
    const broken = mine.filter((r) => failing(r) && r.seen >= threshold && r.lastSeenAt > lastOk);
    const blocking = mine.filter((r) => pausesOf(area, r).length > 0);
    const paused = new Set(blocking.flatMap((r) => pausesOf(area, r)));
    const listPages = mine.filter(driftedListPage);
    if (area === 'lists' && listPages.reduce((n, r) => n + r.seen, 0) >= threshold) paused.add('exploration');
    const adapting = mine.filter(adaptingRow);
    const order = [...paused];
    if (broken.length > 0) return { area, state: 'unreadable', paused: order, since: earliest(broken) };
    if (paused.size > 0) return { area, state: 'paused', paused: order, since: earliest([...blocking, ...listPages]) };
    if (adapting.length > 0) return { area, state: 'adapting', paused: [], since: earliest(adapting) };
    const walled = reads.filter((h) => h.day === today && h.walls > 0);
    if (walled.length > 0) return { area, state: 'limited', paused: [], since: Math.min(...walled.map((h) => h.lastReadAt ?? 0)) };
    return { area, state: 'ok', paused: [], since: null };
  });
}

/** The status push's slice: the worst state, every area's state, what is paused, and what needs a line. */
export function summarize(areas: readonly AreaView[], revision: number): SurfaceSummary {
  const states = Object.fromEntries(areas.map((a) => [a.area, a.state])) as Record<SurfaceArea, AreaState>;
  const worst = RANK.find((s) => areas.some((a) => a.state === s)) ?? 'unseen';
  const paused = [...new Set(areas.flatMap((a) => a.paused))];
  const attention = areas
    .filter((a) => a.state === 'unreadable' || a.state === 'paused' || a.state === 'adapting')
    .map((a) => ({ area: a.area, state: a.state, paused: a.paused, since: a.since ?? 0 }));
  return { revision, worst, areas: states, paused, adapting: areas.some((a) => a.state === 'adapting'), attention };
}

/** The surface gate over a live area view: an activity is paused while any area pauses it. */
export function createSurfaceGate(view: () => readonly AreaView[]): SurfaceGate {
  return { paused: (activity) => view().some((a) => a.paused.includes(activity)) };
}
