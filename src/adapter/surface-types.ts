/**
 * The adapter's stable result, locate and sentinel types: what every surface
 * version yields, with no dependency on the surface itself (no cycle).
 */

import type { Observation } from '@/store/types';
import type { Continuation } from '@/surface/schema/projection';

/** The store fact the extractors yield, named here for the surface interface. */
export type { Observation };

/** Sentinel classification of the tab / a response URL. */
export type SentinelStatus = 'ok' | 'action-blocked' | 'challenge' | 'logged-out';

/**
 * A labelled block/challenge/logged-out signature: each pattern carries the
 * status it maps to.
 */
export interface BlockSignature {
  pattern: RegExp;
  status: SentinelStatus;
}

/** The DOM contact points the Actor can find stale (for `AdapterStaleError`). */
export type StaleComponent =
  | 'action-button'
  | 'unfollow-confirm'
  | 'followers-stat'
  | 'following-stat'
  | 'notifications-link'
  | 'dialog';

/** One "started following you" event parsed from the activity feed. */
export interface FollowEvent {
  /** The follower's pk. */
  pk: string;
  /** The follower's username when the feed carries it. */
  username: string | null;
  /** Event time in epoch MS when the feed carries it (feeds report seconds). */
  atMs: number | null;
}

/** Result of parsing one paginated followers page. */
export interface FollowersListResult {
  observations: Observation[];
  /** Resume cursor for the next page; `null` when there is no next page (from `continuation`). */
  cursor: string | null;
  /** Whether more pages may exist: anything but an end (from `continuation`). */
  hasMore: boolean;
  /** What the page says about the rest of the list (spec §10.4). */
  continuation: Continuation;
  /** Rows on the page that did not read: counted, never silently dropped. */
  quarantined: number;
}

/**
 * One relationship row from the batched shape (carries no followed-by). Each flag is read by
 * presence: `null` means its key was absent (unknown), never `false` (spec §10.4).
 */
export interface ShowManyEntry {
  pk: string;
  following: boolean | null;
  /**
   * TRUE when we have a PENDING follow request to this (private) account.
   * `following` is FALSE while a request awaits acceptance, so "do we own this
   * relationship" is `following || outgoingRequest` — never `following` alone.
   */
  outgoingRequest: boolean | null;
  incomingRequest: boolean | null;
  isPrivate?: boolean;
}

/** A profile body's viewer-side flags (`friendship_status`), each `null` where the body is silent. */
export interface ProfileViewer {
  following: boolean | null;
  requested: boolean | null;
  followsUs: boolean | null;
  /** TRUE while THEIR follow request to us is open; absent or `null` = unknown. */
  incomingRequest?: boolean | null;
}

/** The single-relationship shape — both directions, each flag `null` where its key is absent. */
export interface FriendshipShowResult {
  pk: string;
  following: boolean | null;
  /** `followedBy` => THEY follow us (the follow-back signal). */
  followedBy: boolean | null;
  /** TRUE while our follow request to a private account awaits acceptance. */
  outgoingRequest: boolean | null;
  incomingRequest: boolean | null;
  isPrivate?: boolean;
}

// ---------------------------------------------------------------------------
// Locate-script results. A locate script searches for a control and returns its
// viewport bounding rect (getBoundingClientRect) WITHOUT clicking — the
// Interactor then performs the click/scroll with native input events.
// ---------------------------------------------------------------------------

/** A viewport bounding rect as the locate scripts report it (CSS px). */
export interface LocatedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Result of a plain locate script (confirm control, stat controls). */
export interface LocateRectResult {
  found: boolean;
  rect?: LocatedRect;
  /** The exposed part of `rect` when part of it is covered — where a press can land. */
  aim?: LocatedRect;
  /**
   * True when the control was found by a script's SELF-RECOVERY pass (a deep
   * text scan) after its primary role-marked search went blind — the control
   * was on screen, just not where the primary anchors expected. The Actor
   * warns on it: a persistent fallback is an early drift signal for the
   * primary anchors, caught while the operation still succeeds.
   */
  fallback?: boolean;
}

/** Locate result for the follow-requests Confirm control: rect + WHO it accepts. */
export interface LocateConfirmRequestResult {
  found: boolean;
  rect?: LocatedRect;
  /** Username parsed from the row's profile link; null when unresolvable. */
  username?: string | null;
  /** How many Confirm controls the panel currently shows (progress signal). */
  remaining?: number;
}

/** The action button's state + rect, plus whether the op would press it. */
export interface LocateActionResult {
  found: boolean;
  state?: 'follow' | 'follow-back' | 'following' | 'requested';
  /** Whether the op would click this button (the Interactor then performs it). */
  wouldClick?: boolean;
  needsConfirm?: boolean;
  rect?: LocatedRect;
}

/** A scroll container's rect + metrics (the Interactor wheels it). */
export interface LocateScrollResult {
  found: boolean;
  rect?: LocatedRect;
  scrollTop?: number;
  scrollHeight?: number;
  clientHeight?: number;
  /**
   * A viewport point inside the scroll container that is NOT over a username
   * link, avatar, or follow button (probed via `elementFromPoint`). Wheeling
   * here scrolls the LIST rather than triggering Instagram's hover-preview card,
   * which would otherwise overlay a row and swallow the wheel events. Absent
   * when no safe spot was found (a dense list) — the Interactor then falls back
   * to its default interior entry point.
   */
  safePoint?: { x: number; y: number };
}

/** Ids a surface can pull out of an endpoint URL (the bodies often carry none). */
export interface EndpointIds {
  /** Subject pk of a single-relationship URL. */
  pk?: string;
  /** Target pk of a followers-list URL. */
  targetPk?: string;
}
