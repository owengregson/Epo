import type { NativeExchange } from '@/probe/native-traffic';
import type { NetworkTraceEntry } from '@/probe/network-trace';
import type { Exchange } from '@/probe/recorder';
import { qualifyTraffic } from '@/probe/traffic-qualification';

const url = 'https://www.instagram.com/api/graphql';
const cdp = (overrides: Partial<Exchange> = {}): Exchange => ({ n: 1, requestId: 'r1', sessionId: '', url,
  startedAt: 1000, at: 0, step: 'home', method: 'POST', host: 'www.instagram.com', path: '/api/graphql',
  query: {}, headers: {}, epoKind: null, status: 200, mime: 'application/json', body: 'body.json', ...overrides });
const native = (overrides: Partial<NativeExchange> = {}): NativeExchange => ({ id: 1, url, method: 'POST',
  resourceType: 'xhr', webContentsId: 1, startedAt: 1000, endedAt: 2000, headers: {}, status: 200,
  mime: 'application/json', terminal: 'completed', post: { state: 'none' }, ...overrides });
const navigation: NetworkTraceEntry[] = [
  { at: 0, wallTimeMs: 500, event: 'navigation-committed', isMainFrame: true },
  { at: 0, wallTimeMs: 1800, event: 'navigation-start', isMainFrame: true, isSameDocument: false },
  { at: 100, wallTimeMs: 1900, event: 'navigation-committed', isMainFrame: true },
];
const qualify = (cdps: Exchange[], natives: NativeExchange[], trace = navigation, post?: string) =>
  qualifyTraffic(cdps, natives, trace, () => post);

test('a native-completed auxiliary response can have explicitly unavailable CDP body evidence', () => {
  const result = qualify([cdp({ body: undefined, captureErrors: ['body: resource gone'] })], [native()]);
  expect(result).toMatchObject({ ok: true, exchanges: [{ outcome: 'complete', body: 'unavailable' }] });
});

test('native-only auxiliary exchanges remain visible and require their own terminal', () => {
  expect(qualify([], [native()])).toMatchObject({ ok: true,
    exchanges: [{ nativeId: 1, cdpExchange: undefined, outcome: 'complete', body: 'unavailable' }] });
  expect(qualify([], [native({ terminal: undefined })]).ok).toBe(false);
});

test('an explicit native abort across observed navigation is separate from completed 2xx', () => {
  const result = qualify([cdp({ status: undefined, body: undefined })],
    [native({ status: undefined, terminal: 'aborted', error: 'net::ERR_ABORTED' })]);
  expect(result).toMatchObject({ ok: true, exchanges: [{ outcome: 'navigation-canceled', body: 'unavailable' }] });
});

test.each([
  { terminal: undefined },
  { terminal: 'failed', error: 'net::ERR_CONNECTION_RESET' },
  { terminal: 'aborted', error: 'net::ERR_CONNECTION_RESET' },
] as Partial<NativeExchange>[])('missing/error terminals cannot be inferred as navigation cancellation (%j)', (overrides) => {
  expect(qualify([cdp()], [native(overrides)]).ok).toBe(false);
});

test('an abort without an observed main-frame navigation cannot qualify', () => {
  const aborted = native({ terminal: 'aborted', error: 'net::ERR_ABORTED' });
  expect(qualify([cdp()], [aborted], []).ok).toBe(false);
  expect(qualify([cdp()], [aborted], navigation.map((entry) => ({ ...entry, isMainFrame: false }))).ok).toBe(false);
});

test('initial navigation and a request started after navigation cannot qualify a later explicit abort', () => {
  const aborted = native({ terminal: 'aborted', error: 'net::ERR_ABORTED' });
  expect(qualify([cdp()], [aborted], navigation.slice(1)).ok).toBe(false);
  expect(qualify([cdp({ startedAt: 1950 })], [native({ ...aborted, startedAt: 1950 })]).ok).toBe(false);
});

test.each([429, 500])('an unsafe HTTP status stays failed when navigation later aborts it (%s)', (status) => {
  expect(qualify([cdp({ status })], [native({ status, terminal: 'aborted', error: 'net::ERR_ABORTED' })]).ok).toBe(false);
});

test('HTML and previously retained failures still fail with a 200 completion', () => {
  expect(qualify([cdp()], [native({ mime: 'text/html' })]).ok).toBe(false);
  expect(qualify([cdp()], [native({ failed: 'earlier unsafe response' })]).ok).toBe(false);
});

test('each known Reader request needs its own captured body, including native-only and canceled requests', () => {
  const headers = { 'x-fb-friendly-name': 'PolarisActivityFeedStoriesViewQuery' };
  const required = native({ headers });
  expect(qualify([cdp({ body: undefined })], [required]).ok).toBe(false);
  expect(qualify([], [required]).ok).toBe(false);
  expect(qualify([cdp({ body: undefined })], [native({ headers, terminal: 'aborted', error: 'net::ERR_ABORTED' })]).ok).toBe(false);
  expect(qualify([cdp()], [required]).ok).toBe(true);
});

test('metadata needs complete native text or captured CDP metadata; missing native data never supplies it', () => {
  expect(qualify([cdp()], [native({ post: { state: 'failed' } })]).ok).toBe(false);
  expect(qualify([cdp({ postSha256: 'hash' })], [native({ post: { state: 'failed' } })])).toMatchObject({ ok: true,
    exchanges: [{ metadata: 'cdp' }] });
  expect(qualify([cdp({ captureErrors: ['metadata unavailable'] })],
    [native({ post: { state: 'complete', sha256: 'hash' } })], navigation, 'doc_id=1')).toMatchObject({ ok: true,
    exchanges: [{ metadata: 'native' }] });
});

test('request payload and status contradictions fail', () => {
  expect(qualify([cdp({ postSha256: 'a' })], [native({ post: { state: 'complete', sha256: 'b' } })], navigation, 'body').ok).toBe(false);
  expect(qualify([cdp({ postSha256: 'a' })], [native()]).ok).toBe(false);
  expect(qualify([cdp({ status: 201 })], [native()]).ok).toBe(false);
  expect(qualify([cdp({ method: 'GET', hasPostData: true })], [native({ method: 'GET' })]).ok).toBe(false);
  expect(qualify([cdp({ method: 'GET', captureErrors: ['request metadata: getter failed'] })],
    [native({ method: 'GET' })]).ok).toBe(false);
});

test('identical concurrent candidates require reciprocal uniqueness, not a guessed ordering', () => {
  expect(qualify([cdp(), cdp({ n: 2, requestId: 'r2' })], [native(), native({ id: 2 })]).ok).toBe(false);
  expect(qualify([cdp()], [native(), native({ id: 2 })]).ok).toBe(false);
});

test('the same payload in later requests matches only within the event-clock tolerance', () => {
  expect(qualify([cdp(), cdp({ n: 2, requestId: 'r2', startedAt: 5000 })],
    [native(), native({ id: 2, startedAt: 5000 })]).ok).toBe(true);
  expect(qualify([cdp({ startedAt: 8000 })], [native()]).ok).toBe(false);
});

test('CDP requests without native ownership evidence remain unqualified', () => {
  expect(qualify([cdp()], []).ok).toBe(false);
});
