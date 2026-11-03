/**
 * Shared surface test helpers: a parsed body as the read pipeline's input, the observed profile
 * query's route, and one body read through a Reader the way an observed response is read.
 */
import type { Reader } from '@/adapter/reader';
import type { ObservedRequest } from '@/surface/read/route';
import type { BodyInput, ReadCtx, SurfaceRead } from '@/surface/read/types';
import type { EndpointKind } from '@/surface/schema/endpoints';

export const GRAPHQL_URL = 'https://www.instagram.com/api/graphql';
/** The request the page's own client fires for a profile (routed by its operation name). */
export const PROFILE_QUERY: ObservedRequest = {
  url: GRAPHQL_URL,
  requestHeaders: { 'x-fb-friendly-name': 'PolarisProfilePageContentQuery' },
};

/** An already-parsed body as the read pipeline's input (`final: false` is a stream that is not done). */
export const jsonInput = (json: unknown, final: boolean | null = null): BodyInput =>
  ({ decoded: { ok: true, json, format: 'json', payloads: 1, final } });

/** Read one parsed body as `kind` through `reader`, routed by `req` when given. */
export function readAs(reader: Reader, kind: EndpointKind, body: unknown, ctx: Omit<ReadCtx, 'route'>,
  req?: ObservedRequest, final: boolean | null = null): SurfaceRead {
  const route = req === undefined ? null : reader.route(req);
  return reader.read(kind, jsonInput(body, final), route === null ? ctx : { ...ctx, route });
}
