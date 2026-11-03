/**
 * The read pipeline's shared vocabulary (spec Appendix D.1): routes, the read context and env, a
 * read's metadata and its typed failures. A normalized step makes a read C1; recovery makes it C2.
 */

import type { Source } from '@/store/types';
import type { HintBook, IdentityOracle, RecoveryRole } from '@/surface/recovery/hints';
import type { EndpointKind } from '@/surface/schema/endpoints';
import type { NormalizeStep, Projection, Tier } from '@/surface/schema/projection';
import type { SurfaceDocument } from '@/surface/schema/surface';
import type { SurfaceSink } from '@/surface/sink';
import type { Decoded } from '@/surface/transport/decode';

export type { NormalizeStep, StepKind } from '@/surface/schema/projection';

/** Which wall a response is: a rate limit, a session wall, or server errors to wait out. */
export type WallFamily = 'rate-limited' | 'auth' | 'server-error';

export type RouteVia = 'url' | 'header' | 'form' | 'root-field' | 'learned' | 'candidate';

/** Request fields read only with the optional request capture (owner Q31). */
export interface RequestFacts {
  readonly subjectId?: string;
  readonly feedFilter?: string;
}

export interface RouteMatch {
  readonly kind: EndpointKind;
  /** The definition's index in the document. */
  readonly defIndex: number;
  readonly via: RouteVia;
  /** The GraphQL operation name the request carried, if any. */
  readonly op: string | null;
  readonly request?: RequestFacts;
}

export type ReadFailure =
  | { readonly ok: false; readonly kind: 'wall'; readonly family: WallFamily; readonly via: 'http' | 'html' | 'graphql';
      readonly status: number; readonly detail: string }
  | { readonly ok: false; readonly kind: 'http-absent'; readonly status: number }
  | { readonly ok: false; readonly kind: 'not-data'; readonly status: number; readonly mime: string }
  | { readonly ok: false; readonly kind: 'transport'; readonly reason: 'empty' | 'invalid-json' | 'bad-frame' }
  /** `keys` are the DECODED body's top-level key names, never values. */
  | { readonly ok: false; readonly kind: 'mismatch'; readonly issues: ReadonlyArray<{ path: string; message: string }>;
      readonly keys: readonly string[] }
  | { readonly ok: false; readonly kind: 'ambiguous'; readonly candidates: number }
  | { readonly ok: false; readonly kind: 'rows-unreadable'; readonly rows: number; readonly quarantined: number };

export interface ReadMeta {
  readonly endpoint: EndpointKind;
  readonly tier: Tier;
  readonly partial: boolean;
  readonly steps: readonly NormalizeStep[];
  readonly route: RouteVia;
  readonly novelKeys: readonly string[];
  readonly located?: { readonly role: RecoveryRole; readonly pattern: string; readonly via: 'hint' | 'search' };
}

export type SurfaceRead = ({ readonly ok: true; readonly projection: Projection } & ReadMeta)
  | (ReadFailure & { readonly endpoint: EndpointKind });

export type BodyInput = { readonly text: string; readonly status?: number; readonly mime?: string }
  | { readonly decoded: Decoded; readonly status?: number; readonly mime?: string };

/** What a recovery must find: the armed visit's username, and its pk when known. */
export interface Anchor {
  readonly username?: string;
  readonly pk?: string;
}

/** What armed a recovery; `acquisition` arms only the `source-rows` role. */
export type Arm = 'visit' | 'drawer' | 'requests-panel' | 'acquisition';

export interface ReadCtx {
  readonly at: number;
  readonly source?: Source;
  /** The subject pk the request URL carries (friendship-show). */
  readonly pk?: string;
  readonly route?: RouteMatch;
  readonly anchor?: Anchor;
  readonly arm?: Arm;
  /** Whose session made the read, when the caller knows it (I10's fallback to the body's viewer). */
  readonly viewerPk?: string | null;
}

export interface ReadEnv {
  readonly doc: SurfaceDocument;
  readonly sink: SurfaceSink;
  readonly hints: HintBook;
  readonly identity?: IdentityOracle;
}
