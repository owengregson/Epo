/**
 * The Reader's shadow comparisons (spec §10.3). Before an endpoint's flip the document reads every
 * body beside the legacy extractor; after it the legacy extractors (`versions/2026-08-12.extractors.ts`)
 * run only here, as comparators. Every projected field is compared; a disagreement on a clean
 * canonical read is reported as `shadow-disagreed`. Plus the body helpers the legacy parses share.
 */

import { type EndpointKind, isShapeMismatch, SURFACE } from '@/adapter/ig-surface';
import { readBody } from '@/surface/read/read';
import type { ReadCtx, ReadEnv, SurfaceRead } from '@/surface/read/types';
import { type Comparable, comparableOf, diffProjections, reportShadow } from '@/surface/shadow';
import { type Decoded, decodeBody } from '@/surface/transport/decode';
import * as logger from '@/utils/logger';

/**
 * Accept either an already-parsed object or the raw text `TabResponse.getBody()` yields, decoded
 * through the declared transport (a JSON guard, streamed or multipart payloads). An undecodable
 * body is logged and reads as no-match; so does a stream that says it is not final.
 */
export function coerceBody(body: unknown, kind: EndpointKind): unknown {
  if (typeof body !== 'string') return body;
  const decoded = decodeBody(body, SURFACE.transport);
  if (!decoded.ok) {
    logger.warn('reader.parse: body did not decode', { kind, reason: decoded.reason, head: decoded.head });
    return undefined;
  }
  if (decoded.final === false) {
    // A partial body may carry positive facts, but every legacy read here can also claim an absence.
    logger.warn('reader.parse: incomplete stream, not read', { kind, format: decoded.format });
    return undefined;
  }
  return decoded.json;
}

/** Warn on a body no extractor recognized, naming the DECODED body's top-level keys (never values). */
export function warnUnexpected(kind: EndpointKind, body: unknown): void {
  const json = typeof body === 'string' ? coerceBody(body, kind) : body;
  const keys = typeof json === 'object' && json !== null ? Object.keys(json as object) : [];
  logger.warn('reader.parse: unexpected body shape', { kind, keys });
}

/** A body as the read pipeline's input: text decodes there, a parsed object is already decoded. */
export function inputOf(body: unknown, final: boolean | null = null): { decoded: Decoded } | { text: string } {
  return typeof body === 'string' ? { text: body } : { decoded: { ok: true, json: body, format: 'json', payloads: 1, final } };
}

const NONE: Comparable = { facts: [], relationships: [], events: [], cursor: null, hasMore: false, absent: null };

/** The legacy extractors' answer for one decoded body, as a comparable; `null` when they did not read it. */
export function legacyComparable(kind: EndpointKind, json: unknown, ctx: { at: number; pk?: string; viewerPk?: string | null }):
  Comparable | null {
  switch (kind) {
    case 'followers-list': case 'following-list': case 'friend-requests': {
      const r = SURFACE.extractFollowersList(json, ctx.at, kind, null);
      return isShapeMismatch(r) ? null
        : { ...NONE, facts: r.observations, cursor: r.cursor, hasMore: r.hasMore, continuation: r.continuation, rows: r.quarantined };
    }
    case 'show-many': {
      const r = SURFACE.extractShowMany(json);
      return isShapeMismatch(r) ? null : { ...NONE, relationships: r.map((e) => ({ ...e, followedBy: null })) };
    }
    case 'friendship-show': {
      const r = ctx.pk === undefined ? null : SURFACE.extractFriendshipShow(json, ctx.pk);
      return r === null || isShapeMismatch(r) ? null : { ...NONE, relationships: [r] };
    }
    case 'profile-info': case 'profile-graphql': {
      const obs = SURFACE.extractProfileInfo(json, ctx.at);
      if (isShapeMismatch(obs)) return null;
      if (obs === null) return { ...NONE, absent: true };
      const v = SURFACE.extractProfileViewer(json);
      const fs = [v.following, v.requested, v.followsUs, v.incomingRequest ?? null].some((f) => f !== null);
      const presence = SURFACE.extractProfilePresence(json, ctx.viewerPk ?? null) ?? undefined;
      const relationships = fs ? [{ pk: obs.accountPk, following: v.following, outgoingRequest: v.requested, followedBy: v.followsUs,
        incomingRequest: v.incomingRequest ?? null, isPrivate: obs.fields.isPrivate }] : [];
      return { ...NONE, facts: [obs], absent: false, relationships, ...(presence === undefined ? {} : { presence }) };
    }
    case 'activity-feed': {
      const r = SURFACE.extractActivityFeed(json);
      return isShapeMismatch(r) ? null : { ...NONE, events: r, pendingPreview: SURFACE.extractFeedPendingPreview(json, ctx.at) };
    }
  }
}

/** A read the comparison stands on: canonical, complete, with every field read. */
const clean = (read: SurfaceRead): boolean =>
  read.ok && read.tier === 'canonical' && !read.partial && read.projection.fieldIssues.length === 0;

/** Failures the legacy path never sees (it reads only the bodies the gate let through). */
const gated = (read: SurfaceRead): boolean => !read.ok && (read.kind === 'wall' || read.kind === 'http-absent'
  || read.kind === 'not-data' || read.kind === 'transport');

/**
 * Before the flip: the document reads the same body (reporting to the sink) and is compared with the
 * legacy extractors' answer for `json` (the body as the legacy path decoded it; `undefined` when it did not).
 */
export function shadowDocument(env: ReadEnv, kind: EndpointKind, body: unknown, ctx: ReadCtx & { final?: boolean | null },
  json: unknown): SurfaceRead {
  const read = readBody(kind, inputOf(body, ctx.final ?? null), ctx, env);
  if (gated(read)) return read;
  const viewerPk = read.ok ? read.projection.viewerPk : null;
  const legacy = json === undefined ? null : legacyComparable(kind, json, { at: ctx.at, pk: ctx.pk, viewerPk });
  const doc = comparableOf(read);
  if (doc === null || legacy === null) {
    if ((doc === null) !== (legacy === null) && (doc === null || clean(read))) reportShadow(env.sink, read, ['(read)'], ctx.at);
    return read;
  }
  if (clean(read)) reportShadow(env.sink, read, diffProjections(doc, legacy), ctx.at);
  return read;
}

/** After the flip: the legacy extractors read the document's clean canonical bodies, and any disagreement is reported. */
export function shadowLegacy(env: ReadEnv, read: SurfaceRead, json: unknown, ctx: ReadCtx): void {
  if (!read.ok || !clean(read)) return;
  const legacy = legacyComparable(read.endpoint, json, { at: ctx.at, pk: ctx.pk, viewerPk: read.projection.viewerPk });
  const doc = comparableOf(read);
  if (doc !== null) reportShadow(env.sink, read, legacy === null ? ['(read)'] : diffProjections(doc, legacy), ctx.at);
}
