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
  /** Resume cursor for a paginated endpoint; `null` when there is no next page. */
  cursor: string | null;
  hasMore: boolean;
  /** `null` when this endpoint carries no "the profile is gone" answer. */
  absent: boolean | null;
  rowIssues: RowIssue[];
}

/** An empty projection — the shape every `project()` starts from. */
export const emptyProjection = (): Projection => ({
  facts: [],
  relationships: [],
  events: [],
  cursor: null,
  hasMore: false,
  absent: null,
  rowIssues: [],
});

/** Context a projection needs that the body itself does not carry. */
export interface ProjectCtx {
  /** Observation timestamp (epoch MS). */
  at: number;
  /** Provenance label for the observations this body produces. */
  source: Source;
  /** The subject pk pulled out of the request URL, when the endpoint carries one. */
  pk?: string;
}
