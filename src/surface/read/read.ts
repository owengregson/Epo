/**
 * THE parser (spec §10.2–10.3): the observed gate, one decode, the GraphQL envelope, the declared
 * containers and the field readers, for every endpoint. Never throws (L-TOTAL): every body is a
 * typed read or a typed failure, and every read is reported to the env's sink.
 */

import { SURFACE_BOUNDS } from '@/kernel/surface-policy';
import { surface } from '@/surface/index';
import { NOVELTY_SHAPES, novelKeys, type ShapeNode, shapeOf } from '@/surface/lab/shape';
import { gateObserved } from '@/surface/read/gate';
import { type DefRef, missingPaths, resolveContainer } from '@/surface/read/normalize';
import { type PartialReason, reportRead } from '@/surface/read/report';
import type { BodyInput, ReadCtx, ReadEnv, ReadFailure, ReadMeta, SurfaceRead } from '@/surface/read/types';
import { NO_HINTS } from '@/surface/recovery/hints';
import type { EndpointKind } from '@/surface/schema/endpoints';
import { emptyProjection, type NormalizeStep, type Tier } from '@/surface/schema/projection';
import { NO_SINK } from '@/surface/sink';
import { decodeBody } from '@/surface/transport/decode';
import { graphqlEnvelope } from '@/surface/transport/graphql';

/** Endpoints whose records are rows: a page whose readable rows fall below the majority fails whole. */
const ROW_ENDPOINTS: ReadonlySet<EndpointKind> = new Set(['followers-list', 'following-list', 'friend-requests', 'show-many']);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keysOf = (json: unknown): string[] => (isRecord(json) ? Object.keys(json) : []);
const tierOf = (steps: readonly NormalizeStep[]): Tier => (steps.length > 0 ? 'normalized' : 'canonical');

/** Novelty shapes are built once per endpoint (the JSON-Schema walk is not free). */
const shapes = new Map<EndpointKind, ShapeNode>();
function noveltyOf(kind: EndpointKind, json: unknown): string[] {
  let node = shapes.get(kind);
  if (node === undefined) {
    node = shapeOf(NOVELTY_SHAPES[kind]);
    shapes.set(kind, node);
  }
  return novelKeys(json, node);
}

/** The env a read without one uses: the active document, no sink, no hints. */
export const defaultEnv = (): ReadEnv => ({ doc: surface(), sink: NO_SINK, hints: NO_HINTS });

/** A read, why it is partial, and the decoded body (the sink's sample on a first sighting). */
interface Outcome {
  readonly read: SurfaceRead;
  readonly partial: PartialReason;
  readonly json: unknown;
}

/** The definitions that may read this body: the routed one, else every definition of the kind. */
function candidates(kind: EndpointKind, ctx: ReadCtx, env: ReadEnv): DefRef[] {
  const routed = ctx.route === undefined ? undefined : env.doc.endpoints[ctx.route.defIndex];
  if (ctx.route !== undefined && routed?.kind === kind) return [{ def: routed, index: ctx.route.defIndex }];
  return env.doc.endpoints.flatMap((def, index) => (def.kind === kind ? [{ def, index }] : []));
}

function readOnce(kind: EndpointKind, input: BodyInput, ctx: ReadCtx, env: ReadEnv): Outcome {
  const decls = env.doc.read;
  const fail = (f: ReadFailure, json?: unknown): Outcome => ({ read: { ...f, endpoint: kind }, partial: null, json });
  if (input.status !== undefined && input.mime !== undefined) {
    // A decoded body that is not JSON keeps its head: an HTML page is a wall, whatever its status.
    const head = 'text' in input ? input.text.slice(0, SURFACE_BOUNDS.logHeadChars) : input.decoded.ok ? undefined : input.decoded.head;
    const gate = gateObserved(input.status, input.mime, decls.transport.parseableMime, head);
    if (gate.kind === 'wall') return fail({ ok: false, kind: 'wall', family: gate.family, via: gate.via, status: gate.status, detail: gate.via });
    if (gate.kind === 'http-absent') return fail({ ok: false, kind: 'http-absent', status: input.status });
    if (gate.kind === 'not-data') return fail({ ok: false, kind: 'not-data', status: gate.status, mime: gate.mime });
  }
  const decoded = 'text' in input ? decodeBody(input.text, decls.transport) : input.decoded;
  if (!decoded.ok) return fail({ ok: false, kind: 'transport', reason: decoded.reason });
  const json = decoded.json;
  const status = input.status ?? 0;
  // The root is present only when a declared container holds a record that validates.
  const found = resolveContainer(candidates(kind, ctx, env), json, decls.continuation);
  const envelope = graphqlEnvelope(json, () => found.kind === 'value', decls.graphql, decls.signatures);
  if (envelope.kind === 'wall') {
    const family = envelope.status === 'action-blocked' ? 'rate-limited' : 'auth';
    return fail({ ok: false, kind: 'wall', family, via: 'graphql', status, detail: envelope.status }, json);
  }
  // Errors without the declared root resolve toward waiting: a wall, never drift, never "gone".
  if (envelope.kind === 'error') {
    return fail({ ok: false, kind: 'wall', family: 'server-error', via: 'graphql', status, detail: 'errors-without-data' }, json);
  }
  if (found.kind === 'none') return fail({ ok: false, kind: 'mismatch', issues: found.issues, keys: keysOf(json) }, json);
  const partial: PartialReason = decoded.final === false ? 'incomplete-stream'
    : envelope.kind === 'data' && envelope.errors > 0 ? 'graphql-partial' : null;
  const steps: NormalizeStep[] = decoded.format === 'json' ? [] : [{ kind: 'framing', at: '(body)', detail: decoded.format }];
  if (ctx.route?.via === 'root-field') steps.push({ kind: 'root-field-route', at: '(route)', detail: ctx.route.op ?? undefined });
  steps.push(...found.steps);
  const meta: Omit<ReadMeta, 'tier' | 'steps'> = {
    endpoint: kind, partial: partial !== null, route: ctx.route?.via ?? 'url', novelKeys: noveltyOf(kind, json),
  };
  if (found.kind === 'null') {
    // Instagram's own "gone" comes only from a complete body; a partial one knows nothing yet.
    const projection = { ...emptyProjection(), absent: partial === null ? true : null };
    return { read: { ok: true, projection, ...meta, tier: tierOf(steps), steps }, partial, json };
  }
  const def = found.ref.def;
  const projection = def.project(found.value, { at: ctx.at, source: ctx.source ?? def.source ?? 'show-many', pk: ctx.pk,
    root: json, final: decoded.final, viewerPk: ctx.viewerPk ?? null, sideLists: def.sideLists, steps });
  for (const path of missingPaths(found.value, decls.expected[kind] ?? [])) {
    if (!projection.fieldIssues.some((i) => i.path === path)) projection.fieldIssues.push({ path, kind: 'expected-absent', got: 'absent' });
  }
  if (ROW_ENDPOINTS.has(kind)) {
    const readable = projection.facts.length + projection.relationships.length;
    const rows = readable + projection.rowIssues.length;
    if (rows > 0 && readable < SURFACE_BOUNDS.rowMajority * rows) {
      return fail({ ok: false, kind: 'rows-unreadable', rows, quarantined: projection.rowIssues.length }, json);
    }
  }
  return { read: { ok: true, projection, ...meta, tier: tierOf(steps), steps }, partial, json };
}

/** Read one body as `kind`. Counts and drift go to `env.sink`; `ctx.route` selects the definition. */
export function readBody(kind: EndpointKind, input: BodyInput, ctx: ReadCtx, env: ReadEnv = defaultEnv()): SurfaceRead {
  let outcome: Outcome;
  try {
    outcome = readOnce(kind, input, ctx, env);
  } catch (e) {
    // A projector or a schema that throws is drift evidence; it never escapes into the read path.
    const issues = [{ path: '(body)', message: `the reader threw: ${e instanceof Error ? e.name : typeof e}` }];
    outcome = { read: { ok: false, kind: 'mismatch', issues, keys: [], endpoint: kind }, partial: null, json: undefined };
  }
  const { read, partial, json } = outcome;
  reportRead(read, ctx.at, env.sink, { partial, novelty: env.doc.read.novelty[kind] ?? [], sample: () => json });
  return read;
}
