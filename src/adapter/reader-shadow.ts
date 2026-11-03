/**
 * The reverse shadow (spec §10.3): the surface document drives every endpoint, and the legacy
 * extractors (`versions/2026-08-12.extractors.ts`) run only here, as comparators of the clean
 * canonical reads. Every projected field is compared; a disagreement is reported as `shadow-disagreed`.
 */

import { type EndpointKind, isShapeMismatch, SURFACE } from '@/adapter/ig-surface';
import type { ReadCtx, ReadEnv, SurfaceRead } from '@/surface/read/types';
import { type Comparable, comparableOf, diffProjections, reportShadow } from '@/surface/shadow';

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

/** A read the comparison stands on: canonical, complete, every field and row read (anything else differs by intent). */
const clean = (read: SurfaceRead): boolean => read.ok && read.tier === 'canonical' && !read.partial
  && read.projection.fieldIssues.length === 0 && read.projection.rowIssues.length === 0;

/** The legacy extractors read the document's clean canonical bodies, and any disagreement is reported. */
export function shadowLegacy(env: ReadEnv, read: SurfaceRead, json: unknown, ctx: ReadCtx): void {
  if (!read.ok || !clean(read)) return;
  const legacy = legacyComparable(read.endpoint, json, { at: ctx.at, pk: ctx.pk, viewerPk: read.projection.viewerPk });
  const doc = comparableOf(read);
  if (doc !== null) reportShadow(env.sink, read, legacy === null ? ['(read)'] : diffProjections(doc, legacy), ctx.at);
}
