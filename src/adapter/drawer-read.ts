/**
 * The notifications drawer's per-body read (spec §10.4, C20), called by the feed capture for every
 * body. The follow-requests panel is read strictly: its set is complete only when it read whole and
 * the server said there is no next page. The feed's side list of requesters is presence only.
 */

import type { Reader } from '@/adapter/reader';
import type { FollowEvent, Observation } from '@/adapter/surface-types';
import { SURFACE_BOUNDS } from '@/kernel/surface-policy';
import { admits } from '@/surface/read/admission';
import type { Tier } from '@/surface/schema/projection';

export type DrawerBodyKind = 'activity-feed' | 'friend-requests';

/** One captured drawer body and which endpoint answered it. */
export interface DrawerBody {
  readonly kind: DrawerBodyKind;
  readonly body: unknown;
}

export interface DrawerReadCtx {
  readonly reader: Pick<Reader, 'parseActivityFeedStrict' | 'parseRequestsStrict' | 'feedPendingPreview'>;
  /** The read's observation time (requester rows are stamped with it). */
  readonly now: number;
}

/** Why a drawer body could not be read as data. */
export type DrawerFailure = 'shape-mismatch' | 'requests-unreadable';

export interface DrawerRead {
  /** The feed's follow events; null for a requests body, or a feed body that did not parse. */
  readonly events: FollowEvent[] | null;
  /** The feed's side list of requesters, read row by row (never a complete set). */
  readonly pendingPreview: Observation[];
  /** The requests panel's rows, and whether they are the whole pending list. */
  readonly requests: { readonly rows: Observation[]; readonly pendingComplete: boolean };
  readonly tier: Tier;
  readonly partial: boolean;
  readonly failure?: DrawerFailure;
}

/** The legacy extractors read the declared container, and never a partial body. */
const LEGACY_READ = { tier: 'canonical', partial: false } as const;

/** Read one drawer body. */
export function readDrawerBody(resp: DrawerBody, ctx: DrawerReadCtx): DrawerRead {
  const none = { rows: [], pendingComplete: false };
  if (resp.kind === 'activity-feed') {
    const events = ctx.reader.parseActivityFeedStrict(resp.body);
    const pendingPreview = events === null ? [] : ctx.reader.feedPendingPreview(resp.body, ctx.now);
    return { events, pendingPreview, requests: none, ...LEGACY_READ, ...(events === null ? { failure: 'shape-mismatch' } : {}) };
  }
  const page = ctx.reader.parseRequestsStrict(resp.body, ctx.now);
  if (page === null) return { events: null, pendingPreview: [], requests: none, ...LEGACY_READ, failure: 'requests-unreadable' };
  // A panel whose rows mostly fail to read is drift; its readable rows are still facts.
  const total = page.observations.length + page.quarantined;
  const unreadable = page.observations.length < SURFACE_BOUNDS.rowMajority * total;
  // Complete only when every row read and the server's own flags said there is no next page.
  const pendingComplete = admits('destructive', LEGACY_READ) && !unreadable && page.quarantined === 0
    && page.continuation.kind === 'end' && page.continuation.evidence === 'flags-false';
  return { events: null, pendingPreview: [], requests: { rows: page.observations, pendingComplete }, ...LEGACY_READ,
    ...(unreadable ? { failure: 'requests-unreadable' } : {}) };
}
