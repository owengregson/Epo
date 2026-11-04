/** Passive, probe-only lifecycle evidence. No payloads, cookies or header values are copied here. */
import type { WebContents } from 'electron';

export interface NetworkTraceEntry { at: number; wallTimeMs: number; event: string; [key: string]: unknown }

function route(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  try { const url = new URL(raw); return `${url.origin}${url.pathname}`; }
  catch { return undefined; }
}

function frameIdentity(value: unknown): Record<string, unknown> {
  try {
    const frame = value as { processId: number; routingId: number } | null | undefined;
    return { frameProcessId: frame?.processId, frameRoutingId: frame?.routingId };
  } catch (error) { return { frameUnavailable: String(error) }; }
}

export class NetworkTrace {
  readonly events: NetworkTraceEntry[] = [];
  private readonly t0 = Date.now();
  private readonly navigationStart = (details: unknown): void => {
    const p = details as Record<string, unknown>;
    this.add('navigation-start', { route: route(p.url), isMainFrame: p.isMainFrame,
      isSameDocument: p.isSameDocument, ...frameIdentity(p.frame) });
  };
  private readonly navigationDone = (_e: unknown, url: string, status: number, _text: string,
    isMainFrame: boolean, frameProcessId: number, frameRoutingId: number): void => {
    this.add('navigation-committed', { route: route(url), status, isMainFrame, frameProcessId, frameRoutingId });
  };
  private readonly detached = (_e: unknown, reason: string): void => { this.add('debugger-detached', { reason }); };
  private readonly processGone = (_e: unknown, details: { reason: string; exitCode: number }): void => {
    this.add('renderer-gone', { reason: details.reason, exitCode: details.exitCode });
  };

  constructor(private readonly wc: WebContents) {}

  start(): void {
    this.wc.on('did-start-navigation', this.navigationStart);
    this.wc.on('did-frame-navigate', this.navigationDone);
    this.wc.on('render-process-gone', this.processGone);
    this.wc.debugger.on('detach', this.detached);
  }

  stop(): void {
    this.wc.off('did-start-navigation', this.navigationStart);
    this.wc.off('did-frame-navigate', this.navigationDone);
    this.wc.off('render-process-gone', this.processGone);
    this.wc.debugger.off('detach', this.detached);
  }

  add(event: string, fields: Record<string, unknown>): void {
    const now = Date.now();
    this.events.push({ at: now - this.t0, wallTimeMs: now, event, ...fields });
  }

  message(method: string, p: Record<string, unknown>, sessionId?: string): void {
    if (!['Network.requestWillBeSent', 'Network.responseReceived', 'Network.loadingFinished',
      'Network.loadingFailed', 'Network.responseReceivedExtraInfo'].includes(method)) return;
    const req = p.request as { url?: string; hasPostData?: boolean; postData?: string;
      postDataEntries?: Array<{ bytes?: string }> } | undefined;
    const res = p.response as { url?: string; status?: number; mimeType?: string; fromServiceWorker?: boolean } | undefined;
    this.add(method, { requestId: p.requestId, sessionId: sessionId ?? '', timestamp: p.timestamp,
      wallTime: p.wallTime, frameId: p.frameId, loaderId: p.loaderId, type: p.type,
      route: route(req?.url ?? res?.url), hasPostData: req?.hasPostData,
      inlinePostBytes: req?.postData === undefined ? undefined : Buffer.byteLength(req.postData),
      entryBytes: req?.postDataEntries?.map((entry) => entry.bytes === undefined ? null : Buffer.from(entry.bytes, 'base64').length),
      status: res?.status ?? p.statusCode, mime: res?.mimeType, fromServiceWorker: res?.fromServiceWorker,
      redirectStatus: (p.redirectResponse as { status?: number } | undefined)?.status,
      errorText: p.errorText, canceled: p.canceled, blockedReason: p.blockedReason,
      encodedDataLength: p.encodedDataLength });
  }
}
