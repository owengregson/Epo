/**
 * What one response body projects to: the facts, relationships and events a
 * read emits, and the context a projector needs. Re-exported by `surface.ts`.
 */

import type { Observation, Source } from '@/store/types';

// ---------------------------------------------------------------------------
// Facts a projection can emit
// ---------------------------------------------------------------------------

/** One "started following you" event parsed from the activity feed. */
export interface FollowEvent {
  pk: string;
  username: string | null;
  /** Epoch MS (the feed reports seconds). */
  atMs: number | null;
}

/** How a read was located (spec §10.2): the declared form, a declared alternate, or recovered. */
export type Tier = 'canonical' | 'normalized' | 'recovered';

/** A declared non-canonical form: framing, an alternate container, an alias key, a retype, a root-field route. */
export type StepKind = 'framing' | 'alternate-container' | 'alias-key' | 'retype' | 'root-field-route';

/** One normalized step: what fired, where (a path pattern, never a value), and a short detail. */
export interface NormalizeStep {
  readonly kind: StepKind;
  readonly at: string;
  readonly detail?: string;
}

/** A value's JSON type, `absent` when the key is missing (issues name types, never values). */
export type JsonType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null' | 'absent';
export type FieldIssueKind = 'expected-absent' | 'unexpected-null' | 'invalid' | 'counts-partial' | 'id-conflict'
  | 'id-space' | 'unsafe-number' | 'time-range' | 'enum-novel';
/** One field a reader refused: where (a path pattern), why, and what type arrived. */
export interface FieldIssue {
  readonly path: string;
  readonly kind: FieldIssueKind;
  readonly got?: JsonType;
}

/** Whether a field was read, and if not, why (spec §10.3). */
export type Presence = 'read' | 'absent' | 'null' | 'invalid' | 'partial' | 'withheld';
/** A profile read's presence per decision-bearing field. */
export interface ProfilePresence {
  /** `read` only for a valid count pair. */
  readonly counts: Presence;
  /** `read` covers '' and text; `null` is an explicit null. */
  readonly bio: Presence;
  readonly isPrivate: Presence;
  readonly isVerified: Presence;
  /** `self` only when the viewer reads their own record (I10). */
  readonly relationship: Presence | 'self';
}

/**
 * A viewer-side relationship fact. Every flag is read by presence: `null` means the key was
 * absent (unknown), never `false` (spec §10.4).
 */
export interface RelationshipFact {
  pk: string;
  following: boolean | null;
  /** TRUE while our follow request to a private account awaits acceptance. */
  outgoingRequest: boolean | null;
  /** `followedBy` => THEY follow us. */
  followedBy: boolean | null;
  /** TRUE while THEIR follow request to us awaits our answer. */
  incomingRequest: boolean | null;
  isPrivate?: boolean;
}

/**
 * What a list page says about the rest of the list (spec §10.4): a next cursor and its form, an
 * end and its evidence (with the first unexplained cursor-like key, if any), or drift.
 */
export type Continuation =
  | { readonly kind: 'next'; readonly cursor: string; readonly form: 'offset' | 'opaque' }
  | { readonly kind: 'end'; readonly evidence: 'flags-false' | 'no-flags'; readonly vetoKey?: string }
  | { readonly kind: 'drift'; readonly reason: 'more-without-cursor' | 'incomplete-stream'; readonly key?: string };

/** A row the row schema rejected — counted drift evidence, never silently dropped. */
export interface RowIssue {
  /** Index of the offending row inside its container. */
  index: number;
  /** The zod issue path, e.g. `pk`. */
  path: string;
  message: string;
}

/**
 * What one response body projects to. EVERY member is per-item by construction:
 * `facts` is one `Observation` per row, so a consumer writes through as it
 * iterates (PRINCIPLES §1) instead of receiving a completed batch.
 */
export interface Projection {
  facts: Observation[];
  relationships: RelationshipFact[];
  events: FollowEvent[];
  /** Resume cursor for a paginated endpoint; `null` when there is no next page (from `continuation`). */
  cursor: string | null;
  hasMore: boolean;
  /** What a list page says about the rest of the list; `null` on endpoints that are not lists. */
  continuation: Continuation | null;
  /** `null` when this endpoint carries no "the profile is gone" answer. */
  absent: boolean | null;
  rowIssues: RowIssue[];
  fieldIssues: FieldIssue[];
  /** Profile endpoints only: which decision-bearing fields the record carried. */
  presence: ProfilePresence | null;
  /** The feed's side list of pending requesters (never the complete set). */
  pendingPreview: Observation[];
  /** Whose session read the profile (I10), when the body names it. */
  viewerPk: string | null;
}

/** An empty projection — the shape every `project()` starts from. */
export const emptyProjection = (): Projection => ({
  facts: [],
  relationships: [],
  events: [],
  cursor: null,
  hasMore: false,
  continuation: null,
  absent: null,
  rowIssues: [],
  fieldIssues: [],
  presence: null,
  pendingPreview: [],
  viewerPk: null,
});

/** Context a projection needs that the record itself does not carry. */
export interface ProjectCtx {
  /** Observation timestamp (epoch MS). */
  at: number;
  /** Provenance label for the observations this body produces. */
  source: Source;
  /** The subject pk pulled out of the request URL, when the endpoint carries one. */
  pk?: string;
  /** The decoded body the container was found in (side lists, the viewer). */
  root?: unknown;
  /** The stream's final flag: `false` makes a list page's continuation drift. */
  final?: boolean | null;
  /** Whose session made the read, when the caller knows it (I10's fallback to the body's viewer). */
  viewerPk?: string | null;
  /** The definition's side lists, relative to the body. */
  sideLists?: { readonly pendingPreview: string };
  /** Collects the normalized steps the record's fields fired. */
  steps?: NormalizeStep[];
}
