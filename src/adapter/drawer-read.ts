/**
 * The notifications drawer's per-body read (spec §10, C20): one pure function
 * the feed capture calls for every observed drawer body. It delegates to
 * today's extractors (lenient: a requests read is taken as the complete
 * pending list); the parse stream makes it strict and tiered in place.
 */

import type { Reader } from '@/adapter/reader';
import type { FollowEvent, Observation } from '@/adapter/surface-types';

export type DrawerBodyKind = 'activity-feed' | 'friend-requests';

/** One captured drawer body and which endpoint answered it. */
export interface DrawerBody {
  readonly kind: DrawerBodyKind;
  readonly body: unknown;
}

export interface DrawerReadCtx {
  readonly reader: Pick<Reader, 'parseActivityFeedStrict' | 'parsePendingRequests'>;
  /** The read's observation time (a requests row is stamped with it). */
  readonly now: number;
}

export interface DrawerRead {
  /** The feed's follow events; null for a requests body, or a feed body that did not parse. */
  readonly events: FollowEvent[] | null;
  /** The feed's side list of requesters (never complete; empty until the parse stream reads it). */
  readonly pendingPreview: Observation[];
  /** The requests panel's rows, and whether they are the whole pending list. */
  readonly requests: { readonly rows: Observation[]; readonly pendingComplete: boolean };
  readonly tier: 'canonical' | 'normalized' | 'recovered';
  readonly partial: boolean;
  readonly failure?: 'shape-mismatch';
}

/** Read one drawer body (Phase F: today's extractors, canonical and never partial). */
export function readDrawerBody(resp: DrawerBody, ctx: DrawerReadCtx): DrawerRead {
  if (resp.kind === 'activity-feed') {
    const events = ctx.reader.parseActivityFeedStrict(resp.body);
    return { events, pendingPreview: [], requests: { rows: [], pendingComplete: false }, tier: 'canonical',
      partial: false, ...(events === null ? { failure: 'shape-mismatch' } : {}) };
  }
  const parsed = ctx.reader.parsePendingRequests(resp.body, ctx.now);
  return { events: null, pendingPreview: [], requests: { rows: parsed.observations, pendingComplete: true },
    tier: 'canonical', partial: false };
}
