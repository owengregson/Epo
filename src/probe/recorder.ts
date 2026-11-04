/**
 * Probe-only CDP recorder: every API exchange INSTAGRAM'S OWN CLIENT makes
 * while the probe browses — method, path, query, the `x-*` headers it sent
 * (session secrets as `<present>`), the GraphQL operation (`doc_id`, friendly
 * name, variables; tokens elided), status, mime, and the body's SHAPE. Full
 * bodies go to `<out>/bodies/` (outside the repo; they hold account data).
 *
 * Listens on the tab's already-attached debugger beside the tab's own
 * listener, so production code is untouched and nothing extra is requested.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { WebContents } from 'electron';
import { SURFACE } from '@/adapter/ig-surface';
import { gateObserved } from '@/surface/read/gate';
import { decodeBody } from '@/surface/transport/decode';
import { TAB } from '@/timing/config';
import { TIMED_OUT, withTimeout } from '@/timing/primitives';

export interface Exchange {
  n: number;
  /** Ms since the recorder started. */
  at: number;
  /** The browse step that was running when the request left. */
  step: string;
  method: string;
  host: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  form?: Record<string, string>;
  formKeys?: string[];
  /** The production endpoint kind this exchange routes to today, if any. */
  epoKind: string | null;
  status?: number;
  mime?: string;
  shape?: unknown;
  /** How the body was framed (plain, guarded, streamed, multipart), as the production decoder read it. */
  format?: string;
  /** The streaming final flag, when the body carried one. */
  final?: boolean | null;
  textHead?: string;
  body?: string;
  failed?: string;
}

/** Request headers whose VALUE is a session secret: recorded as present only. */
const SECRET_HEADERS = /^(?:cookie|x-csrftoken|x-ig-www-claim|x-fb-lsd|x-web-session-id|x-mid|authorization|x-ig-set-www-claim)$/;
/** Form fields worth keeping verbatim; every other key is listed by name only. */
const FORM_KEEP = /^(?:doc_id|fb_api_req_friendly_name|fb_api_caller_class|variables|server_timestamps|query_hash)$/;
/** Only API traffic — page documents, static assets and logging are noise here. */
const API_PATH = /^\/(?:api\/|graphql|ajax\/(?!bz|bulk-route))/;

function shapeOf(v: unknown, depth = 0): unknown {
  if (Array.isArray(v)) return v.length === 0 ? [] : [`len ${v.length}`, shapeOf(v[0], depth + 1)];
  if (v !== null && typeof v === 'object') {
    if (depth >= 6) return '{…}';
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shapeOf(x, depth + 1)]));
  }
  return v === null ? null : typeof v;
}


function formOf(raw: string): { form: Record<string, string>; formKeys: string[] } {
  const form: Record<string, string> = {};
  const formKeys: string[] = [];
  const params = new URLSearchParams(raw);
  for (const [k, v] of params) {
    formKeys.push(k);
    if (FORM_KEEP.test(k)) form[k] = v;
  }
  return { form, formKeys };
}

export class TrafficRecorder {
  readonly exchanges: Exchange[] = [];
  private readonly byId = new Map<string, Exchange>();
  private readonly t0 = Date.now();
  private step = 'start';
  private readonly bodies: string;
  private readonly pending = new Set<Promise<void>>();
  private readonly listener = (_e: unknown, method: string, params: unknown): void => {
    const task = this.onMessage(method, params as Record<string, unknown>)
      .catch((error: unknown) => this.onFailure?.({ step: this.step, detail: String(error) }))
      .finally(() => this.pending.delete(task));
    this.pending.add(task);
  };

  constructor(
    private readonly wc: WebContents,
    out: string,
    private readonly onFailure?: (failure: { step: string; detail: string; exchange?: number }) => void,
  ) {
    this.bodies = path.join(out, 'bodies');
    mkdirSync(this.bodies, { recursive: true });
  }

  start(): void {
    this.wc.debugger.on('message', this.listener);
  }

  stop(): void {
    this.wc.debugger.off('message', this.listener);
  }

  /** Stop first, then retain every body already requested; CDP reads have the tab's bounded deadline. */
  async drain(): Promise<void> {
    await Promise.all([...this.pending]);
    for (const ex of this.byId.values()) this.fail(ex, 'incomplete exchange at recorder stop');
    this.byId.clear();
  }

  private fail(ex: Exchange, detail: string): void {
    ex.failed = detail;
    this.onFailure?.({ step: ex.step, detail, exchange: ex.n });
  }

  private async command<T>(method: string, requestId: string): Promise<T> {
    const result = await withTimeout(this.wc.debugger.sendCommand(method, { requestId }) as Promise<T>, TAB.GET_BODY_TIMEOUT_MS);
    if (result === TIMED_OUT) throw new Error(`${method}: timed out`);
    return result;
  }

  setStep(step: string): void {
    this.step = step;
  }

  private async onMessage(method: string, p: Record<string, unknown>): Promise<void> {
    const id = String(p.requestId ?? '');
    if (method === 'Network.requestWillBeSent') {
      const req = p.request as { url: string; method: string; headers?: Record<string, string>; postData?: string; hasPostData?: boolean };
      let url: URL;
      try {
        url = new URL(req.url);
      } catch {
        return;
      }
      if (!url.hostname.endsWith('instagram.com') || !API_PATH.test(url.pathname)) return;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers ?? {})) {
        const key = k.toLowerCase();
        if (!key.startsWith('x-') && key !== 'content-type') continue;
        headers[key] = SECRET_HEADERS.test(key) ? '<present>' : String(v);
      }
      const ex: Exchange = {
        n: this.exchanges.length + 1,
        at: Date.now() - this.t0,
        step: this.step,
        method: req.method,
        host: url.hostname,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers,
        epoKind: SURFACE.matchEndpoint(req.url, headers['x-fb-friendly-name']) ?? null,
      };
      // Publish before asynchronous POST metadata: response events can arrive during that CDP await.
      this.exchanges.push(ex);
      this.byId.set(id, ex);
      let post = req.postData;
      if (post === undefined && req.hasPostData === true) {
        post = await this.command<{ postData: string }>('Network.getRequestPostData', id)
          .then((r) => r.postData, (error: unknown) => { this.fail(ex, `request metadata: ${String(error)}`); return undefined; });
      }
      if (post !== undefined) Object.assign(ex, formOf(post));
      return;
    }
    const ex = this.byId.get(id);
    if (ex === undefined) return;
    if (method === 'Network.responseReceived') {
      const res = p.response as { status: number; mimeType: string };
      ex.status = res.status;
      ex.mime = res.mimeType;
      if (gateObserved(res.status, res.mimeType, SURFACE.transport.parseableMime).kind !== 'data') {
        this.fail(ex, `unsafe API response: ${res.status} ${res.mimeType}`);
      }
    } else if (method === 'Network.loadingFailed') {
      this.fail(ex, String(p.errorText ?? 'failed'));
      this.byId.delete(id);
    } else if (method === 'Network.loadingFinished') {
      this.byId.delete(id);
      const got = await this.command<{ body: string; base64Encoded: boolean }>('Network.getResponseBody', id)
        .then(
          (r: { body: string; base64Encoded: boolean }) =>
            r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body,
          (e: unknown) => {
            this.fail(ex, `body: ${String(e)}`);
            return null;
          },
        );
      if (got === null) return;
      // The production decoder: a guarded, streamed or multipart body reads exactly as Epo reads it.
      const decoded = decodeBody(got, SURFACE.transport);
      if (!decoded.ok) {
        ex.textHead = got.slice(0, 300);
        this.fail(ex, 'API body was not decodable data');
        return;
      }
      const json = decoded.json;
      ex.format = decoded.format;
      ex.final = decoded.final;
      ex.shape = shapeOf(json);
      ex.body = `${String(ex.n).padStart(3, '0')}-${ex.path.replace(/[^a-z0-9]+/gi, '_').slice(0, 60)}.json`;
      writeFileSync(path.join(this.bodies, ex.body), JSON.stringify(json, null, 2), 'utf8');
    }
  }
}
