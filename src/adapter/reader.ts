/**
 * Instagram Adapter — Reader: the read pipeline over the bodies the tab already captured. It NEVER
 * touches the DOM and NEVER issues requests. `read()` is `readBody` (spec §10.2–10.3) with the
 * Reader's env (the document, the sink, the hint book); `observed` reads each observed response once.
 * The document drives every endpoint. Zero Instagram literals here: they live in `versions/*`.
 */

import { SURFACE } from '@/adapter/ig-surface';
import { ObservedReads, type ObservedReadsOpts } from '@/adapter/observed-reads';
import type { ProfileSeen } from '@/rim/profile-visit-port';
import type { ObservedRelation } from '@/shared/observed-relation';
import { admits } from '@/surface/read/admission';
import { defaultEnv, readBody } from '@/surface/read/read';
import { recoverBody } from '@/surface/read/recover';
import { mintObserved } from '@/surface/read/relationship';
import { type ObservedRequest, routeObserved } from '@/surface/read/route';
import type { BodyInput, ReadCtx, ReadEnv, RouteMatch, SurfaceRead } from '@/surface/read/types';
import type { DriftSignal } from '@/surface/sink';
import { type Decoded, decodeBody } from '@/surface/transport/decode';

export type { EndpointKind, FollowEvent } from '@/adapter/ig-surface';

import type { EndpointKind, ProfileViewer } from '@/adapter/ig-surface';

/** Which profile body a parse is reading — the two containers differ. */
export type ProfileKind = Extract<EndpointKind, 'profile-info' | 'profile-graphql'>;

/** A viewer whose every flag is unknown (a recovered or partial read withholds them all). */
const UNKNOWN_VIEWER: ProfileViewer = { following: null, requested: null, followsUs: null, incomingRequest: null };

export class Reader {
  readonly env: ReadEnv;
  /** Every observed response read once, shared by every consumer of this Reader. */
  readonly observed: ObservedReads;
  /** Our own pk, when the session names it: our own header counts are gated on it. */
  readonly ownPk: string | null;

  /** `session` names whose session observes (I10) and the observation clock. */
  constructor(env: Partial<ReadEnv> = {}, session: ObservedReadsOpts = {}) {
    this.env = { ...defaultEnv(), ...env };
    this.observed = new ObservedReads(this, session);
    this.ownPk = session.viewerPk ?? null;
  }

  /** Route an observed request through the one routing table, or `null`. */
  route(req: ObservedRequest): RouteMatch | null {
    return routeObserved(req, { doc: this.env.doc, transport: this.env.doc.read.transport, hints: this.env.hints });
  }

  /** Route a response URL (and the operation name it carried) to its endpoint kind, or `null`. */
  matchEndpoint(url: string, friendlyName?: string): EndpointKind | null {
    return SURFACE.matchEndpoint(url, friendlyName);
  }

  /** The endpoint kind of an OBSERVED response (URL plus the request headers the tab recorded). */
  kindOf(resp: ObservedRequest): EndpointKind | null {
    return this.route(resp)?.kind ?? null;
  }

  /** The GraphQL operation name a request carried, read off its headers. */
  friendlyName(requestHeaders?: Record<string, string>): string | undefined {
    return SURFACE.friendlyName(requestHeaders);
  }

  /** Whether an observed response's media type carries a parseable body (GraphQL answers `text/javascript`). */
  parseableBody(mimeType: string): boolean {
    return SURFACE.parseableMime(mimeType);
  }

  /** The profile kind this observed response carries, or `null`. */
  profileKindOf(resp: ObservedRequest): ProfileKind | null {
    const kind = this.kindOf(resp);
    return kind === 'profile-info' || kind === 'profile-graphql' ? kind : null;
  }

  /** The subject pk of a `friendships/show/<pk>/` URL (the body carries none). */
  extractPkFromUrl(url: string): string | null {
    return SURFACE.extractIds('friendship-show', url).pk ?? null;
  }

  /** The list owner's pk of a followers-list URL (the body carries the rows, not the owner). */
  extractTargetPkFromFollowersUrl(url: string): string | null {
    return SURFACE.extractIds('followers-list', url).targetPk ?? null;
  }

  /** The list owner's pk of a following-list URL. */
  extractTargetPkFromFollowingUrl(url: string): string | null {
    return SURFACE.extractIds('following-list', url).targetPk ?? null;
  }

  /** Read one body through the authoritative document pipeline (never throws). */
  read(kind: EndpointKind, input: BodyInput, ctx: ReadCtx): SurfaceRead {
    const decoded: Decoded = 'text' in input ? decodeBody(input.text, this.env.doc.read.transport) : input.decoded;
    return readBody(kind, { decoded, status: input.status, mime: input.mime }, ctx, this.env);
  }

  /** One composed list page (lists are never recovered: an own-list walk reads C0/C1 only). */
  readListPage(which: 'followers-list' | 'following-list', decoded: Decoded, at: number): SurfaceRead {
    return this.read(which, { decoded }, { at, source: which });
  }

  /** C2 recovery of a decoded body under a role's witness (spec §10.6): only ever adds facts, never destructive. */
  recover(kind: EndpointKind, decoded: Decoded, ctx: ReadCtx): SurfaceRead {
    return recoverBody(kind, decoded, ctx, this.env);
  }

  /** A walk-level drift signal (a stop the read alone cannot see), to the env's sink. */
  report(signal: DriftSignal, at: number): void {
    this.env.sink.drift(signal, at);
  }

  /** The relationship facts a read may feed the reconciler: presence-complete and admitted only. */
  relationshipFacts(read: SurfaceRead): ObservedRelation[] {
    return read.ok ? mintObserved(read, read.projection.relationships) : [];
  }

  /**
   * A profile read as the visit sees it: the observation (our own counts dropped unless the read is
   * C0/C1 and complete), the viewer flags (withheld unless destructive-admitted), presence and tier.
   */
  profileSeen(read: SurfaceRead, ownPk: string | null = this.ownPk): ProfileSeen | null {
    if (!read.ok) return null;
    const p = read.projection;
    const fact = p.facts[0];
    if (fact === undefined || p.presence === null) return null;
    const admitted = admits('destructive', read);
    const obs = fact.accountPk === ownPk && !admitted
      ? { ...fact, fields: { ...fact.fields, followers: undefined, following: undefined, mutuals: undefined } } : fact;
    const r = p.relationships.find((x) => x.pk === fact.accountPk);
    const viewer = !admitted || r === undefined ? UNKNOWN_VIEWER
      : { following: r.following, requested: r.outgoingRequest, followsUs: r.followedBy, incomingRequest: r.incomingRequest };
    return { obs, viewer, presence: p.presence, tier: read.tier, partial: read.partial };
  }

  /**
   * Whether this response's endpoint carries viewer-side relationship facts — the only bodies worth
   * the reconciler's read (`profile-info` has no `friendship_status`; the GraphQL profile does).
   */
  relationshipBearing(url: string, friendlyName?: string): boolean {
    const kind = this.matchEndpoint(url, friendlyName);
    return kind === 'show-many' || kind === 'friendship-show' || kind === 'profile-graphql';
  }
}
