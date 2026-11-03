/**
 * `loadSurface()` — the active Instagram surface document, validated ONCE.
 *
 * The document is data (§6 of the v4 design), so it is parsed the way every
 * other untrusted boundary is: `SurfaceDocSchema.safeParse` at load, and a
 * failure returns {@link SurfaceInvalid} rather than a half-built surface.
 * Nothing here reaches Electron, the store or the engine — the contract tests
 * load a surface with no tab at all.
 *
 * When Instagram changes: add `versions/<capture-date>/`, re-point the import
 * below, and run `tests/surface/replay.test.ts` against the corpus.
 */

import { type ObservedRequest, type RouteMatch, routeObserved } from '@/surface/read/route';
import type { EndpointKind } from '@/surface/schema/endpoints';
import {
  type EndpointDef,
  flattenIssues,
  SurfaceDocSchema,
  type SurfaceDocument,
  type SurfaceInvalid,
} from '@/surface/schema/surface';
import { RESPONSE_SCHEMAS } from '@/surface/versions/2026-08-12/schemas';
import { SURFACE_DOC_2026_08_12 } from '@/surface/versions/2026-08-12/surface';
import { TRANSPORT } from '@/surface/versions/2026-08-12/transport-decl';

/** The document the app is built against. */
const ACTIVE: SurfaceDocument = SURFACE_DOC_2026_08_12;

let cached: SurfaceDocument | SurfaceInvalid | null = null;

/**
 * Validate and return the active document. Cached: the schema walk is cheap but
 * it must be run exactly once per process so a validation failure is a single
 * loud event rather than a per-call log storm.
 */
export function loadSurface(doc: SurfaceDocument = ACTIVE): SurfaceDocument | SurfaceInvalid {
  if (doc === ACTIVE && cached !== null) return cached;
  const parsed = SurfaceDocSchema.safeParse(doc);
  const result: SurfaceDocument | SurfaceInvalid = parsed.success
    ? doc
    : { ok: false, id: doc.id, issues: flattenIssues(parsed.error.issues) };
  if (doc === ACTIVE) cached = result;
  return result;
}

/** Whether a `loadSurface` result is the failure shape. */
export const isSurfaceInvalid = (v: SurfaceDocument | SurfaceInvalid): v is SurfaceInvalid =>
  (v as SurfaceInvalid).ok === false;

/**
 * The validated document, or a throw. Used at the seams that cannot express a
 * failure (module-level constants); every caller that CAN handle an invalid
 * surface uses {@link loadSurface} instead.
 */
export function surface(): SurfaceDocument {
  const loaded = loadSurface();
  if (isSurfaceInvalid(loaded)) {
    throw new Error(
      `surface: document ${loaded.id} failed validation: ${loaded.issues
        .map((i) => `${i.path} — ${i.message}`)
        .join('; ')}`,
    );
  }
  return loaded;
}

/** Route an observed request through the one routing table (`read/route.ts`), or `null`. */
export function routeOf(req: ObservedRequest, doc: SurfaceDocument = surface()): RouteMatch | null {
  return routeObserved(req, { doc, transport: TRANSPORT });
}

/** Route a response URL (and the operation name it carried) to its endpoint definition, or `null`. */
export function matchEndpoint(
  url: string,
  friendlyName?: string,
  doc: SurfaceDocument = surface(),
): EndpointDef | null {
  const headers = friendlyName === undefined ? undefined : { [TRANSPORT.friendlyNameHeader]: friendlyName };
  const route = routeOf({ url, requestHeaders: headers }, doc);
  return route === null ? null : (doc.endpoints[route.defIndex] ?? null);
}

/** The endpoint definition for a kind, or `null`. */
export function endpointOf(
  kind: EndpointKind,
  doc: SurfaceDocument = surface(),
): EndpointDef | null {
  return doc.endpoints.find((e) => e.kind === kind) ?? null;
}

/** Every endpoint kind the document declares. */
export const endpointKinds = (doc: SurfaceDocument = surface()): EndpointKind[] =>
  doc.endpoints.map((e) => e.kind);

/** Reset the load cache (tests). */
export function resetSurfaceCache(): void {
  cached = null;
}

export type { EndpointKind, SurfaceDocument, SurfaceInvalid };
export { RESPONSE_SCHEMAS };
