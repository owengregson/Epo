import { effect } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import type { Push, PushMethod } from '@/ipc/contract';
import {
  activitySignal,
  chainListSignal,
  feedSignal,
  growthSeriesSignal,
  type QueueLanes,
  queueLanesSignal,
} from '@/renderer/app/live-signals';
import { settingsFactsSignal, settingsViewSignal, statusSignal } from '@/renderer/app/shell-context';
import { LANE_STATE } from '@/renderer/cards/queues/lanes';
import { DEFAULT_GROWTH_WINDOW, windowDays } from '@/renderer/charts/growth-window';
import { chainListKey } from '@/renderer/hooks/chain-list-key';
import { useKeepAlivePoll } from '@/renderer/hooks/useKeepAlivePoll';

/** A pushed channel as a keep-alive subscription. */
function pushes<C extends PushMethod>(channel: C): (apply: (v: Push<C>) => void) => () => void {
  return (apply) => {
    const on = (v: Push<C>): void => apply(v);
    window.epo.on(channel, on);
    return () => window.epo.off(channel, on);
  };
}

/**
 * Main logs a failing handler and answers its typed fallback, so a rejected
 * invoke means the bridge itself went away: the signal keeps what it had.
 */
const keepLast = (): void => undefined;

/** The first page of every lane, in one round (`queue:list` × 4 and the kept table). */
export async function loadLanes(): Promise<QueueLanes> {
  const [next, waiting, back, leaving, kept] = await Promise.all([
    window.epo.queueList(LANE_STATE.next),
    window.epo.queueList(LANE_STATE.waiting),
    window.epo.queueList(LANE_STATE.back),
    window.epo.queueList(LANE_STATE.leaving),
    window.epo.keptList(0),
  ]);
  return { next, waiting, back, leaving, kept };
}

/** A status push that reports a lifecycle move re-pulls the chain (the push stays primary). */
function chainBackstop(): () => void {
  let last: string | null = null;
  return effect(() => {
    const key = chainListKey(statusSignal.value);
    const first = last === null;
    if (key === last) return;
    last = key;
    if (first) return;
    window.epo.chainList().then((list) => {
      chainListSignal.value = list;
    }, keepLast);
  });
}

/** The People page's data, fetched before the reveal so the page renders at once when opened. */
function preloadPeople(): () => void {
  let alive = true;
  window.epo.growthSeries(windowDays(DEFAULT_GROWTH_WINDOW, null, Date.now())).then((g) => {
    if (alive) growthSeriesSignal.value = g;
  }, keepLast);
  loadLanes().then((lanes) => {
    if (alive) queueLanesSignal.value = lanes;
  }, keepLast);
  return () => {
    alive = false;
  };
}

/**
 * The shell's live subscriptions beyond status (docs/PRINCIPLES.md §2): push
 * first, one pull at mount, a keep-alive pull when a channel goes quiet. Called
 * once, by the shell, so every channel has exactly one listener; nothing here
 * reads a signal during render, so a push never re-renders the shell.
 */
export function useLiveFeeds(): void {
  useKeepAlivePoll({ subscribe: pushes('feed'), pull: () => window.epo.feedView(), sink: feedSignal });
  useKeepAlivePoll({ subscribe: pushes('activity'), pull: () => window.epo.activityNow(), sink: activitySignal });
  useKeepAlivePoll({ subscribe: pushes('chainList'), pull: () => window.epo.chainList(), sink: chainListSignal });
  useKeepAlivePoll({ subscribe: pushes('settings'), pull: () => window.epo.settingsView(), sink: settingsViewSignal });
  useKeepAlivePoll({
    subscribe: pushes('settingsFacts'),
    pull: () => window.epo.settingsFacts(),
    sink: settingsFactsSignal,
  });
  useEffect(chainBackstop, []);
  useEffect(preloadPeople, []);
}
