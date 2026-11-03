/**
 * The notifications drawer's response capture: subscribed before any click, it
 * merges every observed feed page and stores each pending-request row as it parses.
 */

import { readDrawerBody } from '@/adapter/drawer-read';
import type { FollowEvent, Reader } from '@/adapter/reader';
import type { RimTab } from '@/rim/types';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { RIM } from '@/timing/config';
import * as logger from '@/utils/logger';

/** What the capture has observed (object properties, so callback writes stay visible to CFA). */
export interface FeedCaptured {
  /** Accumulated follow events across ALL observed WELL-FORMED feed pages (deduped). */
  events: FollowEvent[] | null;
  sawInbox: boolean;
  /** A feed body arrived but shape-mismatched (IG drift / fail interstitial). */
  feedDrift: boolean;
  /** username(lower) → pk from the observed pending-requests rows. */
  pendingPks: Map<string, string> | null;
}

/** A live capture: its state, the event dedupe keys, the in-flight body reads, its unsubscribe. */
export interface FeedCapture {
  readonly captured: FeedCaptured;
  readonly seenEvents: Set<string>;
  readonly pendingReads: Promise<void>[];
  readonly unsubscribe: ReturnType<RimTab['onResponse']>;
}

/**
 * Capture the FIRST activity-feed response — and, when accepting, the
 * pending-requests response — that land after the clicks. Subscribing
 * BEFORE clicking closes the race where a fast response beats the handler.
 */
export function captureFeed(deps: {
  tab: RimTab;
  reader: Reader;
  store?: KnowledgeStore;
}): FeedCapture {
  const captured: FeedCaptured = { events: null, sawInbox: false, feedDrift: false, pendingPks: null };
  const seenEvents = new Set<string>();
  const pendingReads: Promise<void>[] = [];
  const unsubscribe = deps.tab.onResponse((resp) => {
    const kind = deps.reader.kindOf(resp); // URL + operation name: the drawer reads via GraphQL
    if (kind !== 'activity-feed' && kind !== 'friend-requests') return;
    if (kind === 'activity-feed') captured.sawInbox = true;
    pendingReads.push(
      resp
        .getBody()
        .then((body) => {
          if (kind === 'friend-requests' && captured.pendingPks !== null) return;
          const read = readDrawerBody({ kind, body }, { reader: deps.reader, now: Date.now() });
          if (kind === 'activity-feed') {
            // MERGE every observed feed page (the initial open, the Follows
            // filter refetch, scroll-loaded older pages) — deduped. STRICT
            // parse per page: a drifted body leaves `events` untouched (so
            // it can never read as a successful empty check) but flags the
            // drift; one well-formed page among drifted ones still succeeds.
            if (read.events === null) {
              captured.feedDrift = true;
              return;
            }
            const merged = captured.events ?? [];
            for (const e of read.events) {
              const key = `${e.pk}|${e.atMs ?? ''}`;
              if (seenEvents.has(key)) continue;
              seenEvents.add(key);
              merged.push(e);
            }
            captured.events = merged;
            return;
          }
          const map = new Map<string, string>();
          for (const obs of read.requests.rows) {
            // §1: every requester row is a fact — store it as it parses.
            deps.store?.observe(obs);
            if (typeof obs.fields.username === 'string') {
              map.set(obs.fields.username.toLowerCase(), obs.accountPk);
            }
          }
          captured.pendingPks = map;
        })
        .catch((e: unknown) => {
          logger.warn('rim.follow-notifications: response body read failed', {
            kind,
            error: String(e),
          });
        }),
    );
  });
  return { captured, seenEvents, pendingReads, unsubscribe };
}

/** Bounded poll for an observed response (interruptible by a stop()). */
export async function awaitCaptured(
  done: () => boolean,
  pendingReads: Promise<void>[],
  signal: AbortSignal | undefined,
  waitMs: number,
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
): Promise<void> {
  const deadline = Date.now() + waitMs;
  while (!done() && Date.now() < deadline) {
    if (signal?.aborted) return;
    await sleep(RIM.NOTIFICATIONS_POLL_MS, signal);
    await Promise.all(pendingReads.splice(0));
  }
}
