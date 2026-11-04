/**
 * The notifications drawer's response capture (spec §9.4, C20): subscribed before any click, it reads
 * every observed drawer body through the parse stream's `readDrawerBody` and hands each one to the
 * pass as it parses (facts stream), counting what arrived so the pass can tell a post-chip body.
 */

import { type DrawerRead, readDrawerBody } from '@/adapter/drawer-read';
import type { Reader } from '@/adapter/reader';
import type { FollowEvent, Observation } from '@/adapter/surface-types';
import type { RimTab } from '@/rim/types';
import * as logger from '@/utils/logger';

/** What the pass does with each body, the moment it parses. */
export interface CaptureHandlers {
  /** One well-formed feed body: its follow events and its requester preview. */
  onFeed(events: readonly FollowEvent[], preview: readonly Observation[]): void;
  /** One follow-requests panel body: its readable rows and whether they are the whole pending list. */
  onRequests(rows: readonly Observation[], complete: boolean): void;
}

/** What the capture observed so far (object properties, so callback writes stay visible to the waits). */
export interface CaptureState {
  /** A feed response arrived (read or not). */
  sawFeed: boolean;
  /** Well-formed feed bodies read so far. */
  feedBodies: number;
  /** A feed body arrived but did not read as the feed's shape. */
  feedDrift: boolean;
  /** A feed body was a wall (a throttle or interstitial), never drift. */
  feedWalled: boolean;
  /** Follow-requests panel bodies read so far (strict). */
  requestBodies: number;
  /** The panel came back walled or mostly unreadable. */
  requestsFailure: Extract<DrawerRead['failure'], 'requests-walled' | 'requests-unreadable'> | null;
}

/** A live capture: its state, the in-flight body reads, its unsubscribe. */
export interface FeedCapture {
  readonly state: CaptureState;
  readonly pendingReads: Promise<void>[];
  readonly unsubscribe: ReturnType<RimTab['onResponse']>;
}

/** Subscribe before the first click, so a fast response never beats the handler. */
export function captureFeed(deps: { tab: RimTab; reader: Reader; now: () => number }, h: CaptureHandlers): FeedCapture {
  const state: CaptureState = { sawFeed: false, feedBodies: 0, feedDrift: false, feedWalled: false,
    requestBodies: 0, requestsFailure: null };
  const pendingReads: Promise<void>[] = [];
  const unsubscribe = deps.tab.onResponse((resp) => {
    const kind = deps.reader.kindOf(resp); // URL + operation name: the drawer reads via GraphQL
    if (kind !== 'activity-feed' && kind !== 'friend-requests') return;
    if (kind === 'activity-feed') state.sawFeed = true;
    pendingReads.push(resp.getBody().then((body) => {
      const read = readDrawerBody({ kind, body, status: resp.status, mime: resp.mimeType },
        { reader: deps.reader, now: deps.now() });
      if (kind === 'activity-feed') {
        if (read.failure === 'feed-walled') state.feedWalled = true;
        else if (read.events === null) state.feedDrift = true;
        else {
          state.feedBodies += 1;
          h.onFeed(read.events, read.pendingPreview);
        }
        return;
      }
      if (read.failure === 'requests-walled') {
        state.requestsFailure = read.failure;
        return;
      }
      if (read.failure === 'requests-unreadable') state.requestsFailure = read.failure;
      state.requestBodies += 1;
      // A panel whose rows mostly fail to read is drift; its readable rows are still facts.
      h.onRequests(read.requests.rows, read.requests.pendingComplete);
    }).catch((e: unknown) => {
      logger.warn('rim.follow-notifications: response body read failed', { kind, error: String(e) });
    }));
  });
  return { state, pendingReads, unsubscribe };
}

/** Poll until `done` or the deadline, flushing body reads (interruptible by a stop()). */
export async function awaitCaptured(done: () => boolean, pendingReads: Promise<void>[], o: {
  signal: AbortSignal | undefined; deadline: number; now: () => number; pollMs: number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}): Promise<void> {
  await Promise.all(pendingReads.splice(0));
  while (!done() && o.now() < o.deadline) {
    if (o.signal?.aborted) return;
    await o.sleep(o.pollMs, o.signal);
    await Promise.all(pendingReads.splice(0));
  }
}
