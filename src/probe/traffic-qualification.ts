/** Reconcile independent native transport with CDP bodies; missing events never imply success or cancellation. */
import { SURFACE } from '@/adapter/ig-surface';
import type { NativeExchange } from '@/probe/native-traffic';
import type { NetworkTraceEntry } from '@/probe/network-trace';
import type { Exchange } from '@/probe/recorder';
import { gateObserved } from '@/surface/read/gate';
import { HARNESS } from '@/timing/config';

export interface QualifiedExchange {
  nativeId: number;
  cdpExchange?: number;
  kind: string | null;
  outcome: 'complete' | 'navigation-canceled' | 'unqualified';
  body: 'captured' | 'unavailable';
  metadata: 'native' | 'cdp' | 'none' | 'unavailable';
  errors: string[];
}

function normalizedUrl(raw: string): string {
  const url = new URL(raw); url.hash = ''; return url.href;
}

function matches(cdp: Exchange, native: NativeExchange): boolean {
  return cdp.method === native.method && normalizedUrl(cdp.url) === normalizedUrl(native.url)
    && Math.abs(cdp.startedAt - native.startedAt) <= HARNESS.CAPTURE_EVENT_SKEW_MS
    && (cdp.postSha256 === undefined || native.post.sha256 === undefined || cdp.postSha256 === native.post.sha256);
}

function duringNavigation(native: NativeExchange, trace: readonly NetworkTraceEntry[]): boolean {
  if (native.endedAt === undefined) return false;
  const endedAt = native.endedAt;
  const slack = HARNESS.CAPTURE_EVENT_SKEW_MS;
  return trace.some((start, index) => {
    if (start.event !== 'navigation-start' || start.isMainFrame !== true || start.isSameDocument === true) return false;
    const prior = trace.slice(0, index).some((entry) => entry.event === 'navigation-committed' && entry.isMainFrame === true);
    const commit = trace.slice(index + 1).find((entry) => entry.event === 'navigation-committed' && entry.isMainFrame === true);
    return prior && commit !== undefined && native.startedAt <= commit.wallTimeMs && start.wallTimeMs + slack >= native.startedAt
      && endedAt >= start.wallTimeMs - slack && endedAt <= commit.wallTimeMs + slack;
  });
}

export function qualifyTraffic(
  cdp: readonly Exchange[], native: readonly NativeExchange[], trace: readonly NetworkTraceEntry[],
  getPostData: (id: number) => string | undefined,
): { ok: boolean; exchanges: QualifiedExchange[]; errors: string[] } {
  const errors: string[] = [];
  // Reciprocal uniqueness over the complete trace, never greedy time/order matching.
  const choices = new Map(cdp.map((ex) => [ex, native.filter((candidate) => matches(ex, candidate))]));
  const inverse = new Map(native.map((ex) => [ex, cdp.filter((candidate) => choices.get(candidate)?.includes(ex))]));
  for (const ex of cdp) {
    const candidates = choices.get(ex) ?? [];
    if (candidates.length !== 1 || inverse.get(candidates[0])?.length !== 1) errors.push(`CDP exchange ${ex.n}: missing or ambiguous native association`);
    if (ex.failed !== undefined) errors.push(`CDP exchange ${ex.n}: ${ex.failed}`);
  }
  const exchanges = native.map((ex): QualifiedExchange => {
    const candidates = inverse.get(ex) ?? [];
    const observed = candidates.length === 1 && choices.get(candidates[0])?.length === 1 ? candidates[0] : undefined;
    const issues: string[] = [];
    if (candidates.length > 0 && observed === undefined) issues.push('ambiguous CDP association');
    const post = getPostData(ex.id);
    const form = post === undefined ? undefined : new URLSearchParams(post);
    const friendly = ex.headers['x-fb-friendly-name'] ?? form?.get('fb_api_req_friendly_name')
      ?? observed?.headers['x-fb-friendly-name'] ?? observed?.form?.fb_api_req_friendly_name;
    const nativeKind = SURFACE.matchEndpoint(ex.url, friendly ?? undefined);
    const kind = observed?.epoKind ?? nativeKind;
    if (nativeKind !== null && observed?.epoKind != null && nativeKind !== observed.epoKind) issues.push('endpoint classification disagreement');
    const metadata = ex.post.state === 'none' ? 'none'
      : post !== undefined && ex.post.state === 'complete' ? 'native'
      : observed?.postSha256 !== undefined ? 'cdp' : 'unavailable';
    if (metadata === 'unavailable') issues.push('request metadata unavailable');
    if (ex.post.state === 'none' && observed?.postSha256 !== undefined) issues.push('request payload presence disagreement');
    if (ex.failed !== undefined) issues.push(ex.failed);
    if (ex.status !== undefined && gateObserved(ex.status, ex.mime ?? '', SURFACE.transport.parseableMime).kind !== 'data') issues.push('unsafe response');
    if (observed?.status !== undefined && ex.status !== undefined && observed.status !== ex.status) issues.push('native/CDP response status disagreement');
    // Every known Reader path needs its own body. Another body of that kind cannot cover this request.
    if (kind !== null && observed?.body === undefined) issues.push('required Reader body unavailable');
    if (kind !== null && observed?.captureErrors?.some((error) => error.startsWith('body:'))) issues.push('required Reader body capture failed');
    let outcome: QualifiedExchange['outcome'] = 'unqualified';
    if (ex.terminal === 'completed' && ex.status !== undefined) outcome = 'complete';
    else if (ex.terminal === 'aborted' && ex.error === 'net::ERR_ABORTED' && kind === null && duringNavigation(ex, trace)) outcome = 'navigation-canceled';
    else issues.push(ex.terminal === 'aborted' ? 'cancellation not qualified by navigation and ancillary scope' : 'request has no successful native terminal');
    if (issues.length > 0) outcome = 'unqualified';
    for (const issue of issues) errors.push(`Native exchange ${ex.id}: ${issue}`);
    return { nativeId: ex.id, cdpExchange: observed?.n, kind, outcome,
      body: observed?.body === undefined ? 'unavailable' : 'captured', metadata, errors: issues };
  });
  return { ok: errors.length === 0, exchanges, errors };
}
