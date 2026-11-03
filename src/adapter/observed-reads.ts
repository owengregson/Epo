/**
 * One read per observed response (spec Appendix D.1): routed, gated, decoded and read ONCE, and the
 * result memoized per `TabResponse`, so every consumer of a body (the profile observer, the
 * relationship reconciler, a list scrape) shares one body read and one decode, and the sink counts it once.
 */

import type { TabResponse } from '@/shared/tab-response';
import { gateObserved } from '@/surface/read/gate';
import type { ObservedRequest } from '@/surface/read/route';
import type { BodyInput, ReadCtx, ReadEnv, RouteMatch, SurfaceRead } from '@/surface/read/types';
import type { EndpointKind } from '@/surface/schema/endpoints';
import { type Decoded, decodeBody } from '@/surface/transport/decode';

/** One observed response as the read pipeline read it: its route, its decode (null when gated out) and its read. */
export interface ObservedRead {
  readonly route: RouteMatch;
  readonly decoded: Decoded | null;
  readonly read: SurfaceRead;
}

/** What the memo reads through: the Reader, structurally (so this module never imports it). */
export interface ObservedReader {
  readonly env: ReadEnv;
  route(req: ObservedRequest): RouteMatch | null;
  read(kind: EndpointKind, input: BodyInput, ctx: ReadCtx): SurfaceRead;
}

export interface ObservedReadsOpts {
  /** Whose session observes (I10): names a null relationship's owner when a body omits its own viewer. */
  readonly viewerPk?: string | null;
  /** The observation clock (default: the wall clock). */
  readonly now?: () => number;
}

export class ObservedReads {
  private readonly memo = new WeakMap<TabResponse, Promise<ObservedRead>>();

  constructor(
    private readonly reader: ObservedReader,
    private readonly opts: ObservedReadsOpts = {},
  ) {}

  /** The response's read, shared by every caller; `null` when no definition routes it. */
  read(resp: TabResponse): Promise<ObservedRead> | null {
    const known = this.memo.get(resp);
    if (known !== undefined) return known;
    const route = this.reader.route(resp);
    if (route === null) return null;
    const pending = this.readRouted(resp, route);
    this.memo.set(resp, pending);
    return pending;
  }

  private async readRouted(resp: TabResponse, route: RouteMatch): Promise<ObservedRead> {
    const { env } = this.reader;
    const subject = env.doc.endpoints[route.defIndex]?.match.ids?.pk?.exec(resp.url)?.[1];
    const ctx: ReadCtx = { at: (this.opts.now ?? Date.now)(), route, viewerPk: this.opts.viewerPk ?? null,
      ...(subject === undefined ? {} : { pk: subject }) };
    const status = resp.status;
    const mime = resp.mimeType;
    // A wall, a 404 or a body that is not data answers before any body read.
    if (gateObserved(status, mime, env.doc.read.transport.parseableMime).kind !== 'data') {
      return { route, decoded: null, read: this.reader.read(route.kind, { text: '', status, mime }, ctx) };
    }
    const decoded = decodeBody(await resp.getBody(), env.doc.read.transport);
    return { route, decoded, read: this.reader.read(route.kind, { decoded, status, mime }, ctx) };
  }
}
