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

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { WebContents } from 'electron';
import { SURFACE } from '@/adapter/ig-surface';
import { isProbeApiUrl } from '@/probe/native-traffic';
import { NetworkTrace } from '@/probe/network-trace';
import { inlineRequestData } from '@/probe/request-data';
import { gateObserved } from '@/surface/read/gate';
import { decodeBody } from '@/surface/transport/decode';
import { TAB } from '@/timing/config';
import { TIMED_OUT, withTimeout } from '@/timing/primitives';

export interface Exchange {
  n: number;
  /** CDP identity, retained even when a redirect reuses it for another exchange. */
  requestId: string;
  url: string;
  startedAt: number;
  sessionId: string;
  resourceType?: string;
  frameId?: string;
  loaderId?: string;
  postDataSource?: 'postData' | 'postDataEntries' | 'getter';
  postSha256?: string;
  hasPostData?: boolean;
  captureErrors?: string[];
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
  transportError?: string;
  canceled?: boolean;
}

/** Request headers whose VALUE is a session secret: recorded as present only. */
const SECRET_HEADERS = /^(?:cookie|x-csrftoken|x-ig-www-claim|x-fb-lsd|x-web-session-id|x-mid|authorization|x-ig-set-www-claim)$/;
/** Form fields worth keeping verbatim; every other key is listed by name only. */
const FORM_KEEP = /^(?:doc_id|fb_api_req_friendly_name|fb_api_caller_class|variables|server_timestamps|query_hash)$/;

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
  readonly trace: NetworkTrace;
  private readonly byId = new Map<string, Exchange>();
  private readonly t0 = Date.now();
  private step = 'start';
  private readonly bodies: string;
  private readonly pending = new Set<Promise<void>>();
  private readonly listener = (_e: unknown, method: string, params: unknown, sessionId?: string): void => {
    const task = this.onMessage(method, params as Record<string, unknown>, sessionId ?? '')
      .catch((error: unknown) => this.onFailure?.({ step: this.step, detail: String(error) }))
      .finally(() => this.pending.delete(task));
    this.pending.add(task);
  };

  constructor(
    private readonly wc: WebContents,
    out: string,
    private readonly onFailure?: (failure: { step: string; detail: string; exchange?: number }) => void,
    private readonly independentTransport = false,
  ) {
    this.trace = new NetworkTrace(wc);
    this.bodies = path.join(out, 'bodies');
    mkdirSync(this.bodies, { recursive: true });
  }

  start(): void {
    this.trace.start();
    this.wc.debugger.on('message', this.listener);
  }

  stop(): void {
    this.trace.stop();
    this.wc.debugger.off('message', this.listener);
  }

  /** Stop first, then retain every body already requested; CDP reads have the tab's bounded deadline. */
  async drain(): Promise<void> {
    await Promise.all([...this.pending]);
    for (const ex of this.exchanges) {
      if (!this.independentTransport && ex.failed === undefined && (ex.status === undefined || ex.body === undefined)) {
        this.fail(ex, 'incomplete exchange at recorder stop');
      }
    }
    this.byId.clear();
  }

  private fail(ex: Exchange, detail: string): void {
    if (ex.failed !== undefined) return;
    ex.failed = detail;
    this.onFailure?.({ step: ex.step, detail, exchange: ex.n });
  }

  private captureFailure(ex: Exchange, detail: string): void {
    ex.captureErrors ??= [];
    ex.captureErrors.push(detail);
    // An independent session observer must resolve the missing evidence before qualification.
    // Without it, preserve the standalone recorder's strict failure behavior.
    if (!this.independentTransport) this.fail(ex, detail);
  }

  private async command<T>(method: string, ex: Exchange): Promise<T> {
    const fields = { method, requestId: ex.requestId, sessionId: ex.sessionId, exchange: ex.n };
    this.trace.add('command-issued', fields);
    try {
      const sent = ex.sessionId === '' ? this.wc.debugger.sendCommand(method, { requestId: ex.requestId })
        : this.wc.debugger.sendCommand(method, { requestId: ex.requestId }, ex.sessionId);
      const result = await withTimeout(sent as Promise<T>, TAB.GET_BODY_TIMEOUT_MS);
      if (result === TIMED_OUT) throw new Error(`${method}: timed out`);
      this.trace.add('command-resolved', fields);
      return result;
    } catch (error) {
      this.trace.add('command-rejected', { ...fields, error: String(error) });
      throw error;
    }
  }

  setStep(step: string): void {
    this.step = step;
  }

  private async onMessage(method: string, p: Record<string, unknown>, sessionId: string): Promise<void> {
    this.trace.message(method, p, sessionId);
    const id = String(p.requestId ?? '');
    const key = JSON.stringify([sessionId, id]);
    if (method === 'Network.requestWillBeSent') {
      const req = p.request as { url: string; method: string; headers?: Record<string, string>; postData?: string;
        hasPostData?: boolean; postDataEntries?: Array<{ bytes?: string }> };
      let url: URL;
      try {
        url = new URL(req.url);
      } catch {
        return;
      }
      if (!isProbeApiUrl(req.url)) return;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers ?? {})) {
        const key = k.toLowerCase();
        if (!key.startsWith('x-') && key !== 'content-type') continue;
        headers[key] = SECRET_HEADERS.test(key) ? '<present>' : String(v);
      }
      const ex: Exchange = {
        n: this.exchanges.length + 1,
        requestId: id,
        url: req.url,
        startedAt: typeof p.wallTime === 'number' ? p.wallTime * 1000 : Date.now(),
        sessionId,
        resourceType: p.type as string | undefined,
        frameId: p.frameId as string | undefined,
        loaderId: p.loaderId as string | undefined,
        at: Date.now() - this.t0,
        step: this.step,
        method: req.method,
        hasPostData: req.hasPostData === true || req.postData !== undefined || req.postDataEntries !== undefined,
        host: url.hostname,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers,
        epoKind: SURFACE.matchEndpoint(req.url, headers['x-fb-friendly-name']) ?? null,
      };
      // Publish before asynchronous POST metadata: response events can arrive during that CDP await.
      this.exchanges.push(ex);
      this.byId.set(key, ex);
      const inline = inlineRequestData(req);
      let post = inline?.value;
      ex.postDataSource = inline?.source;
      if (post === undefined && req.hasPostData === true) {
        post = await this.command<{ postData: string }>('Network.getRequestPostData', ex)
          .then((r) => r.postData, (error: unknown) => { this.captureFailure(ex, `request metadata: ${String(error)}`); return undefined; });
        if (post !== undefined) ex.postDataSource = 'getter';
      }
      if (post !== undefined) {
        ex.postSha256 = createHash('sha256').update(post).digest('hex');
        Object.assign(ex, formOf(post));
        ex.epoKind = SURFACE.matchEndpoint(req.url, headers['x-fb-friendly-name'] ?? ex.form?.fb_api_req_friendly_name);
      }
      return;
    }
    const ex = this.byId.get(key);
    if (ex === undefined) return;
    if (method === 'Network.responseReceived') {
      const res = p.response as { status: number; mimeType: string };
      ex.status = res.status;
      ex.mime = res.mimeType;
      if (gateObserved(res.status, res.mimeType, SURFACE.transport.parseableMime).kind !== 'data') {
        this.fail(ex, `unsafe API response: ${res.status} ${res.mimeType}`);
      }
    } else if (method === 'Network.loadingFailed') {
      ex.transportError = String(p.errorText ?? 'failed');
      ex.canceled = p.canceled === true;
      if (!this.independentTransport || !ex.canceled || ex.transportError !== 'net::ERR_ABORTED') this.fail(ex, ex.transportError);
      this.byId.delete(key);
    } else if (method === 'Network.loadingFinished') {
      this.byId.delete(key);
      const got = await this.command<{ body: string; base64Encoded: boolean }>('Network.getResponseBody', ex)
        .then(
          (r: { body: string; base64Encoded: boolean }) =>
            r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body,
          (e: unknown) => {
            this.captureFailure(ex, `body: ${String(e)}`);
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
