/**
 * The notifications drawer's watermark (spec §9.4, law L9), pure: which events of a body are fresh
 * against the last pass, whether a pass reached it, and the next watermark once the events are written.
 */

import type { FollowEvent } from '@/adapter/surface-types';
import type { FeedWatermark } from '@/store/repos/reopen-state';

export type { FeedWatermark };

/** An event's identity within a pass and across passes: the follower and the server time. */
export function eventKey(e: Pick<FollowEvent, 'pk' | 'atMs'>): string {
  return `${e.pk}|${e.atMs ?? ''}`;
}

/** The server time an event carries, or null when it carries none or one later than the local clock allows. */
export function datedAtMs(e: Pick<FollowEvent, 'atMs'>, now: number, toleranceMs: number): number | null {
  return e.atMs !== null && Number.isFinite(e.atMs) && e.atMs <= now + toleranceMs ? e.atMs : null;
}

/** Whether a dated event lies beyond the watermark: later, or at its instant with an unseen key. */
export function isFresh(e: FollowEvent, atMs: number, w: FeedWatermark | null): boolean {
  if (w === null || atMs > w.atMs) return true;
  return atMs === w.atMs && !w.keysAtMs.includes(eventKey(e));
}

export interface BodyClass {
  readonly fresh: FollowEvent[];
  readonly undated: FollowEvent[];
  /** The oldest and newest server times the body carried (fresh or not). */
  readonly oldestAtMs: number | null;
  readonly newestAtMs: number | null;
}

/** Split one body's events: fresh dated ones, undated ones; events at or below the watermark drop out. */
export function classifyBody(events: readonly FollowEvent[], w: FeedWatermark | null, now: number,
  toleranceMs: number): BodyClass {
  const fresh: FollowEvent[] = [];
  const undated: FollowEvent[] = [];
  let oldestAtMs: number | null = null;
  let newestAtMs: number | null = null;
  for (const e of events) {
    const at = datedAtMs(e, now, toleranceMs);
    if (at === null) {
      undated.push(e);
      continue;
    }
    oldestAtMs = oldestAtMs === null ? at : Math.min(oldestAtMs, at);
    newestAtMs = newestAtMs === null ? at : Math.max(newestAtMs, at);
    if (isFresh(e, at, w)) fresh.push(e);
  }
  return { fresh, undated, oldestAtMs, newestAtMs };
}

/** Whether the merged bodies reach the watermark: nothing to reach, nothing dated, or an event at or below it. */
export function reached(w: FeedWatermark | null, oldestAtMs: number | null): boolean {
  return w === null || oldestAtMs === null || oldestAtMs <= w.atMs;
}

/** The span a pass left unread between the watermark and the oldest event it reached, or null. */
export function gapOf(w: FeedWatermark | null, oldestAtMs: number | null): FeedWatermark['gap'] {
  if (w === null || oldestAtMs === null || reached(w, oldestAtMs)) return null;
  return { fromAtMs: w.atMs, toAtMs: oldestAtMs };
}

/**
 * The watermark after a pass whose events are written: the newest server time seen and its keys,
 * the pass's read time, the filtered stamp, and the gap merged with any older one the head walk owes.
 */
export function advanceWatermark(w: FeedWatermark | null, seen: readonly FollowEvent[], readAt: number,
  filtered: boolean, gap: FeedWatermark['gap']): FeedWatermark {
  let atMs = w?.atMs ?? 0;
  for (const e of seen) if (e.atMs !== null && Number.isFinite(e.atMs) && e.atMs > atMs) atMs = e.atMs;
  const keys = new Set(w !== null && w.atMs === atMs ? w.keysAtMs : []);
  for (const e of seen) if (e.atMs === atMs) keys.add(eventKey(e));
  const older = w?.gap ?? null;
  const merged = older === null ? gap : gap === null ? older
    : { fromAtMs: Math.min(older.fromAtMs, gap.fromAtMs), toAtMs: Math.max(older.toAtMs, gap.toAtMs) };
  return { atMs, keysAtMs: [...keys].sort(), readAt, filteredAt: filtered ? readAt : w?.filteredAt ?? null, gap: merged };
}
