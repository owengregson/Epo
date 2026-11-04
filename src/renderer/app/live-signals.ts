import { signal } from '@preact/signals';
import type { ComponentChildren } from 'preact';
import type { Res } from '@/ipc/contract';
import type { FeedView } from '@/shared/feed';
import type { LiveTab } from '@/shared/live-op';

/**
 * The shell's live projections beyond status (ADR 1004, spec §12.9): each is
 * subscribed ONCE, by `useLiveFeeds` at shell level, and fetched before the app
 * is revealed, so a page that mounts later renders from data already here. Null
 * means "not known yet" — never an empty list standing in for one.
 */

/** The chain lineage (`chain:list`), owned once for every reader. */
export type ChainList = Res<'chainList'>;

/** The growth read for the default chart window. */
export type GrowthSeries = Res<'growthSeries'>;

/** One lane's first page of rows. */
export type LaneRows = Res<'queueList'>;

/** The People page's lanes, each with its first page, preloaded at shell level. */
export interface QueueLanes {
  readonly next: LaneRows;
  readonly waiting: LaneRows;
  readonly back: LaneRows;
  readonly leaving: LaneRows;
  readonly kept: Res<'keptList'>;
}

/** The typed live feed (pushed on store mutation, deduplicated in main). */
export const feedSignal = signal<FeedView | null>(null);
/** What Epo does on the Instagram page right now (pushed, null-held in main). */
export const activitySignal = signal<LiveTab | null>(null);
export const chainListSignal = signal<ChainList | null>(null);
/** The first stored graph read settled, either with data or a visible unavailable state. */
export const graphPreloadedSignal = signal(false);
export const growthSeriesSignal = signal<GrowthSeries | null>(null);
export const queueLanesSignal = signal<QueueLanes | null>(null);
/** The control the user just pressed, until its call settles (a posture input). */
export const pendingControlSignal = signal<'start' | 'pause' | 'stop' | null>(null);

/**
 * Whether the Live stage may show Instagram. True unless a boot gate holds it:
 * the gate sets it false before the first render and true at its reveal, so the
 * stage request stays covered until then (spec §12.8).
 */
export const liveRevealedSignal = signal(true);

/** What the Live stage shows under the Instagram page before it is revealed (a boot placeholder). */
export const liveSlotSignal = signal<ComponentChildren>(null);

/** Back to the pre-boot state; called by `resetShellSignals()` between test renders. */
export function resetLiveSignals(): void {
  feedSignal.value = null;
  activitySignal.value = null;
  chainListSignal.value = null;
  growthSeriesSignal.value = null;
  graphPreloadedSignal.value = false;
  queueLanesSignal.value = null;
  pendingControlSignal.value = null;
  liveRevealedSignal.value = true;
  liveSlotSignal.value = null;
}
