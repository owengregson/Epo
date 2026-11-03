/**
 * Surface health (spec §10.7, Appendix D.1): the areas a changed Instagram surface affects, their
 * states, the status push's summary and the Diagnostics report. Renderer-safe and pure; the gate is
 * `surface-gate.ts`'s, re-exported here, and the labels are the parse-health stream's.
 */
import type { PausedActivity } from './surface-gate';

export { NEVER_PAUSED, type PausedActivity, type SurfaceGate } from './surface-gate';

export const SURFACE_AREAS = [
  'profiles', 'notifications', 'follow-requests', 'lists', 'relationship-checks', 'follow-actions',
] as const;
export type SurfaceArea = (typeof SURFACE_AREAS)[number];

export type AreaState = 'ok' | 'adapting' | 'paused' | 'unreadable' | 'limited' | 'unseen';

/** The adapter's measured quantities (`src/surface/meter.ts` measures them), restated import-free. */
export const SURFACE_METERS = ['hydration', 'mutation-arrival', 'list-page', 'body-read', 'scroll-settle'] as const;
export type SurfaceMeter = (typeof SURFACE_METERS)[number];

/** The status push's slice (`EpoStatus.surface`). */
export interface SurfaceSummary {
  readonly revision: number;
  /** The worst area's state. */
  readonly worst: AreaState;
  readonly areas: Readonly<Record<SurfaceArea, AreaState>>;
  readonly paused: readonly PausedActivity[];
  readonly adapting: boolean;
  readonly attention: ReadonlyArray<{ readonly area: SurfaceArea; readonly state: AreaState;
    readonly paused: readonly PausedActivity[]; readonly since: number }>;
}

/** One area in the report, with today's read tallies. */
export interface AreaReport {
  area: SurfaceArea;
  state: AreaState;
  paused: readonly PausedActivity[];
  lastReadAt: number | null;
  today: { canonical: number; normalized: number; recovered: number; failed: number; walls: number;
    rowIssues: number; fieldIssues: number };
}

/** One recorded change in how a response arrives. */
export interface SurfaceChange {
  area: SurfaceArea;
  endpoint: string;
  cls: string;
  /** A `FIELD_LABEL` key. */
  field: string | null;
  path: string;
  firstSeenAt: number;
  lastSeenAt: number;
  seen: number;
  state: 'open' | 'consistent' | 'contradicted';
  witnesses: number;
  hint: string | null;
  hasSample: boolean;
}

/** A meter's sample count and percentiles; null percentiles before any sample. */
export interface MeterReading { n: number; p50: number | null; p95: number | null }

/** The Diagnostics report (`surface:report`). */
export interface SurfaceReport {
  readonly surfaceId: string;
  readonly generatedAt: number;
  readonly areas: ReadonlyArray<AreaReport>;
  readonly changes: ReadonlyArray<SurfaceChange>;
  readonly meter: Readonly<Record<SurfaceMeter, MeterReading>>;
  /** Built in main: no usernames, pks or values; scrubbed samples included. */
  readonly copyText: string;
}

// ---------------------------------------------------------------------------
// Labels and copy (spec Appendix D.2; the user-facing word for the cleanup feature is "Prune")
// ---------------------------------------------------------------------------

export const AREA_LABEL: Readonly<Record<SurfaceArea, string>> = {
  profiles: 'Profiles',
  notifications: 'Notifications',
  'follow-requests': 'Follow requests',
  lists: 'Follower and following lists',
  'relationship-checks': 'Follow status checks',
  'follow-actions': 'Follow and unfollow results',
};

export const STATE_LABEL: Readonly<Record<AreaState, string>> = {
  ok: 'Working normally',
  adapting: 'Adapted to a change',
  paused: 'Paused',
  unreadable: "Can't read right now",
  limited: 'Instagram is slowing things down',
  unseen: 'Not checked yet',
};

export const PAUSED_LABEL: Readonly<Record<PausedActivity, string>> = {
  unfollows: 'Unfollows',
  'relationship-reads': 'Follow status checks',
  cleanup: 'Pruning',
  'follow-back-decisions': 'Follow-back decisions',
  exploration: 'Finding new people',
};

/** Path pattern → the friendly name a change shows (anything else is "a detail Instagram renamed"). */
export const FIELD_LABEL: Readonly<Record<string, string>> = {
  'friendship_status.outgoing_request': 'follow request sent',
  'friendship_status.following': 'you follow them',
  'friendship_status.followed_by': 'they follow you',
  'friendship_status.incoming_request': 'they asked to follow you',
  follower_count: 'follower count',
  following_count: 'following count',
  biography: 'bio',
  is_private: 'private account',
  is_verified: 'verified badge',
  username: 'username',
  pk: 'account ID',
  next_max_id: 'next-page marker',
  has_more: 'next-page marker',
  big_list: 'next-page marker',
  story_type: 'notification type',
  'args.profile_id': 'who followed you',
};

/** The FIELD_LABEL key a path pattern ends on (the longest match), or null. */
export function fieldOf(path: string): string | null {
  const keys = Object.keys(FIELD_LABEL).filter((k) => path === k || path.endsWith(`.${k}`));
  return keys.sort((a, b) => b.length - a.length)[0] ?? null;
}

const RENAMED = 'a detail Instagram renamed';
export const fieldLabel = (field: string | null): string => (field === null ? RENAMED : (FIELD_LABEL[field] ?? RENAMED));

export const COMPATIBILITY_LEAD =
  'Instagram sometimes changes how its app sends information. Epo checks every response it reads and only acts on what it can read with certainty.';

const PAUSED_COPY: Readonly<Record<PausedActivity, string>> = {
  unfollows: "Epo can't confirm who follows you back right now, so unfollows wait. Following and learning continue.",
  'relationship-reads': '',
  cleanup: "Epo can't confirm your full follower list right now, so pruning waits. Nothing is removed until it can.",
  'follow-back-decisions': "Epo can't read all of your follow requests, so it holds off deciding who didn't follow back.",
  exploration: 'Instagram changed how follower lists look. Epo keeps following the people it already found and pauses finding new ones until an update confirms the change.',
};

/** What an area's state means for the user, in a sentence or two (`since` already formatted). */
export function explanation(area: SurfaceArea, state: AreaState, paused: readonly PausedActivity[], since: string | null): string {
  const name = AREA_LABEL[area].toLowerCase();
  switch (state) {
    case 'adapting':
      return `Instagram changed how it sends ${name}. Epo found the information in its new place and keeps learning from it. It won't unfollow anyone based on it until an Epo update confirms the change.`;
    case 'paused':
      return paused.map((p) => PAUSED_COPY[p]).filter((t) => t !== '').join(' ');
    case 'unreadable':
      return `Epo hasn't been able to read ${name}${since === null ? '' : ` since ${since}`}. It keeps trying at its normal pace. An Epo update may be needed.`;
    case 'limited':
      return 'Instagram is asking Epo to slow down here. Epo waits it out on its own.';
    default:
      return '';
  }
}

/** The sidebar's one compatibility line: calm while Epo adapts, attention while work is paused or unreadable. */
export function noticeLine(summary: SurfaceSummary | null | undefined): { tone: 'calm' | 'attention'; text: string } | null {
  const order: readonly AreaState[] = ['paused', 'unreadable', 'adapting'];
  const first = [...(summary?.attention ?? [])].sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state))[0];
  if (first === undefined) return null;
  const name = AREA_LABEL[first.area].toLowerCase();
  if (first.state === 'adapting') return { tone: 'calm', text: `Adapted to an Instagram change in ${name}. Following continues.` };
  if (first.state === 'unreadable') return { tone: 'attention', text: `Epo can't read ${name} right now. Following continues.` };
  if (first.paused.includes('exploration')) {
    return { tone: 'attention', text: 'Finding new people paused: Instagram changed how follower lists look. Epo keeps following the people it already found.' };
  }
  const what = first.paused.includes('unfollows') ? PAUSED_LABEL.unfollows : PAUSED_LABEL[first.paused[0] ?? 'unfollows'];
  return { tone: 'attention', text: `${what} paused: Instagram changed how it sends ${name}. Following continues.` };
}

/** The Easy-mode one-liner: the worst area's state. */
export const compatibilityLine = (summary: SurfaceSummary | null | undefined): string =>
  `Instagram compatibility: ${STATE_LABEL[summary?.worst ?? 'unseen']}`;

const CONTINUATION_CLASSES = ['more-without-cursor', 'cursor-veto', 'end-claim-false', 'no-continuation-evidence',
  'incomplete-stream'];

/** The one-line description of a recorded change (the "Recent changes" list; `date` formats a moment). */
export function changeLine(c: SurfaceChange, date: (ms: number) => string): string {
  const area = AREA_LABEL[c.area];
  const field = fieldLabel(c.field);
  if (CONTINUATION_CLASSES.includes(c.cls)) return `${area}: the next-page marker changed · scans stop early instead of guessing`;
  switch (c.cls) {
    case 'recovered':
      return `${area}: information arrives in a new place · since ${date(c.firstSeenAt)} · seen ${c.seen} times${
        c.state === 'consistent' ? ` · confirmed on ${c.witnesses} accounts · ready for an update` : ''}`;
    case 'expected-absent':
    case 'unexpected-null':
      return `${area}: ${field} is missing · since ${date(c.firstSeenAt)}`;
    case 'normalized':
      return `${area}: ${field} arrives in a new format · Epo understood it`;
    case 'unrouted':
      return `${area}: Instagram renamed the request it uses · Epo recognized it by its content`;
    case 'rows-unreadable':
    case 'row-issue':
      return `${area}: ${c.seen} entries couldn't be read and were skipped`;
    case 'enum-novel':
      return `${area}: a new kind of notification · follow-backs from it aren't counted`;
    case 'novel-key':
      return `${area}: Instagram started sending new details (${c.seen}) · nothing to do`;
    case 'confirm-unrecognized':
      return 'Follow and unfollow results: a confirmation step looked different · Epo cancelled instead of guessing';
    default:
      return `${area}: a response Epo couldn't read · since ${date(c.firstSeenAt)} · seen ${c.seen} times`;
  }
}
