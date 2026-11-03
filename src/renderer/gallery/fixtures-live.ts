/**
 * Gallery scenarios for the live column (spec §12.2–12.3, the approved Sidebar boards): every posture,
 * the first run, each Boost state, the catch-up, the away feed, practice mode and unconfirmed actions. A
 * scenario's `apply` writes what the column reads beyond status (the feed, the live op, the Settings view
 * slice, the Boost preview); `resetLiveGallery` puts those back first, so scenarios never bleed.
 */

import type { Res } from '@/ipc/contract';
import { activitySignal, feedSignal } from '@/renderer/app/live-signals';
import { settingsFactsSignal } from '@/renderer/app/shell-context';
import { basePrune, baseStatus, type Scenario } from '@/renderer/gallery/fixtures';
import {
  boostPreview, boostView, catchingUp, dayOffPlan, HOUR, lateStartPlan, lightPlan, liveFeed, livePlan, MIN, NOW,
  restingPlan, setGalleryView,
} from '@/renderer/gallery/fixtures-live-data';
import { answerInGallery } from '@/renderer/gallery/gallery-bridge';
import type { BootView } from '@/shared/boot';
import type { LiveOp } from '@/shared/live-op';

type EpoStatus = Res<'status'>;
type PruneStatus = Res<'pruneStatus'>;

const RUNTIME = {
  desired: 'running' as const, phase: 'ready' as const, blockedReason: null, lastProgressAt: null, progressPhase: null,
  incidents: [],
};
const BOOT: BootView = {
  phase: 'live', identity: 'signed-in', data: 'open', dataProblem: null, tab: 'settled', ig: 'ready',
  startedAt: NOW - 40_000, revealBy: NOW - 32_000, startup: { step: null, startQueued: false, done: true },
};

/** A built day: the plan, the own counts with their age, today's tallies. */
function day(over: Partial<EpoStatus> = {}): EpoStatus {
  return baseStatus({
    plan: livePlan(), boot: BOOT, account: { username: 'yourname', confirmed: true }, boost: boostView({ state: 'off' }),
    own: { followers: { count: 1284, at: NOW - 6 * MIN, seenSince: { gained: 2, lost: 0 } }, following: { count: 902, at: NOW - 6 * MIN } },
    today: { startsAt: NOW - 9 * HOUR, endsAt: NOW + 15 * HOUR, net: 12, gained: 15, lost: 3, unattributed: 0, followBacks: 5, outside: 0 },
    pendingFollowback: 38, runtime: RUNTIME, ...over,
  });
}

const running = (over: Partial<EpoStatus> = {}): EpoStatus => day({ state: 'running', lastStep: 'acted', ...over });
const park = (reason: NonNullable<EpoStatus['parkReason']>, minutes: number, over: Partial<EpoStatus> = {}): EpoStatus =>
  running({ parkReason: reason, parkedUntil: NOW + minutes * MIN, nextActionAt: null, ...over });

interface Live {
  readonly op?: LiveOp;
  readonly away?: boolean;
  readonly emptyFeed?: boolean;
  readonly boost?: boolean;
  readonly practice?: boolean;
  readonly seed?: string;
  readonly preview?: Parameters<typeof boostPreview>[0] | null;
}

/** One scenario: its status (and prune), plus what the column reads beyond them. */
function scenario(key: string, label: string, status: EpoStatus, live: Live = {}, prune: PruneStatus = basePrune()): Scenario {
  return {
    key: `live-${key}`, label, status, prune,
    apply() {
      feedSignal.value = live.emptyFeed ? { ...liveFeed(false), items: [] } : liveFeed(live.away ?? false);
      activitySignal.value = live.op === undefined ? null : { activity: { info: { kind: 'page', op: live.op }, since: NOW }, busy: true, holds: [] };
      setGalleryView({ boost: live.boost ?? false, practice: live.practice, seed: live.seed });
      answerInGallery('previewBoost', live.preview === null ? null : boostPreview(live.preview ?? {}));
    },
  };
}

/** Back to a column with no extras (the console's own scenarios read only status). */
export function resetLiveGallery(): void {
  feedSignal.value = liveFeed(false);
  activitySignal.value = null;
  settingsFactsSignal.value = null;
  setGalleryView({ boost: false });
  answerInGallery('previewBoost', null);
}

const follow: LiveOp = { op: 'follow', username: 'studio.lumen' };
const reading: LiveOp = { op: 'read-list', list: 'followers', of: 'longish.handle.example', done: 120, total: 250 };
const boot = (over: Partial<BootView>): BootView => ({ ...BOOT, ...over });

export const LIVE_SCENARIOS: Scenario[] = [
  scenario('working', 'Working · following', running({ nextActionAt: NOW + 72_000 }), { op: follow }),
  scenario('working-next', 'Working · next step', running({ nextActionAt: NOW + 72_000, lastActionAt: NOW - 30_000 })),
  scenario('reading', 'Working · reading a list', running(), { op: reading }),
  scenario('resting', 'Resting', park('session', 132, { plan: restingPlan() })),
  scenario('pacing', 'Pacing', park('velocity', 12)),
  scenario('retrying', 'Retrying soon', park('enrich-backoff', 3)),
  scenario('break', 'Taking a break', running({ recovery: { phase: 'holding', attempt: 2, maxAttempts: 3, resumeAt: NOW + 25 * MIN } })),
  scenario('done', 'Done for today', park('daily-ceiling', 14 * 60)),
  scenario('done-late', 'Done · opened late', park('session', 14 * 60, { plan: lateStartPlan() })),
  scenario('done-light', 'Done · light day', park('session', 14 * 60, { plan: lightPlan() })),
  scenario('day-off', 'Day off', park('session', 14 * 60, { plan: dayOffPlan() })),
  scenario('starting', 'Starting', running({ lastStep: null, lastActionAt: NOW - 20 * HOUR })),
  scenario('catching-up', 'Catching up', day({ boot: boot({ startup: { step: 'catch-up', startQueued: true, done: false } }), catchUp: catchingUp() }), { away: true }),
  scenario('paused', 'Paused', day({ state: 'paused', runtime: { ...RUNTIME, desired: 'paused' } })),
  scenario('stopped', 'Stopped', day({ runtime: { ...RUNTIME, desired: 'stopped' } })),
  scenario('needs-seed', 'Get set up', day({ lastActionAt: null, runtime: { ...RUNTIME, desired: 'stopped' } }), { seed: '', emptyFeed: true }),
  scenario('first-run', 'First run', day({ lastActionAt: null, runtime: { ...RUNTIME, desired: 'stopped' } }), { emptyFeed: true }),
  scenario('attention', 'Needs attention', day({ state: 'halted', haltReason: 'sentinel:challenge', runtime: { ...RUNTIME, desired: 'stopped' } })),
  scenario('attention-unknown', 'Needs attention · unknown', day({ state: 'halted', haltReason: 'some-new-key' })),
  scenario('unconfirmed', 'Actions unconfirmed', running({ nextActionAt: NOW + 72_000, actionsUnconfirmed: { kind: 'unfollow', streak: 2 } })),
  scenario('sleeping', 'Sleeping', running({ runtime: { ...RUNTIME, phase: 'suspended' } })),
  scenario('reconnecting', 'Reconnecting', running({ runtime: { ...RUNTIME, phase: 'reconciling' } })),
  scenario('offline', 'Offline', running({ online: false, nextActionAt: null })),
  scenario('signed-out', 'Signed out', day({ loggedIn: false, account: null, boot: boot({ identity: 'signed-out', data: 'not-applicable' }) })),
  scenario('data-unavailable', 'Can’t open data', day({ boot: boot({ data: 'unavailable', dataProblem: 'locked' }) })),
  scenario('starting-up', 'Starting up', day({ boot: boot({ phase: 'starting' }) })),
  scenario('not-built', 'Loading numbers', day({ basis: 'not-built', plan: null, own: null, today: null })),
  scenario('boot-slow-ig', 'Boot · Instagram loading', day({ boot: boot({ ig: 'placeholder', tab: 'loading' }) })),
  scenario('boot-offline', 'Boot · offline', running({ online: false, nextActionAt: null, boot: boot({ ig: 'placeholder', tab: 'failed' }) })),
  scenario('pruning', 'Pruning', day({ state: 'idle' }), {}, basePrune({ state: 'running', unfollowed: 12, remaining: 28 })),
  scenario('prune-paused', 'Pruning paused', day({ state: 'idle' }), {}, basePrune({ state: 'paused', unfollowed: 12, remaining: 28 })),
  scenario('practice', 'Practice mode', running({ nextActionAt: NOW + 72_000 }), { practice: true }),
  scenario('away', 'Away feed', day(), { away: true }),
  scenario('boost-ready', 'Boost · ready', running({ nextActionAt: NOW + 72_000 }), { boost: true }),
  scenario('boost-ready-stopped', 'Boost · Start and Boost', day(), { boost: true }),
  scenario('boost-nothing', 'Boost · nothing to shift', running(), { boost: true, preview: { why: 'nothing-to-shift', extraFollowsToday: 0, unfollowsWaiting: 0 } }),
  scenario('boost-backlog', 'Boost · backlog', running(), { boost: true, preview: { why: 'backlog' } }),
  scenario('boost-unavailable', 'Boost · not ready', running(), { boost: false }),
  scenario('boost-on', 'Boost · on', running({ boost: boostView(), nextActionAt: NOW + 50_000 }), { boost: true }),
  scenario('boost-waiting', 'Boost · waiting', park('session', 300, { boost: boostView({ state: 'waiting', effectiveFrom: NOW + 5 * HOUR }) }), { boost: true }),
  scenario('boost-paused', 'Boost · Epo stopped', day({ boost: boostView({ state: 'paused' }), runtime: { ...RUNTIME, desired: 'stopped' } }), { boost: true }),
];
