/**
 * The surface lab's entry to the read pipeline: an already-parsed body read through `readBody`
 * (the one parser) and answered in the shape the lab's tools record. There is no lenient path: a
 * body is a projection or a typed failure, and a failure has no `cursor`/`hasMore` to read.
 */

import { surface } from '@/surface/index';
import { readBody } from '@/surface/read/read';
import type { EndpointKind } from '@/surface/schema/endpoints';
import type { EndpointDef, ProjectCtx, Projection } from '@/surface/schema/surface';

/** Read one parsed body as its endpoint, through every definition of that endpoint's kind. */
export function readResponse(
  endpoint: EndpointDef,
  body: unknown,
  ctx: ProjectCtx,
): { ok: true; projection: Projection; novelKeys: readonly string[] } | { ok: false; issues: ReadonlyArray<{ path: string; message: string }> } {
  const read = readBody(endpoint.kind, { decoded: { ok: true, json: body, format: 'json', payloads: 1, final: null } },
    { at: ctx.at, source: ctx.source, pk: ctx.pk });
  if (read.ok) return { ok: true, projection: read.projection, novelKeys: read.novelKeys };
  return { ok: false, issues: read.kind === 'mismatch' ? read.issues : [{ path: '(body)', message: read.kind }] };
}

/** The document's endpoint for a kind, or `null`. */
export function endpointFor(kind: EndpointKind): EndpointDef | null {
  return surface().endpoints.find((e) => e.kind === kind) ?? null;
}
