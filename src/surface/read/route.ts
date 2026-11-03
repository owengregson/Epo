/**
 * Routing (spec §10.5), the one table for every caller: REST by URL; GraphQL by the request's
 * operation name on ANY GraphQL path; then the root-field header against a definition's declared
 * root fields (a normalized step). An unrouted response is `null`, never a guess.
 */

import type { RouteMatch } from '@/surface/read/types';
import type { HintBook } from '@/surface/recovery/hints';
import type { RecoveryDecl } from '@/surface/schema/decls';
import type { EndpointKind } from '@/surface/schema/endpoints';
import type { SurfaceDocument } from '@/surface/schema/surface';
import type { TransportDecl } from '@/surface/transport/decode';

export type { RouteMatch, RouteVia } from '@/surface/read/types';

/** What the tab knows about the request behind a response. */
export interface ObservedRequest {
  readonly url: string;
  readonly method?: string;
  /** Lower-cased header names, as the tab records them. */
  readonly requestHeaders?: Record<string, string>;
  readonly requestBody?: string;
}

/** The GraphQL operation name a request carried (its header; the form only with request capture). */
export function opNameOf(req: ObservedRequest, decl: TransportDecl): string | null {
  const name = req.requestHeaders?.[decl.friendlyNameHeader];
  return typeof name === 'string' && name !== '' ? name : null;
}

/** Route one observed request to the definition that reads its body, or `null`. */
export function routeObserved(
  req: ObservedRequest,
  env: { readonly doc: SurfaceDocument; readonly transport: TransportDecl; readonly hints?: Pick<HintBook, 'learnedOps'> },
): RouteMatch | null {
  const op = opNameOf(req, env.transport);
  const defs = env.doc.endpoints;
  for (const [defIndex, def] of defs.entries()) {
    if (!def.match.url.test(req.url)) continue;
    if (def.match.friendlyName === undefined) return { kind: def.kind, defIndex, via: 'url', op: null };
    if (op !== null && def.match.friendlyName.test(op)) return { kind: def.kind, defIndex, via: 'header', op };
  }
  // A renamed operation still names its root field: a declared root field routes it (C1).
  const rootField = req.requestHeaders?.[env.transport.rootFieldHeader];
  for (const [defIndex, def] of defs.entries()) {
    if (typeof rootField === 'string' && def.match.url.test(req.url) && def.rootFields?.includes(rootField) === true) {
      return { kind: def.kind, defIndex, via: 'root-field', op };
    }
  }
  // A consistent learned operation name routes a renamed query (C2: never promoted, never destructive).
  const learned = op === null ? undefined : env.hints?.learnedOps().find((l) => l.op === op);
  const defIndex = learned === undefined ? -1
    : defs.findIndex((d) => d.kind === learned.kind && d.match.friendlyName !== undefined && d.match.url.test(req.url));
  return learned === undefined || defIndex < 0 ? null : { kind: learned.kind, defIndex, via: 'learned', op };
}

/** The endpoint family an unrouted operation name belongs to (the version's ordered patterns), or `null`. */
export function opFamilyOf(op: string, decl: Pick<RecoveryDecl, 'opFamilies'>): EndpointKind | null {
  return decl.opFamilies.find((f) => f.pattern.test(op))?.kind ?? null;
}
