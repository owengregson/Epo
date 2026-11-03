/**
 * The surface's endpoint vocabulary: the endpoint kinds and the PII classes a
 * schema field is declared with. Each capture's schemas live in its `schemas.ts`.
 */

import type { z } from 'zod';

// ---------------------------------------------------------------------------
// PII vocabulary
// ---------------------------------------------------------------------------

/** The PII classes the scrubber knows how to replace with a stable pseudonym. */
export const PII_KINDS = ['handle', 'name', 'pk', 'url', 'text', 'cursor'] as const;
export type PiiKind = (typeof PII_KINDS)[number];

/** Attach a PII class to a schema (recorded in zod's global registry). */
export const pii = <T extends z.ZodType>(schema: T, kind: PiiKind): T =>
  schema.meta({ pii: kind }) as unknown as T;

/** The endpoint kinds the surface document routes. */
export const ENDPOINT_KINDS = [
  'followers-list',
  'following-list',
  'friend-requests',
  'show-many',
  'friendship-show',
  /** `/api/v1/users/<pk>/info/` — what Epo fetches for a profile. */
  'profile-info',
  /** The GraphQL profile query Instagram's own client fires; OBSERVED only. */
  'profile-graphql',
  'activity-feed',
] as const;
export type EndpointKind = (typeof ENDPOINT_KINDS)[number];
