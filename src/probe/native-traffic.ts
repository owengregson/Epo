/** Probe-only session inventory. Native request ownership survives the initiating frame's teardown. */
import { createHash } from 'node:crypto';
import type { BeforeSendResponse, CallbackResponse, HeadersReceivedResponse, OnBeforeRedirectListenerDetails,
  OnBeforeRequestListenerDetails, OnBeforeSendHeadersListenerDetails, OnCompletedListenerDetails,
  OnErrorOccurredListenerDetails, OnHeadersReceivedListenerDetails, UploadData, WebContents } from 'electron';
import { SURFACE } from '@/adapter/ig-surface';
import { SURFACE_BOUNDS } from '@/kernel/surface-policy';
import { gateObserved } from '@/surface/read/gate';
import { TAB } from '@/timing/config';
import { TIMED_OUT, withTimeout } from '@/timing/primitives';

export interface NativePost {
  state: 'none' | 'pending' | 'complete' | 'missing' | 'unsupported' | 'failed';
  bytes?: number;
  sha256?: string;
  detail?: string;
}

export interface NativeExchange {
  id: number;
  url: string;
  method: string;
  resourceType: string;
  /** Null means initial ownership was unavailable; such an entry can never qualify. */
  webContentsId: number | null;
  startedAt: number;
  responseAt?: number;
  endedAt?: number;
  headers: Record<string, string>;
  status?: number;
  mime?: string;
  terminal?: 'completed' | 'aborted' | 'failed';
  error?: string;
  failed?: string;
  redirect?: { url: string; status: number; at: number };
  post: NativePost;
}

/** API paths on the declared site's host family; suffix lookalikes and other protocols/ports are excluded. */
export function isProbeApiUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    const origin = new URL(SURFACE.origin);
    const host = origin.hostname.replace(/^www\./, '');
    return url.protocol === origin.protocol && url.port === origin.port
      && (url.hostname === host || url.hostname.endsWith(`.${host}`))
      && /^\/(?:api\/|graphql|ajax\/(?!bz|bulk-route))/.test(url.pathname);
  } catch { return false; }
}

export class NativeTraffic {
  readonly exchanges: NativeExchange[] = [];
  private readonly byId = new Map<number, NativeExchange>();
  private readonly raw = new Map<number, string>();
  private readonly reused = new Set<number>();
  private readonly pending = new Set<Promise<void>>();
  private readonly changed = new Set<(stopped?: boolean) => void>();
  private active = false;

  constructor(private readonly wc: WebContents, private readonly onFailure?: (failure: { id: number; detail: string }) => void) {}

  start(): void {
    if (this.active) return;
    this.active = true;
    const web = this.wc.session.webRequest;
    web.onBeforeRequest(this.before);
    web.onBeforeSendHeaders(this.headers);
    web.onHeadersReceived(this.response);
    web.onBeforeRedirect(this.redirect);
    web.onCompleted(this.completed);
    web.onErrorOccurred(this.errored);
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    const web = this.wc.session.webRequest;
    web.onBeforeRequest(null);
    web.onBeforeSendHeaders(null);
    web.onHeadersReceived(null);
    web.onBeforeRedirect(null);
    web.onCompleted(null);
    web.onErrorOccurred(null);
    for (const notify of this.changed) notify(true);
  }

  /** No network work: observe terminal events until the existing body deadline, including new starts. */
  settle(): Promise<boolean> {
    if (!this.active) return Promise.resolve(false);
    return new Promise((resolve) => {
      const done = (value: boolean): void => { clearTimeout(timer); this.changed.delete(check); resolve(value); };
      const check = (stopped = false): void => {
        if (stopped) done(false);
        else if (this.exchanges.every((ex) => ex.terminal !== undefined)) done(true);
      };
      const timer = setTimeout(() => done(false), TAB.GET_BODY_TIMEOUT_MS);
      this.changed.add(check);
      check();
    });
  }

  /** Stop first. Only already-started, deadline-bounded upload reads remain; unresolved requests stay unresolved. */
  async drain(): Promise<void> { await Promise.all([...this.pending]); }

  /** Never serialized; ambiguous reused IDs and non-UTF8 payloads have no text fallback. */
  getPostData(id: number): string | undefined { return this.reused.has(id) ? undefined : this.raw.get(id); }

  private fail(ex: NativeExchange, detail: string): void {
    if (ex.failed !== undefined) return;
    ex.failed = detail;
    this.onFailure?.({ id: ex.id, detail });
  }

  private notify(): void { for (const notify of this.changed) notify(); }

  private readonly before = (d: OnBeforeRequestListenerDetails, callback: (response: CallbackResponse) => void): void => {
    let ex: NativeExchange | undefined;
    let prior: NativeExchange | undefined;
    const owner = typeof d.webContentsId === 'number' && Number.isSafeInteger(d.webContentsId) && d.webContentsId > 0
      ? d.webContentsId : null;
    if ((owner === this.wc.id || owner === null) && isProbeApiUrl(d.url)) {
      ex = { id: d.id, url: d.url, method: d.method, resourceType: d.resourceType,
        webContentsId: owner, startedAt: d.timestamp, headers: {}, post: { state: 'pending' } };
      prior = this.byId.get(d.id);
      this.exchanges.push(ex);
      this.byId.set(d.id, ex);
    }
    callback({}); // No await, payload decoding or blob lookup holds the request.
    if (ex === undefined) return;
    if (prior !== undefined) {
      this.reused.add(d.id);
      this.fail(prior, 'native request id reused');
      this.fail(ex, 'native request id reused');
    }
    if (owner === null) {
      ex.post = { state: 'missing', detail: 'initial request ownership unavailable' };
      this.fail(ex, 'native request owner unavailable');
      this.notify();
      return;
    }
    const task = this.readPost(ex, d.uploadData).finally(() => this.pending.delete(task));
    this.pending.add(task);
    this.notify();
  };

  private readonly headers = (d: OnBeforeSendHeadersListenerDetails, callback: (response: BeforeSendResponse) => void): void => {
    callback({});
    const ex = this.byId.get(d.id);
    if (ex === undefined) return;
    for (const [key, value] of Object.entries(d.requestHeaders)) {
      const name = key.toLowerCase();
      if (name === 'x-fb-friendly-name' || name === 'content-type') ex.headers[name] = String(value);
    }
  };

  private responseMeta(ex: NativeExchange, d: { timestamp: number; statusCode: number; responseHeaders?: Record<string, string[]> }): void {
    ex.responseAt ??= d.timestamp;
    ex.status = d.statusCode;
    const contentType = Object.entries(d.responseHeaders ?? {}).find(([name]) => name.toLowerCase() === 'content-type')?.[1]?.[0];
    ex.mime = contentType ?? ex.mime ?? '';
    if (gateObserved(ex.status, ex.mime, SURFACE.transport.parseableMime).kind !== 'data') {
      this.fail(ex, `unsafe native API response: ${ex.status} ${ex.mime}`);
    }
  }

  private readonly response = (d: OnHeadersReceivedListenerDetails, callback: (response: HeadersReceivedResponse) => void): void => {
    callback({});
    const ex = this.byId.get(d.id);
    if (ex !== undefined) this.responseMeta(ex, d);
  };

  private readonly redirect = (d: OnBeforeRedirectListenerDetails): void => {
    const ex = this.byId.get(d.id);
    if (ex === undefined) return;
    ex.redirect = { url: d.redirectURL, status: d.statusCode, at: d.timestamp };
    this.responseMeta(ex, d);
  };

  private readonly completed = (d: OnCompletedListenerDetails): void => {
    const ex = this.byId.get(d.id);
    if (ex === undefined) return;
    this.responseMeta(ex, d);
    ex.endedAt = d.timestamp;
    ex.error = d.error;
    ex.terminal = 'completed';
    if (d.error && d.error !== 'net::OK') { ex.terminal = 'failed'; this.fail(ex, d.error); }
    this.notify();
  };

  private readonly errored = (d: OnErrorOccurredListenerDetails): void => {
    const ex = this.byId.get(d.id);
    if (ex === undefined) return;
    ex.endedAt = d.timestamp;
    ex.error = d.error;
    ex.terminal = d.error === 'net::ERR_ABORTED' ? 'aborted' : 'failed';
    if (ex.terminal === 'failed') this.fail(ex, d.error);
    this.notify();
  };

  private async readPost(ex: NativeExchange, parts: UploadData[] | undefined): Promise<void> {
    if (parts === undefined) { ex.post = { state: 'missing', detail: 'uploadData absent' }; return; }
    if (parts.length === 0) { ex.post = { state: 'none' }; return; }
    if (parts.some((part) => part.file !== undefined || (!Buffer.isBuffer(part.bytes) && !part.blobUUID))) {
      ex.post = { state: 'unsupported', detail: 'upload part is not bytes or a blob' }; return;
    }
    try {
      const inlineBytes = parts.reduce((total, part) => total + (Buffer.isBuffer(part.bytes) ? part.bytes.length : 0), 0);
      if (inlineBytes > SURFACE_BOUNDS.requestBodyMaxBytes) throw new Error('native upload exceeds capture cap');
      const buffers = await withTimeout(Promise.all(parts.map((part) => {
        if (Buffer.isBuffer(part.bytes)) return Promise.resolve(Buffer.from(part.bytes));
        if (part.blobUUID) return this.wc.session.getBlobData(part.blobUUID);
        return Promise.reject(new Error('native upload part unavailable'));
      })), TAB.GET_BODY_TIMEOUT_MS);
      if (buffers === TIMED_OUT) throw new Error('native upload read timed out');
      const bytes = buffers.reduce((total, buffer) => total + buffer.length, 0);
      if (bytes > SURFACE_BOUNDS.requestBodyMaxBytes) throw new Error('native upload exceeds capture cap');
      const body = Buffer.concat(buffers);
      ex.post = { state: 'complete', bytes, sha256: createHash('sha256').update(body).digest('hex') };
      try { this.raw.set(ex.id, new TextDecoder('utf-8', { fatal: true }).decode(body)); }
      catch { ex.post.detail = 'upload is not UTF-8 text'; }
    } catch (error) { ex.post = { state: 'failed', detail: String(error) }; }
  }
}
