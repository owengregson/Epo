/**
 * Parse a response through its endpoint's schema, and project it to facts.
 *
 * There is no lenient path. A body either matches its schema — and then
 * `project()` turns it into one fact per row — or it is a {@link SurfaceMismatch}
 * carrying the zod issue path. The two are different TYPES, which is ADR 0303
 * ("`SHAPE_MISMATCH` never collapses to the empty result") enforced by the
 * parser instead of by review: an end-of-list claim cannot be constructed from
 * a mismatch because a mismatch has no `cursor`/`hasMore` to read.
 */

import { SurfaceHealth } from '@/surface/health';
import { surface } from '@/surface/index';
import { NOVELTY_SHAPES, novelKeys, type ShapeNode, shapeOf } from '@/surface/lab/shape';
import type { EndpointKind } from '@/surface/schema/endpoints';
import {
  type EndpointDef,
  flattenIssues,
  type ProjectCtx,
  type Projection,
  type SurfaceParse,
} from '@/surface/schema/surface';

/**
 * The process-wide health counters. In-memory this wave; the `snapshot()` shape
 * is already the row a `surface_observations` table would hold (wave-B seam).
 */
export const SURFACE_HEALTH = new SurfaceHealth(surface().id);

/** Novelty shapes are built once per endpoint — the JSON-Schema walk is not free. */
const noveltyShapes = new Map<EndpointKind, ShapeNode>();
const noveltyShape = (kind: EndpointKind): ShapeNode => {
  let node = noveltyShapes.get(kind);
  if (node === undefined) {
    node = shapeOf(NOVELTY_SHAPES[kind]);
    noveltyShapes.set(kind, node);
  }
  return node;
};

/** Parse one body through `endpoint.response`, with the novelty pass alongside. */
export function parseResponse(endpoint: EndpointDef, body: unknown): SurfaceParse<unknown> {
  const parsed = endpoint.response.safeParse(body);
  if (!parsed.success) {
    return { ok: false, endpoint: endpoint.kind, issues: flattenIssues(parsed.error.issues) };
  }
  return {
    ok: true,
    endpoint: endpoint.kind,
    value: parsed.data,
    // zod strips unknown keys, so novelty is computed against the RAW body.
    novelKeys: novelKeys(body, noveltyShape(endpoint.kind)),
  };
}

/** Parse and project in one step. */
export function readResponse(
  endpoint: EndpointDef,
  body: unknown,
  ctx: ProjectCtx,
): { ok: true; projection: Projection; novelKeys: readonly string[] } | { ok: false; issues: ReadonlyArray<{ path: string; message: string }> } {
  const parsed = parseResponse(endpoint, body);
  if (!parsed.ok) return { ok: false, issues: parsed.issues };
  return {
    ok: true,
    projection: endpoint.project(parsed.value, ctx),
    novelKeys: parsed.novelKeys,
  };
}

/** The document's endpoint for a kind, or `null`. */
export function endpointFor(kind: EndpointKind): EndpointDef | null {
  return surface().endpoints.find((e) => e.kind === kind) ?? null;
}
