/**
 * The SURFACE DOCUMENT schema — Instagram as validated data.
 *
 * `IgSurface` is a hand-maintained façade of 45 methods that every version
 * module must re-implement. This is its replacement: a *document* whose data
 * half (origin, app id, endpoint match patterns, control descriptors, signals,
 * page sizes) is validated once at load, and whose behaviour half (a response
 * schema and a pure `project()` per endpoint) is typed rather than duplicated.
 *
 * Layering: this module imports zod, the store's types and its schema siblings
 * and NOTHING else. It carries no Electron, no adapter, no engine — so the contract
 * tests can load a surface without a tab, and `src/surface/**` can never
 * acquire a dependency that makes it un-testable in CI.
 */

import { z } from 'zod';
import type { Source } from '@/store/types';
import type { EndpointKind } from '@/surface/schema/endpoints';
import type { ProjectCtx, Projection } from '@/surface/schema/projection';

// The fact types live in `projection.ts`; re-exported so consumers keep one import site.
export {
  type Continuation,
  emptyProjection,
  type FollowEvent,
  type ProjectCtx,
  type Projection,
  type RelationshipFact,
  type RowIssue,
  type Tier,
} from '@/surface/schema/projection';

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

/**
 * A response that did not match its endpoint's schema. Structurally distinct
 * from every success shape, so an end-of-list claim (or any other typed empty
 * result) literally cannot be constructed from it — ADR 0303 enforced by the
 * type system instead of by review.
 */
export interface SurfaceMismatch {
  readonly ok: false;
  readonly endpoint: EndpointKind;
  /** The zod issues, flattened to `path — message` for the log line. */
  readonly issues: ReadonlyArray<{ path: string; message: string }>;
}

/** A response that matched its schema, with the parsed body. */
export interface SurfaceParsed<T> {
  readonly ok: true;
  readonly endpoint: EndpointKind;
  readonly value: T;
  /** Keys present in the body the schema does not know — the earliest drift signal. */
  readonly novelKeys: readonly string[];
}

export type SurfaceParse<T> = SurfaceParsed<T> | SurfaceMismatch;

// ---------------------------------------------------------------------------
// The document's DATA half — validated at load
// ---------------------------------------------------------------------------

/** A RegExp serialized for the JSON trip into page context. */
export const RegexLit = z.object({ source: z.string(), flags: z.string() });
export type RegexLit = z.infer<typeof RegexLit>;

/** A labelled block/challenge/logged-out signature. */
export const SignalSchema = z.object({
  pattern: z.instanceof(RegExp),
  status: z.enum(['ok', 'action-blocked', 'challenge', 'logged-out']),
  /** Where the pattern is matched: the tab's URL, on-screen text, or a refusal body. */
  surface: z.enum(['url', 'text', 'refusal']),
});
export type Signal = z.infer<typeof SignalSchema>;

/** How a control is found in the page. Six strategies cover every control today. */
export const STRATEGIES = [
  'leading-text',
  'smallest-text',
  'aria-label',
  'role-then-deep-text',
  'largest-scrollable',
  'row-with-profile-link',
  'escape',
] as const;
export type Strategy = (typeof STRATEGIES)[number];

/**
 * A control descriptor: the page bundle's `locate()` interprets `strategy` and
 * every other key is that strategy's config. `escape` is the tier of LAST
 * RESORT — its payload is a typed function evaluated main-side, and the loader
 * refuses a document whose escape control names no ADR (risk #2 of the lens
 * report: a strategy table that cannot express the next control must not force
 * a bad fit and a silently wrong locate).
 */
export const ControlSchema = z
  .object({
    strategy: z.enum(STRATEGIES),
    /**
     * ADR that authorised an `escape` control. Required for `escape`, forbidden
     * otherwise — an escape hatch nobody had to argue for is not an escape hatch.
     */
    adr: z.string().optional(),
    /** A `leading-text` control never widens its scope (ADR 0302). */
    allowFallback: z.boolean().optional(),
  })
  .loose()
  .refine((c) => c.strategy !== 'escape' || typeof c.adr === 'string', {
    error: 'an `escape` control must name the ADR that authorised it',
  })
  .refine((c) => c.strategy === 'escape' || c.adr === undefined, {
    error: 'only an `escape` control may name an ADR',
  });
export type ControlDescriptor = z.infer<typeof ControlSchema>;

/** The endpoint's URL/method matcher, plus the ids the URL carries. */
export const MatchSchema = z.object({
  method: z.enum(['GET', 'POST']).optional(),
  url: z.instanceof(RegExp),
  /**
   * A GraphQL friendly-name the REQUEST must have carried. One URL
   * (`/api/graphql`) serves dozens of unrelated queries, so an endpoint routed
   * off that path is identified by its operation name instead. An endpoint that
   * declares this matches ONLY when the caller supplies a friendly name that
   * matches; one that omits it matches on URL alone, as before.
   */
  friendlyName: z.instanceof(RegExp).optional(),
  ids: z
    .object({ pk: z.instanceof(RegExp).optional(), targetPk: z.instanceof(RegExp).optional() })
    .optional(),
});
export type Match = z.infer<typeof MatchSchema>;

/**
 * One endpoint entry. `response` and `project` are behaviour, not data, so they
 * are validated as "is a zod schema" / "is a function" — the CONTRACT TESTS
 * (`tests/surface/replay.test.ts`) are what actually validate them, against the
 * committed corpus.
 */
export const EndpointSchema = z.object({
  kind: z.string(),
  /**
   * `observe` runs the schema alongside the legacy extractor and only LOGS a
   * disagreement; `enforce` makes the schema the parse. Every endpoint is
   * `observe` in wave A — flipping one is a per-endpoint decision backed by
   * the shadow-parse record, and is reversible without a release.
   */
  mode: z.enum(['observe', 'enforce']),
  match: MatchSchema,
  response: z.custom<z.ZodType>((v) => v instanceof z.ZodType, {
    error: 'endpoint.response must be a zod schema',
  }),
  project: z.custom<(body: never, ctx: ProjectCtx) => Projection>((v) => typeof v === 'function', {
    error: 'endpoint.project must be a function',
  }),
  /** Provenance label for the observations this endpoint produces. */
  source: z.string().optional(),
  /** GraphQL root fields that route a renamed operation here (a normalized step). */
  rootFields: z.array(z.string().min(1)).optional(),
});

/** A relationship mutation the action button fires. */
export const MutationSchema = z.object({
  kind: z.enum(['follow', 'unfollow']),
  match: MatchSchema,
  /** The GraphQL friendly-name header this mutation is recognised by, if any. */
  friendlyName: z.instanceof(RegExp).optional(),
});
export type MutationSpec = z.infer<typeof MutationSchema>;

/** The whole document. */
export const SurfaceDocSchema = z.object({
  /** Capture provenance — the version module's date. */
  id: z.string().min(1),
  origin: z.url(),
  appId: z.string().min(1),
  userAgent: z.string().min(1),
  endpoints: z.array(EndpointSchema).min(1),
  mutations: z.array(MutationSchema).min(1),
  controls: z.record(z.string(), ControlSchema),
  signals: z.array(SignalSchema).min(1),
  pageSizes: z.object({
    /** Rows requested per direct friendships-list page. */
    listPage: z.int().min(1).max(200),
  }),
});
export type SurfaceDoc = z.infer<typeof SurfaceDocSchema>;

// ---------------------------------------------------------------------------
// The document's TYPED face. `SurfaceDocSchema` validates the data at load;
// these interfaces are what consumers program against.
// ---------------------------------------------------------------------------

/**
 * One endpoint, with its parse and its projection erased to `unknown` at the
 * boundary. Build entries through {@link defineEndpoint}, which is the single
 * place the body type is narrowed — so an endpoint's `project` still receives
 * exactly what its `response` schema produced, and no call site casts.
 */
export interface EndpointDef {
  kind: EndpointKind;
  mode: 'observe' | 'enforce';
  match: Match;
  response: z.ZodType;
  project: (body: unknown, ctx: ProjectCtx) => Projection;
  /** Provenance label for the observations this endpoint produces. */
  source?: Source;
  /** GraphQL root fields that route a renamed operation here (a normalized step). */
  rootFields?: readonly string[];
}

/** Define one endpoint, narrowing `project`'s body to what `response` parses to. */
export function defineEndpoint<B>(def: {
  kind: EndpointKind;
  mode: 'observe' | 'enforce';
  match: Match;
  response: z.ZodType<B>;
  project: (body: B, ctx: ProjectCtx) => Projection;
  source?: Source;
  rootFields?: readonly string[];
}): EndpointDef {
  return {
    kind: def.kind,
    mode: def.mode,
    match: def.match,
    response: def.response as z.ZodType,
    project: (body: unknown, ctx: ProjectCtx): Projection => def.project(body as B, ctx),
    source: def.source,
    ...(def.rootFields === undefined ? {} : { rootFields: def.rootFields }),
  };
}

/** The whole document, as consumers see it. */
export interface SurfaceDocument {
  id: string;
  origin: string;
  appId: string;
  userAgent: string;
  endpoints: readonly EndpointDef[];
  mutations: readonly MutationSpec[];
  controls: Readonly<Record<string, ControlDescriptor>>;
  signals: readonly Signal[];
  pageSizes: { listPage: number };
}

/** A document that failed validation — never silently coerced into a working one. */
export interface SurfaceInvalid {
  readonly ok: false;
  readonly id: string;
  readonly issues: ReadonlyArray<{ path: string; message: string }>;
}

/** Flatten zod issues to the `path — message` pairs every log line here uses. */
export const flattenIssues = (
  issues: readonly z.core.$ZodIssue[],
): Array<{ path: string; message: string }> =>
  issues.map((i) => ({
    path: i.path.map(String).join('.') || '(root)',
    message: i.message,
  }));
