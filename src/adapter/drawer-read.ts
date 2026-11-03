/**
 * The notifications drawer's per-body read (spec §10.4–10.5, C20), called by the feed capture for
 * every body, through the read pipeline. A wall is never drift; the follow-requests panel is read
 * strictly — its set is complete only when it read whole and the server said there is no next page.
 */

import type { Reader } from '@/adapter/reader';
import type { FollowEvent, Observation } from '@/adapter/surface-types';
import { admits } from '@/surface/read/admission';
import type { BodyInput } from '@/surface/read/types';
import type { Tier } from '@/surface/schema/projection';

export type DrawerBodyKind = 'activity-feed' | 'friend-requests';

/** One captured drawer body, which endpoint answered it, and (when captured) its status and media type. */
export interface DrawerBody {
  readonly kind: DrawerBodyKind;
  readonly body: unknown;
  readonly status?: number;
  readonly mime?: string;
}

export interface DrawerReadCtx {
  readonly reader: Pick<Reader, 'read'>;
  /** The read's observation time (requester rows are stamped with it). */
  readonly now: number;
}

/** Why a drawer body could not be read as data. */
export type DrawerFailure = 'shape-mismatch' | 'feed-walled' | 'requests-walled' | 'requests-unreadable';

export interface DrawerRead {
  /** The feed's follow events; null for a requests body, or a feed body that did not read. */
  readonly events: FollowEvent[] | null;
  /** The feed's side list of requesters, read row by row (never a complete set). */
  readonly pendingPreview: Observation[];
  /** The requests panel's rows, and whether they are the whole pending list. */
  readonly requests: { readonly rows: Observation[]; readonly pendingComplete: boolean };
  readonly tier: Tier;
  readonly partial: boolean;
  readonly failure?: DrawerFailure;
}

/** A captured body as the read pipeline's input: text decodes there, a parsed object is already decoded. */
function inputOf(resp: DrawerBody): BodyInput {
  const gate = resp.status === undefined || resp.mime === undefined ? {} : { status: resp.status, mime: resp.mime };
  return typeof resp.body === 'string' ? { text: resp.body, ...gate }
    : { decoded: { ok: true, json: resp.body, format: 'json', payloads: 1, final: null }, ...gate };
}

/** Read one drawer body. */
export function readDrawerBody(resp: DrawerBody, ctx: DrawerReadCtx): DrawerRead {
  const none = { rows: [], pendingComplete: false };
  const feed = resp.kind === 'activity-feed';
  const failed = (failure: DrawerFailure): DrawerRead =>
    ({ events: null, pendingPreview: [], requests: none, tier: 'canonical', partial: false, failure });
  const read = ctx.reader.read(resp.kind, inputOf(resp), { at: ctx.now });
  if (!read.ok) {
    if (read.kind === 'wall') return failed(feed ? 'feed-walled' : 'requests-walled');
    return failed(feed ? 'shape-mismatch' : 'requests-unreadable');
  }
  const p = read.projection;
  // Follow events and the side list of requesters are additive: a partial read's still flow.
  if (feed) return { events: p.events, pendingPreview: p.pendingPreview, requests: none, tier: read.tier, partial: read.partial };
  // Complete only from a complete read with every row read and the server's own flags false.
  const pendingComplete = admits('destructive', read) && p.rowIssues.length === 0
    && p.continuation?.kind === 'end' && p.continuation.evidence === 'flags-false';
  return { events: null, pendingPreview: [], requests: { rows: p.facts, pendingComplete }, tier: read.tier, partial: read.partial };
}
