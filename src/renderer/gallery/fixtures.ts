/**
 * Gallery fixtures — the console's states, frozen.
 *
 * The gallery route (`?gallery=1`) is the repo's answer to Storybook (ADR
 * 1006): a scenario is just a set of PROJECTIONS, because every card now reads
 * the shell's signals. So a "story" here is a plain object, not a component
 * wrapper — and the thing it renders is the real view with the real cards in
 * the real cascade, never a card in a white box.
 *
 * The shapes come from `@/types`; the numbers are plausible mid-run values, so
 * a designer sees typography under realistic digit widths (five-figure counts,
 * a negative net, a long handle) instead of the 0/— empty state.
 */
import { livePlan } from '@/renderer/gallery/fixtures-live-data';
import {
  type ChainTargetDetail,
  type ChainTargetView,
  type EpoStatus,
  GRAPH_NODE_STATUSES,
  type GraphNodeStatus,
  type GraphSnapshot,
  type GraphSnapshotRead,
  type GrowthSeriesRead,
  type LogEntry,
  type PruneStatus,
  type QueueRow,
} from '@/types';

const MIN = 60_000;

/** A neutral, logged-in idle engine — every scenario starts from this. */
export function baseStatus(over: Partial<EpoStatus> = {}): EpoStatus {
  return {
    basis: 'built',
    state: 'idle',
    loggedIn: true,
    currentTargetPk: '1001',
    currentTargetUsername: 'longish.handle.example',
    chainIndex: 2,
    actionsToday: 34,
    remainingToday: 26,
    plannedToday: 60,
    atHardCeiling: false,
    queued: 1_284,
    pendingFollowback: 213,
    followedBackHeld: 88,
    unfollowDue: 17,
    lastStep: 'acted',
    lastSentinel: null,
    lastActionAt: Date.now() - 4 * MIN,
    sessionStartedAt: Date.now() - 96 * MIN,
    nextActionAt: Date.now() + 2 * MIN,
    parkedUntil: null,
    parkReason: null,
    netToday: 21,
    online: true,
    haltReason: null,
    recovery: null,
    ...over,
  };
}

/** A neutral idle prune projection. */
export function basePrune(over: Partial<PruneStatus> = {}): PruneStatus {
  return {
    state: 'idle',
    following: 4_820,
    followers: 3_017,
    candidates: 1_902,
    scanReady: true,
    scanAt: Date.now() - 3 * 60 * MIN,
    unfollowed: 0,
    remaining: 1_902,
    dailyDone: 0,
    dailyLimit: livePlan().kinds.unfollow.planned,
    lastRunAt: Date.now() - 26 * 60 * MIN,
    lastSentinel: null,
    haltReason: null,
    nextActionAt: null,
    upNext: null,
    scanPhase: null,
    scanEstimates: null,
    graph: { following: 4_820, followers: 3_017, notFollowingBack: 1_902 },
    census: null,
    rawRemaining: 1_902,
    ...over,
  };
}

/** A two-hop chain so the lineage trail renders its per-node yield sublines. */
export const GALLERY_CHAIN: ChainTargetView[] = [
  {
    accountPk: '1000',
    source: 'seed',
    status: 'exhausted',
    chainIndex: 0,
    username: 'seed.account',
    yield: {
      total: 640,
      followedBack: 178,
      followBackRate: 0.278,
      poolSize: 12_400,
      mutualOverlap: 0.11,
    },
  },
  {
    accountPk: '1001',
    source: 'discovered',
    status: 'active',
    chainIndex: 2,
    username: 'longish.handle.example',
    yield: {
      total: 214,
      followedBack: 51,
      followBackRate: 0.238,
      poolSize: 8_150,
      mutualOverlap: 0.07,
    },
  },
];

/** The current source's measured counts, for the three populated Working stories. */
export const GALLERY_TARGET_DETAIL: ChainTargetDetail = {
  ...GALLERY_CHAIN[1],
  funnel: { queued: 1_284, pending_followback: 87, followed_back: 51, unfollow_queued: 17,
    unfollowed: 50, abandoned: 3, external: 5, kept: 9 },
  trueFollowers: 24_800,
  scanned: 8_150,
  remainingActionable: 1_620,
  resolvedOutcomes: 127,
  medianFollowbackMs: 31 * 60 * MIN,
  runway: { days: 54, overCap: false },
};

const growthStart = new Date();
growthStart.setHours(0, 0, 0, 0);
growthStart.setDate(growthStart.getDate() - 13);

/** Net +83 from a 1,201 baseline to the Working header's 1,284; the last day's +12 matches today.net. */
export const GALLERY_GROWTH_SERIES: GrowthSeriesRead = {
  baselineAt: growthStart.getTime(),
  points: [0, -3, -1, 5, 12, 10, 20, 31, 38, 49, 57, 64, 71, 83].map((cumulativeNet, i) => {
    const day = new Date(growthStart);
    day.setDate(day.getDate() + i);
    return { dayStartMs: day.getTime(), cumulativeNet };
  }),
};

/** Rows for whichever queue stage the Queues view is showing. */
export const GALLERY_QUEUE: QueueRow[] = Array.from({ length: 8 }, (_, i) => ({
  pk: `20${i}`,
  username: i % 3 === 0 ? `candidate.number.${i}` : `cand${i}`,
  ratio: 0.42 - i * 0.03,
  isPrivate: i === 5,
  mutuals: 12 + i * 7,
  score: 0.91 - i * 0.05,
  followedAt: Date.now() - (i + 1) * 9 * 60 * MIN,
  holdUntil: Date.now() + (i + 1) * 12 * 60 * MIN,
  unfollowDueAt: Date.now() + (i + 1) * 30 * 60 * MIN,
}));

export const GALLERY_LOG: LogEntry[] = [
  { at: Date.now() - 9 * MIN, level: 'info', message: 'Read 200 followers of @seed.account' },
  { at: Date.now() - 7 * MIN, level: 'debug', message: 'Ranked 1,284 candidates' },
  { at: Date.now() - 5 * MIN, level: 'info', message: 'Followed @cand4 (r=0.31)' },
  { at: Date.now() - 3 * MIN, level: 'warn', message: 'Slower response — easing the pace' },
  { at: Date.now() - 1 * MIN, level: 'error', message: 'Follow refused — backing off 12m' },
];

/** One selectable console posture. */
export interface Scenario {
  key: string;
  label: string;
  status: EpoStatus;
  prune: PruneStatus;
  /** Writes what the live column reads beyond status (feed, live op, Settings view slice); live scenarios only. */
  apply?(): void;
}

/**
 * Every posture the console is DESIGNED for, in the order a reviewer should
 * walk them: the ordinary run, then each way it can be stopped, then the two
 * prune drivers that take the transport away from the growth engine.
 */
export const SCENARIOS: Scenario[] = [
  { key: 'idle', label: 'Idle', status: baseStatus(), prune: basePrune() },
  {
    key: 'running',
    label: 'Running',
    status: baseStatus({ state: 'running' }),
    prune: basePrune(),
  },
  {
    key: 'parked',
    label: 'Resting between sessions',
    status: baseStatus({
      state: 'running',
      parkReason: 'session',
      parkedUntil: Date.now() + 7 * 60 * MIN,
      nextActionAt: null,
    }),
    prune: basePrune(),
  },
  {
    key: 'halted',
    label: 'Halted',
    status: baseStatus({ state: 'halted', haltReason: 'seed-unresolved', nextActionAt: null }),
    prune: basePrune(),
  },
  {
    key: 'offline',
    label: 'Offline hold',
    status: baseStatus({ state: 'running', online: false, nextActionAt: null }),
    prune: basePrune(),
  },
  {
    key: 'logged-out',
    label: 'Logged out',
    status: baseStatus({ state: 'idle', loggedIn: false }),
    prune: basePrune(),
  },
  {
    key: 'ceiling',
    label: 'At the daily ceiling',
    status: baseStatus({
      state: 'running',
      actionsToday: 60,
      remainingToday: 0,
      atHardCeiling: true,
      nextActionAt: null,
    }),
    prune: basePrune(),
  },
  {
    key: 'prune-scan',
    label: 'Prune — scanning',
    status: baseStatus({ state: 'idle' }),
    prune: basePrune({ state: 'scanning', following: 2_940, followers: 1_880 }),
  },
  {
    key: 'prune-run',
    label: 'Prune — running',
    status: baseStatus({ state: 'idle' }),
    prune: basePrune({
      state: 'running',
      unfollowed: 46,
      remaining: 1_856,
      dailyDone: 46,
      nextActionAt: Date.now() + 40_000,
    }),
  },
];

/** Invented graph accounts only; all columns, status totals and hub membership agree. */
export type GalleryGraphState = 'populated' | 'empty' | 'unavailable';

const TOTALS: Record<GraphNodeStatus, number> = {
  known: 64, queued: 128, waiting: 38, held: 24, unfollow_queued: 17, unfollowed: 50,
  abandoned: 3, external: 5, follows_you: 36, you_follow: 29, mutual: 42, kept: 9,
};

/** Fresh arrays prevent a review session from changing the next fixture's data. */
export function galleryGraph(state: GalleryGraphState): GraphSnapshotRead {
  if (state === 'unavailable') return { unavailable: true };
  const counts = Object.fromEntries(GRAPH_NODE_STATUSES.map((status) => [status, state === 'empty' ? 0 : TOTALS[status]])) as Record<GraphNodeStatus, number>;
  const statuses = GRAPH_NODE_STATUSES.flatMap((status, index) => Array.from({ length: counts[status] }, () => index));
  const hubs: GraphSnapshot['hubs'] = state === 'empty' ? [] : [
    { pk: 'gallery-self', username: 'yourname', kind: 'self', targetStatus: null, chainIndex: null, memberCount: 0 },
    { pk: '1000', username: 'seed.account', kind: 'target', targetStatus: 'exhausted', chainIndex: 0, memberCount: 0 },
    { pk: '1001', username: 'longish.handle.example', kind: 'target', targetStatus: 'active', chainIndex: 2, memberCount: 0 },
  ];
  const hubIndex = statuses.map((status, i) => status >= GRAPH_NODE_STATUSES.indexOf('follows_you') ? 0 : 1 + i % 2);
  for (const index of hubIndex) hubs[index].memberCount += 1;
  return {
    at: Date.now(), hubs, counts,
    pks: statuses.map((_, i) => `gallery-person-${i}`),
    usernames: statuses.map((_, i) => i % 11 === 0 ? `longish.synthetic.person.${i}` : `person.${i}`),
    statuses: new Uint8Array(statuses),
    progress: new Float32Array(statuses.map((status, i) => status === 2 || status === 3 ? (i % 9) / 8 : -1)),
    hubIndex: new Int32Array(hubIndex),
    followers: new Float64Array(statuses.map((_, i) => i % 13 === 0 ? -1 : 120 + i * 17)),
  };
}
