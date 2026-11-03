/**
 * Instagram Adapter — Reader: the read pipeline over the bodies the tab already captured. It NEVER
 * touches the DOM and NEVER issues requests. `read()` is `readBody` (spec §10.2–10.3) with the
 * Reader's env (the document, the sink, the hint book); `observed` reads each observed response once.
 * An endpoint the document drives (`enforce`) is also read by the legacy extractors as a comparator;
 * one still in `observe` keeps its legacy parse below with the document beside it. Zero Instagram
 * literals here: they live behind the document and `SURFACE` (`versions/*`).
 */

import { isShapeMismatch, SURFACE } from '@/adapter/ig-surface';
import { ObservedReads, type ObservedReadsOpts } from '@/adapter/observed-reads';
import * as relationships from '@/adapter/reader-relationships';
import { coerceBody, shadowDocument, shadowLegacy, warnUnexpected } from '@/adapter/reader-shadow';
import type { ProfileSeen } from '@/rim/profile-visit-port';
import type { ObservedRelation } from '@/shared/observed-relation';
import type { Observation } from '@/store/types';
import { admits } from '@/surface/read/admission';
import { defaultEnv, readBody } from '@/surface/read/read';
import { mintObserved } from '@/surface/read/relationship';
import type { ObservedRequest } from '@/surface/read/route';
import type { BodyInput, ReadCtx, ReadEnv, RouteMatch, SurfaceRead } from '@/surface/read/types';
import type { ProfilePresence } from '@/surface/schema/projection';
import type { DriftSignal } from '@/surface/sink';
import { type Decoded, decodeBody } from '@/surface/transport/decode';
import { type GraphqlOutcome, graphqlEnvelope } from '@/surface/transport/graphql';

export type { EndpointKind, FollowEvent, FollowersListResult, FriendshipShowResult, ShowManyEntry } from '@/adapter/ig-surface';

import type {
  EndpointKind, FollowEvent, FollowersListResult, FriendshipShowResult, ProfileViewer, ShowManyEntry,
} from '@/adapter/ig-surface';

/** Which profile body a parse is reading — the two containers differ. */
export type ProfileKind = Extract<EndpointKind, 'profile-info' | 'profile-graphql'>;

/** A viewer whose every flag is unknown (a recovered or partial read withholds them all). */
const UNKNOWN_VIEWER: ProfileViewer = { following: null, requested: null, followsUs: null, incomingRequest: null };

export class Reader {
  readonly env: ReadEnv;
  /** Every observed response read once, shared by every consumer of this Reader. */
  readonly observed: ObservedReads;

  /** `session` names whose session observes (I10) and the observation clock. */
  constructor(env: Partial<ReadEnv> = {}, session: ObservedReadsOpts = {}) {
    this.env = { ...defaultEnv(), ...env };
    this.observed = new ObservedReads(this, session);
  }

  /** Route an observed request through the one routing table, or `null`. */
  route(req: ObservedRequest): RouteMatch | null {
    return SURFACE.route(req);
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

  /** Read one body (never throws). An enforced endpoint's clean reads are compared with the legacy extractors. */
  read(kind: EndpointKind, input: BodyInput, ctx: ReadCtx): SurfaceRead {
    const decoded: Decoded = 'text' in input ? decodeBody(input.text, this.env.doc.read.transport) : input.decoded;
    const read = readBody(kind, { decoded, status: input.status, mime: input.mime }, ctx, this.env);
    const def = ctx.route === undefined ? this.env.doc.endpoints.find((e) => e.kind === kind) : this.env.doc.endpoints[ctx.route.defIndex];
    if (def?.mode === 'enforce' && decoded.ok) shadowLegacy(this.env, read, decoded.json, ctx);
    return read;
  }

  /** One composed list page (lists are never recovered: an own-list walk reads C0/C1 only). */
  readListPage(which: 'followers-list' | 'following-list', decoded: Decoded, at: number): SurfaceRead {
    return this.read(which, { decoded }, { at, source: which });
  }

  /** A walk-level drift signal (a stop the read alone cannot see), to the env's sink. */
  report(signal: DriftSignal, at: number): void {
    this.env.sink.drift(signal, at);
  }

  /** The relationship facts a read may feed the reconciler: presence-complete and admitted only. */
  relationshipFacts(read: SurfaceRead): ObservedRelation[];
  /** Legacy form: routed by URL and parsed by the endpoint's extractor (`reader-relationships.ts`). */
  relationshipFacts(url: string, body: unknown, at: number, friendlyName?: string): ObservedRelation[];
  relationshipFacts(a: SurfaceRead | string, body?: unknown, at = 0, friendlyName?: string): ObservedRelation[] {
    if (typeof a === 'string') return relationships.relationshipFacts(this, a, body, at, friendlyName);
    return a.ok ? mintObserved(a, a.projection.relationships) : [];
  }

  /**
   * A profile read as the visit sees it: the observation (our own counts dropped unless the read is
   * C0/C1 and complete), the viewer flags (withheld unless destructive-admitted), presence and tier.
   */
  profileSeen(read: SurfaceRead, ownPk: string | null): ProfileSeen | null {
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

  // --- Legacy parses: the endpoints still in `observe`, each with the document read beside it ----------

  /** STRICT followers page: the typed page, or `null` on drift (never the typed empty end-of-list page). */
  parseFollowersListStrict(body: unknown, at: number, final: boolean | null = null): FollowersListResult | null {
    return this.legacyList('followers-list', body, at, final);
  }

  /** STRICT following page (the followers shape; separate so a drift warning names the endpoint that broke). */
  parseFollowingListStrict(body: unknown, at: number, final: boolean | null = null): FollowersListResult | null {
    return this.legacyList('following-list', body, at, final);
  }

  /** STRICT follow-requests panel: `null` on drift, never "nobody asked to follow you" (spec §10.4). */
  parseRequestsStrict(body: unknown, at: number): FollowersListResult | null {
    return this.legacyList('friend-requests', body, at, null);
  }

  private legacyList(kind: 'followers-list' | 'following-list' | 'friend-requests', body: unknown, at: number,
    final: boolean | null): FollowersListResult | null {
    const json = coerceBody(body, kind);
    const result = SURFACE.extractFollowersList(json, at, kind, final);
    const legacy = isShapeMismatch(result) ? null : result;
    shadowDocument(this.env, kind, body, { at, source: kind, final }, json);
    if (legacy === null) warnUnexpected(kind, body);
    return legacy;
  }

  /** A profile body's observation; `null` when the body has no user (`kind` names the container). */
  parseProfileInfo(body: unknown, at: number, kind: ProfileKind = 'profile-info'): Observation | null {
    const json = coerceBody(body, kind);
    const result = SURFACE.extractProfileInfo(json, at);
    shadowDocument(this.env, kind, body, { at, source: 'profile' }, json);
    if (isShapeMismatch(result)) {
      warnUnexpected(kind, body);
      return null;
    }
    return result;
  }

  /** The GraphQL body's viewer flags, each by presence (`/users/<pk>/info/` has none). */
  profileViewer(body: unknown, kind: ProfileKind = 'profile-graphql'): ProfileViewer {
    return SURFACE.extractProfileViewer(coerceBody(body, kind));
  }

  /** Which decision-bearing fields a profile body carried (`viewerPk` names a null relationship's owner). */
  profilePresence(body: unknown, kind: ProfileKind, viewerPk: string | null): ProfilePresence | null {
    return SURFACE.extractProfilePresence(coerceBody(body, kind), viewerPk);
  }

  /** A profile body's GraphQL envelope (spec §10.5): a wall, errors to wait out, partial, or data. Never "gone". */
  profileEnvelope(body: unknown, kind: ProfileKind): GraphqlOutcome {
    const json = coerceBody(body, kind);
    const read = (): boolean => {
      const r = SURFACE.extractProfileInfo(json, 0);
      return r !== null && !isShapeMismatch(r);
    };
    return graphqlEnvelope(json, read, SURFACE.graphql, SURFACE.mutationRefusalSignatures);
  }

  /** Whether the body is Instagram saying the profile is gone: its declared container present and null. */
  profileAbsent(body: unknown, kind: ProfileKind): boolean {
    return SURFACE.extractProfileInfo(coerceBody(body, kind), 0) === null;
  }

  /** Parse the batched relationship map (`reader-relationships.ts`). */
  parseShowMany(body: unknown, at: number): ShowManyEntry[] {
    return relationships.parseShowMany(this.env, body, at);
  }

  /** Parse the single relationship shape; `null` when unparsed (`reader-relationships.ts`). */
  parseFriendshipShow(body: unknown, at: number, pk: string): FriendshipShowResult | null {
    return relationships.parseFriendshipShow(this.env, body, at, pk);
  }

  /** The feed body's side list of pending requesters, row by row (never the complete set). */
  feedPendingPreview(body: unknown, at: number): Observation[] {
    return SURFACE.extractFeedPendingPreview(coerceBody(body, 'activity-feed'), at);
  }

  /** STRICT feed: the follow events, `[]` on a well-formed empty feed, `null` on drift. */
  parseActivityFeedStrict(body: unknown, at = Date.now()): FollowEvent[] | null {
    const json = coerceBody(body, 'activity-feed');
    const result = SURFACE.extractActivityFeed(json);
    shadowDocument(this.env, 'activity-feed', body, { at, source: 'activity-feed' }, json);
    if (isShapeMismatch(result)) {
      warnUnexpected('activity-feed', body);
      return null;
    }
    return result;
  }

  /** Whether this response's endpoint carries viewer-side relationship facts. */
  relationshipBearing(url: string, friendlyName?: string): boolean {
    return relationships.relationshipBearing(this, url, friendlyName);
  }
}
