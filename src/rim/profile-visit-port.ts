/**
 * The profile-read PORT — what consumers (enricher, acquisition, seed check)
 * depend on. Kept import-light on purpose: the implementation
 * (`profile-visit.ts`, `profile-observer.ts`) needs the tab ports, which sit
 * inside the `src/types.ts` barrel's dependency cycle (the wave-B backlog);
 * depending on this module instead keeps a consumer out of that cycle.
 */

import type { ProfileViewer } from '@/adapter/ig-surface';
import type { Observation } from '@/store/types';
import type { ProfilePresence, Tier } from '@/surface/schema/projection';

/** One profile as the page's own client read it. */
export interface ProfileSeen {
  obs: Observation;
  /** Who follows whom, from the body's `friendship_status` (`null` flags when absent). */
  viewer: ProfileViewer;
  /** Which decision-bearing fields the body carried (absent on hand-built test values). */
  presence?: ProfilePresence;
  /** How the read was located, and whether it was complete. */
  tier?: Tier;
  partial?: boolean;
}

/** Whether the read behind a seen profile carried no valid count pair (I5); `false` when its presence is unknown. */
export const countsUnread = (seen: Pick<ProfileSeen, 'presence'>): boolean =>
  seen.presence !== undefined && seen.presence.counts !== 'read';

/** A profile visit's typed outcome (see `profile-visit.ts` for each kind). */
export type ProfileVisit =
  | ({ ok: true } & ProfileSeen)
  | { ok: false; kind: 'gone' | 'walled' | 'unanswered' | 'tab'; detail: Record<string, unknown> };

/** Reads a profile by VISITING it — composes no request. */
export interface ProfileVisitor {
  visit(username: string): Promise<ProfileVisit>;
}
