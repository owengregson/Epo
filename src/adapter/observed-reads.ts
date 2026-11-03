/**
 * One read per observed response (spec Appendix D.1): routed, gated, decoded and read ONCE, and the
 * result memoized per `TabResponse`, so every consumer of a body (the profile observer, the
 * relationship reconciler, a list scrape) shares one body read and one decode, and the sink counts it once.
 * While a context is armed, unrouted responses of its family are kept as references (never read) for
 * a deadline recovery (spec §10.6): zero cost while healthy.
 */

import { SURFACE_BOUNDS } from '@/kernel/surface-policy';
import type { TabResponse } from '@/shared/tab-response';
import { gateObserved } from '@/surface/read/gate';
import { type ObservedRequest, opFamilyOf, opNameOf } from '@/surface/read/route';
import type { Anchor, Arm, BodyInput, ReadCtx, ReadEnv, RouteMatch, SurfaceRead } from '@/surface/read/types';
import type { RecoveryRole } from '@/surface/recovery/hints';
import type { EndpointKind } from '@/surface/schema/endpoints';
import { type Decoded, decodeBody } from '@/surface/transport/decode';
import * as logger from '@/utils/logger';

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
  recover(kind: EndpointKind, decoded: Decoded, ctx: ReadCtx): SurfaceRead;
}

export interface ObservedReadsOpts {
  /** Whose session observes (I10): names a null relationship's owner when a body omits its own viewer. */
  readonly viewerPk?: string | null;
  /** The observation clock (default: the wall clock). */
  readonly now?: () => number;
}

/** An armed context's deadline candidates. */
export interface ArmedCandidates {
  /** Read the buffered candidates (newest first) under the anchor; the first recovered read, or null. */
  recover(anchor?: Anchor): Promise<SurfaceRead | null>;
  /** The operation names buffered so far (diagnostics for an unanswered wait). */
  ops(): readonly string[];
  dispose(): void;
}

/** The endpoint each arm's candidates are read as, and the role a recovered one is learned under. */
const FAMILY: Readonly<Record<Arm, { readonly kind: EndpointKind; readonly role: RecoveryRole } | null>> = {
  visit: { kind: 'profile-graphql', role: 'profile-user' }, drawer: { kind: 'activity-feed', role: 'feed-stories' },
  'requests-panel': { kind: 'friend-requests', role: 'request-rows' }, acquisition: null,
};

interface Armed { readonly arm: Arm; readonly kind: EndpointKind; readonly role: RecoveryRole; readonly refs: TabResponse[] }

export class ObservedReads {
  private readonly memo = new WeakMap<TabResponse, Promise<ObservedRead>>();
  private readonly armed = new Set<Armed>();

  constructor(
    private readonly reader: ObservedReader,
    private readonly opts: ObservedReadsOpts = {},
  ) {}

  /**
   * The response's read, shared by every caller; `null` when no definition routes it. `at` stamps the
   * read (the first caller's stamp wins; every production consumer shares one clock).
   */
  read(resp: TabResponse, at?: number): Promise<ObservedRead> | null {
    const known = this.memo.get(resp);
    if (known !== undefined) return known;
    const route = this.reader.route(resp);
    if (route === null) return null;
    const pending = this.readRouted(resp, route, at ?? this.now());
    this.memo.set(resp, pending);
    return pending;
  }

  /** Keep an unrouted response of an armed family as a deadline candidate (a reference; its body is never read here). */
  offer(resp: TabResponse): void {
    if (this.armed.size === 0 || this.reader.route(resp) !== null) return;
    const op = opNameOf(resp, this.reader.env.doc.read.transport);
    const kind = op === null ? null : opFamilyOf(op, this.reader.env.doc.read.recovery);
    for (const a of this.armed) {
      if (a.kind === kind && a.refs.length < SURFACE_BOUNDS.fallbackCandidates) a.refs.push(resp);
    }
  }

  /** Arm a context: unrouted responses of its family are kept until `recover()` reads them at its deadline. */
  arm(arm: Arm): ArmedCandidates {
    const family = FAMILY[arm];
    const entry: Armed = { arm, kind: family?.kind ?? 'followers-list', role: family?.role ?? 'source-rows', refs: [] };
    if (family !== null) this.armed.add(entry);
    const transport = this.reader.env.doc.read.transport;
    return {
      recover: async (anchor) => {
        for (const resp of [...entry.refs].reverse()) {
          const op = opNameOf(resp, transport);
          const defIndex = this.reader.env.doc.endpoints.findIndex((d) => d.kind === entry.kind && d.match.friendlyName !== undefined);
          let decoded: Decoded;
          try {
            decoded = decodeBody(await resp.getBody(), transport);
          } catch (e) {
            logger.info('adapter.observed-reads: a deadline candidate body is gone', { op, error: String(e) });
            continue;
          }
          const at = this.now();
          const route: RouteMatch = { kind: entry.kind, defIndex, via: 'candidate', op };
          const read = this.reader.recover(entry.kind, decoded, { at, route, arm, ...(anchor === undefined ? {} : { anchor }),
            viewerPk: this.opts.viewerPk ?? null });
          if (!read.ok) continue;
          // The operation that answered is learned (consistent after distinct witnessed subjects; never promoted).
          if (op !== null) {
            this.reader.env.sink.drift({ endpoint: entry.kind, cls: 'unrouted', path: op, detail: { op },
              hint: { role: entry.role, pattern: op, subject: anchor?.pk ?? null, agreed: true } }, at);
          }
          return read;
        }
        return null;
      },
      ops: () => entry.refs.map((r) => opNameOf(r, transport) ?? '(no operation name)'),
      dispose: () => {
        this.armed.delete(entry);
      },
    };
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private async readRouted(resp: TabResponse, route: RouteMatch, at: number): Promise<ObservedRead> {
    const { env } = this.reader;
    const subject = env.doc.endpoints[route.defIndex]?.match.ids?.pk?.exec(resp.url)?.[1];
    const ctx: ReadCtx = { at, route, viewerPk: this.opts.viewerPk ?? null, ...(subject === undefined ? {} : { pk: subject }) };
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
