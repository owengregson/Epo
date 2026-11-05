/**
 * The notifications source's port (spec §9.4, Appendix E): the pass options and typed result the
 * frontier sweep consumes, and the slice of the Actor the drawer pass drives.
 */

import type { LocateConfirmRequestResult } from '@/adapter/ig-surface';
import type { FollowEvent, Observation } from '@/adapter/surface-types';
import type { FeedWatermark } from '@/rim/feed-watermark';

/** One follow request a pass ACCEPTED (they follow us from `at`). */
export interface AcceptedFollowRequest {
  /** Resolved from the panel rows / store; null when unresolvable. */
  pk: string | null;
  username: string;
}

/** One requester row, from the feed's preview or the requests panel. */
export interface FeedRequester { readonly pk: string; readonly username: string; readonly observation: Observation }

export type FeedFailure = 'read-budget' | `sentinel:${string}` | 'control-not-located' | 'no-response'
  | 'body-unreadable' | 'feed-shape-drift' | 'walled' | 'aborted';

/** The requests panel's errand: accept up to `allowed`, read it to verify, or leave it closed. */
export type FeedPanel = { readonly mode: 'accept'; readonly allowed: number } | { readonly mode: 'verify' } | null;

export interface FeedPassOptions {
  readonly use: 'catch-up' | 'check';
  readonly signal: AbortSignal;
  readonly panel: FeedPanel;
  /** Fresh dated events, per event, as each body parses. */
  onEvent(e: FollowEvent): void;
  onUndated(e: FollowEvent): void;
  /** Requester rows, per row. */
  onRequester(r: FeedRequester): void;
  /** Each accept, once its click registered. */
  onAccepted?(a: AcceptedFollowRequest & { readonly at: number }): void;
}

export type FeedReadResult =
  | { readonly ok: true; readonly next: FeedWatermark; readonly bodies: number; readonly filtered: boolean;
      readonly fresh: number; readonly accepted: number;
      readonly requesters: { readonly count: number; readonly source: 'sibling' | 'panel' | 'none'; readonly complete: boolean } }
  /** `opened`: the drawer was opened, so the pass's read time is stamped while its watermark is kept. */
  | { readonly ok: false; readonly reason: FeedFailure; readonly retryAt?: number; readonly opened: boolean };

/** The sweep's notifications source (tests inject a scripted fake). */
export interface FeedSource {
  fetchSince(w: FeedWatermark | null, o: FeedPassOptions): Promise<FeedReadResult>;
}

/** The slice of the Actor this source drives. */
export interface NotificationsActor {
  clickNotifications(): Promise<boolean>;
  /** Soft niceties inside the open drawer — a `false` result is never fatal. */
  clickNotificationsFollowsFilter(): Promise<boolean>;
  clickNotificationsClose(): Promise<boolean>;
  scrollNotificationsList(): Promise<boolean>;
  clickFollowRequestsEntry(): Promise<boolean>;
  confirmNextFollowRequest(onDispatch?: (username: string | null) => void | Promise<void>): Promise<{
    clicked: boolean;
    username: string | null;
    remaining: number;
  }>;
  /** Read the requests panel's head WITHOUT clicking — the accept-progress probe. */
  probeFollowRequestHead(): Promise<LocateConfirmRequestResult>;
}
