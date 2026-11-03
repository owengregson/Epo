/**
 * The notifications drawer's per-body read (spec §10.4–10.5, C20), called by the feed capture for
 * every body. A wall is never drift; the follow-requests panel is read strictly — its set is
 * complete only when it read whole and the server said there is no next page.
 */

import { SURFACE } from '@/adapter/ig-surface';
import type { Reader } from '@/adapter/reader';
import type { FollowEvent, Observation } from '@/adapter/surface-types';
import { SURFACE_BOUNDS } from '@/kernel/surface-policy';
import { admits } from '@/surface/read/admission';
import { gateObserved } from '@/surface/read/gate';
import type { BodyInput } from '@/surface/read/types';
import type { Tier } from '@/surface/schema/projection';
import { decodeBody } from '@/surface/transport/decode';
import { graphqlEnvelope } from '@/surface/transport/graphql';

export type DrawerBodyKind = 'activity-feed' | 'friend-requests';

/** One captured drawer body, which endpoint answered it, and (when captured) its status and media type. */
export interface DrawerBody {
  readonly kind: DrawerBodyKind;
  readonly body: unknown;
  readonly status?: number;
  readonly mime?: string;
}

export interface DrawerReadCtx {
  readonly reader: Pick<Reader, 'read' | 'parseRequestsStrict'>;
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

/** Whether the observed gate names a wall (only when the capture recorded status and media type). */
function gatedWall(resp: DrawerBody): boolean {
  if (resp.status === undefined || resp.mime === undefined) return false;
  const head = typeof resp.body === 'string' ? resp.body.slice(0, SURFACE_BOUNDS.logHeadChars) : undefined;
  return gateObserved(resp.status, resp.mime, SURFACE.transport.parseableMime, head).kind === 'wall';
}

/** The body's GraphQL envelope: a wall, errors to wait out, partial data, or plain data. */
function envelopeOf(resp: DrawerBody, read: boolean) {
  const decoded = typeof resp.body === 'string' ? decodeBody(resp.body, SURFACE.transport) : null;
  const json = decoded === null ? resp.body : decoded.ok ? decoded.json : undefined;
  return graphqlEnvelope(json, () => read, SURFACE.graphql, SURFACE.mutationRefusalSignatures);
}

/** Read one drawer body. */
export function readDrawerBody(resp: DrawerBody, ctx: DrawerReadCtx): DrawerRead {
  const none = { rows: [], pendingComplete: false };
  const wall: DrawerFailure = resp.kind === 'activity-feed' ? 'feed-walled' : 'requests-walled';
  const failed = (failure: DrawerFailure): DrawerRead =>
    ({ events: null, pendingPreview: [], requests: none, tier: 'canonical', partial: false, failure });
  if (resp.kind === 'activity-feed') {
    const read = ctx.reader.read('activity-feed', inputOf(resp), { at: ctx.now });
    if (!read.ok) return failed(read.kind === 'wall' ? wall : 'shape-mismatch');
    // Follow events and the side list of requesters are additive: a partial read's still flow.
    const p = read.projection;
    return { events: p.events, pendingPreview: p.pendingPreview, requests: none, tier: read.tier, partial: read.partial };
  }
  if (gatedWall(resp)) return failed(wall);
  const page = ctx.reader.parseRequestsStrict(resp.body, ctx.now);
  const envelope = envelopeOf(resp, page !== null);
  if (envelope.kind === 'wall' || envelope.kind === 'error') return failed(wall);
  if (page === null) return failed('requests-unreadable');
  const read = { tier: 'canonical', partial: envelope.kind === 'data' && envelope.errors > 0 } as const;
  // A panel whose rows mostly fail to read is drift; its readable rows are still facts.
  const total = page.observations.length + page.quarantined;
  const unreadable = page.observations.length < SURFACE_BOUNDS.rowMajority * total;
  // Complete only from a complete read with every row read and the server's own flags false.
  const pendingComplete = admits('destructive', read) && !unreadable && page.quarantined === 0
    && page.continuation.kind === 'end' && page.continuation.evidence === 'flags-false';
  return { events: null, pendingPreview: [], requests: { rows: page.observations, pendingComplete }, ...read,
    ...(unreadable ? { failure: 'requests-unreadable' } : {}) };
}
