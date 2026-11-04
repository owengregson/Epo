import { createHash } from 'node:crypto';
import type { WebContents } from 'electron';
import { SURFACE } from '@/adapter/ig-surface';
import { SURFACE_BOUNDS } from '@/kernel/surface-policy';
import { isProbeApiUrl, NativeTraffic } from '@/probe/native-traffic';
import { qualifyTraffic } from '@/probe/traffic-qualification';
import { TAB } from '@/timing/config';

const hooks = ['onBeforeRequest', 'onBeforeSendHeaders', 'onHeadersReceived', 'onBeforeRedirect', 'onCompleted', 'onErrorOccurred'] as const;

test('the native inventory includes declared-site subdomains without admitting suffix lookalikes or other ports', () => {
  expect(isProbeApiUrl('https://i.instagram.com/api/v1/example/')).toBe(true);
  expect(isProbeApiUrl('https://notinstagram.com/api/v1/example/')).toBe(false);
  expect(isProbeApiUrl('https://www.instagram.com.attacker.test/api/v1/example/')).toBe(false);
  expect(isProbeApiUrl('https://www.instagram.com:8443/api/v1/example/')).toBe(false);
});
type Hook = (...args: unknown[]) => void;
function harness(blob = async (_id: string): Promise<Buffer> => Buffer.from('blob-body')) {
  const listeners = new Map<string, Hook | null>();
  const webRequest = Object.fromEntries(hooks.map((name) => [name, jest.fn((listener: Hook | null) => listeners.set(name, listener))]));
  const getBlobData = jest.fn(blob);
  const wc = { id: 7, session: { webRequest, getBlobData } } as unknown as WebContents;
  const failure = jest.fn();
  const native = new NativeTraffic(wc, failure);
  const emit = (name: string, details: object, callback = jest.fn()): jest.Mock => {
    listeners.get(name)?.(details, callback);
    return callback;
  };
  const request = (extra: object = {}): jest.Mock => emit('onBeforeRequest', { id: 1, webContentsId: 7,
    url: `${SURFACE.origin}/api/graphql`, method: 'POST', resourceType: 'xhr', timestamp: 100,
    uploadData: [{ bytes: Buffer.from('variables=%7B%7D') }], ...extra });
  const response = (extra: object = {}): jest.Mock => emit('onHeadersReceived', { id: 1, timestamp: 200,
    statusCode: 200, responseHeaders: { 'Content-Type': ['application/json'] }, ...extra });
  const complete = (extra: object = {}): void => { emit('onCompleted', { id: 1, timestamp: 300,
    statusCode: 200, responseHeaders: { 'content-type': ['application/json'] }, error: 'net::OK', ...extra }); };
  native.start();
  return { native, failure, emit, request, response, complete, getBlobData, webRequest, listeners };
}

test('ownership survives detached-frame events and only safe headers and payload hashes serialize', async () => {
  const h = harness();
  expect(h.request()).toHaveBeenCalledWith({});
  h.emit('onBeforeSendHeaders', { id: 1, requestHeaders: { 'X-FB-Friendly-Name': 'SyntheticQuery',
    'Content-Type': 'application/x-www-form-urlencoded', Cookie: 'private-cookie', 'X-CSRFToken': 'private-token' } });
  expect(h.response()).toHaveBeenCalledWith({});
  h.complete();
  h.native.stop(); await h.native.drain();
  expect(h.native.exchanges).toEqual([expect.objectContaining({ id: 1, webContentsId: 7, startedAt: 100,
    responseAt: 200, endedAt: 300, status: 200, mime: 'application/json', terminal: 'completed',
    headers: { 'x-fb-friendly-name': 'SyntheticQuery', 'content-type': 'application/x-www-form-urlencoded' },
    post: { state: 'complete', bytes: Buffer.byteLength('variables=%7B%7D'), sha256: createHash('sha256').update('variables=%7B%7D').digest('hex') } })]);
  expect(h.native.getPostData(1)).toBe('variables=%7B%7D');
  expect(JSON.stringify(h.native.exchanges)).not.toMatch(/private-cookie|private-token|variables=%7B%7D/);
  expect(h.failure).not.toHaveBeenCalled();
});

test('unrelated owners, lookalike origins, static assets and logging never enter the inventory', async () => {
  const h = harness();
  for (const extra of [{ webContentsId: 8 },
    { url: 'https://notinstagram.com/api/graphql' }, { url: `${SURFACE.origin}/static/app.js` },
    { url: `${SURFACE.origin}/ajax/bz` }, { url: `${SURFACE.origin}/ajax/bulk-route` }]) {
    expect(h.request(extra)).toHaveBeenCalledWith({});
  }
  h.response(); h.complete(); h.native.stop(); await h.native.drain();
  expect(h.native.exchanges).toEqual([]);
  expect(h.failure).not.toHaveBeenCalled();
});

test.each([undefined, 0, -1])('an API start without a valid owner fails even when later events identify this tab (%s)', async (webContentsId) => {
  const h = harness();
  const callback = h.request({ webContentsId, uploadData: [{ blobUUID: 'unowned-blob' }] });
  expect(callback).toHaveBeenCalledWith({});
  expect(h.failure).toHaveBeenCalledWith({ id: 1, detail: 'native request owner unavailable' });
  expect(callback.mock.invocationCallOrder[0]).toBeLessThan(h.failure.mock.invocationCallOrder[0]);
  h.response({ webContentsId: 7 }); h.complete({ webContentsId: 7 });
  h.native.stop(); await h.native.drain();
  expect(h.native.exchanges).toEqual([expect.objectContaining({ webContentsId: null, terminal: 'completed',
    status: 200, failed: 'native request owner unavailable' })]);
  expect(h.getBlobData).not.toHaveBeenCalled();
  expect(h.native.getPostData(1)).toBeUndefined();
  expect(qualifyTraffic([], h.native.exchanges, [], (id) => h.native.getPostData(id)).ok).toBe(false);
});

test('an unknown owner outside the API inventory does not fail the probe', async () => {
  const h = harness();
  h.request({ webContentsId: undefined, url: `${SURFACE.origin}/static/app.js` });
  h.native.stop(); await h.native.drain();
  expect(h.native.exchanges).toEqual([]);
  expect(h.failure).not.toHaveBeenCalled();
});

test('request callback is immediate and a pending blob survives the response finishing first', async () => {
  let resolveBlob!: (value: Buffer) => void;
  const h = harness(() => new Promise((resolve) => { resolveBlob = resolve; }));
  const callback = h.request({ uploadData: [{ blobUUID: 'synthetic-blob' }] });
  expect(callback.mock.invocationCallOrder[0]).toBeLessThan(h.getBlobData.mock.invocationCallOrder[0]);
  expect(h.native.exchanges[0].post.state).toBe('pending');
  h.response(); h.complete();
  await expect(h.native.settle()).resolves.toBe(true);
  h.native.stop();
  let drained = false;
  const drain = h.native.drain().then(() => { drained = true; });
  await Promise.resolve(); expect(drained).toBe(false);
  resolveBlob(Buffer.from('complete-blob'));
  await drain;
  expect(h.native.exchanges[0]).toMatchObject({ terminal: 'completed', post: { state: 'complete' } });
  expect(h.native.getPostData(1)).toBe('complete-blob');
});

test.each([[429, 'application/json'], [200, 'text/html']])('unsafe response fails immediately and preserves its first reason (%s)', async (status, mime) => {
  const h = harness(); h.request();
  const callback = h.response({ statusCode: status, responseHeaders: { 'content-type': [mime] } });
  expect(callback.mock.invocationCallOrder[0]).toBeLessThan(h.failure.mock.invocationCallOrder[0]);
  expect(h.failure).toHaveBeenCalledWith({ id: 1, detail: `unsafe native API response: ${status} ${mime}` });
  h.emit('onErrorOccurred', { id: 1, timestamp: 300, error: 'net::ERR_FAILED' });
  h.native.stop(); await h.native.drain();
  expect(h.failure).toHaveBeenCalledTimes(1);
  expect(h.native.exchanges[0].failed).toBe(`unsafe native API response: ${status} ${mime}`);
});

test('native cancellation is terminal evidence without an invented status or body', async () => {
  const h = harness(); h.request();
  const settling = h.native.settle();
  h.emit('onErrorOccurred', { id: 1, timestamp: 300, error: 'net::ERR_ABORTED' });
  await expect(settling).resolves.toBe(true);
  h.native.stop(); await h.native.drain();
  expect(h.native.exchanges[0]).toMatchObject({ terminal: 'aborted', error: 'net::ERR_ABORTED' });
  expect(h.native.exchanges[0].status).toBeUndefined();
  expect(h.failure).not.toHaveBeenCalled();
});

test('redirects and reused IDs are explicit and never silently substitute request payloads', async () => {
  const h = harness(); h.request();
  h.emit('onBeforeRedirect', { id: 1, timestamp: 200, statusCode: 302,
    redirectURL: `${SURFACE.origin}/api/next`, responseHeaders: { 'content-type': ['application/json'] } });
  h.request({ url: `${SURFACE.origin}/api/next`, timestamp: 201, uploadData: [{ bytes: Buffer.from('different') }] });
  h.response(); h.complete(); h.native.stop(); await h.native.drain();
  expect(h.native.exchanges).toHaveLength(2);
  expect(h.native.exchanges[0]).toMatchObject({ status: 302, redirect: { status: 302, url: `${SURFACE.origin}/api/next` } });
  expect(h.native.exchanges[1].failed).toBe('native request id reused');
  expect(h.native.getPostData(1)).toBeUndefined();
});

test.each([
  [undefined, 'missing'], [[], 'none'], [[{ file: '/must-not-read' }], 'unsupported'],
  [[{}], 'unsupported'], [[{ bytes: Buffer.alloc(SURFACE_BOUNDS.requestBodyMaxBytes + 1) }], 'failed'],
])('upload incompleteness is explicit without partial text (%s)', async (uploadData, state) => {
  const h = harness(); h.request({ uploadData }); h.native.stop(); await h.native.drain();
  expect(h.native.exchanges[0].post.state).toBe(state);
  expect(h.native.getPostData(1)).toBeUndefined();
  expect(h.getBlobData).not.toHaveBeenCalled();
});

test('binary bytes are hashed without being decoded into fabricated form text', async () => {
  const h = harness(); h.request({ uploadData: [{ bytes: Buffer.from([255]) }] });
  h.native.stop(); await h.native.drain();
  expect(h.native.exchanges[0].post).toMatchObject({ state: 'complete', bytes: 1, detail: 'upload is not UTF-8 text' });
  expect(h.native.getPostData(1)).toBeUndefined();
});

test.each(['GET', 'HEAD'])('a bodyless browser %s omits uploadData; supplied parts are never discarded', async (method) => {
  const h = harness(); h.request({ method, uploadData: undefined }); h.complete();
  h.native.stop(); await h.native.drain();
  expect(h.native.exchanges[0].post).toEqual({ state: 'none' });
  expect(qualifyTraffic([], h.native.exchanges, [], () => undefined).ok).toBe(true);
  const withBody = harness(); withBody.request({ method });
  withBody.native.stop(); await withBody.native.drain();
  expect(withBody.native.exchanges[0].post.state).toBe('complete');
  expect(withBody.native.getPostData(1)).toBe('variables=%7B%7D');
});

test('mixed inline and blob parts preserve their complete upload order for correlation', async () => {
  const h = harness(async () => Buffer.from('middle'));
  h.request({ uploadData: [{ bytes: Buffer.from('prefix-') }, { blobUUID: 'synthetic-blob' }, { bytes: Buffer.from('-suffix') }] });
  h.native.stop(); await h.native.drain();
  expect(h.native.getPostData(1)).toBe('prefix-middle-suffix');
  expect(h.native.exchanges[0].post).toEqual({ state: 'complete', bytes: 20,
    sha256: createHash('sha256').update('prefix-middle-suffix').digest('hex') });
});

test('the capture cap covers the combined inline and blob body without retaining a prefix', async () => {
  const h = harness(async () => Buffer.alloc(SURFACE_BOUNDS.requestBodyMaxBytes));
  h.request({ uploadData: [{ bytes: Buffer.from('x') }, { blobUUID: 'synthetic-blob' }] });
  h.native.stop(); await h.native.drain();
  expect(h.native.exchanges[0].post).toEqual({ state: 'failed', detail: 'Error: native upload exceeds capture cap' });
  expect(h.native.getPostData(1)).toBeUndefined();
});

test('blob rejection remains metadata evidence', async () => {
  const h = harness(async () => { throw new Error('blob unavailable'); });
  h.request({ uploadData: [{ blobUUID: 'synthetic-blob' }] }); h.native.stop(); await h.native.drain();
  expect(h.native.exchanges[0].post).toEqual({ state: 'failed', detail: 'Error: blob unavailable' });
});

test('blob timeout is bounded and a late value cannot replace failed evidence', async () => {
  jest.useFakeTimers();
  try {
    let resolveBlob!: (value: Buffer) => void;
    const h = harness(() => new Promise((resolve) => { resolveBlob = resolve; }));
    h.request({ uploadData: [{ blobUUID: 'synthetic-blob' }] }); h.native.stop();
    const drain = h.native.drain();
    await jest.advanceTimersByTimeAsync(TAB.GET_BODY_TIMEOUT_MS);
    await drain;
    expect(h.native.exchanges[0].post).toEqual({ state: 'failed', detail: 'Error: native upload read timed out' });
    resolveBlob(Buffer.from('too late')); await Promise.resolve();
    expect(h.native.getPostData(1)).toBeUndefined();
    expect(jest.getTimerCount()).toBe(0);
  } finally { jest.useRealTimers(); }
});

test('settlement includes new requests and removes its deadline after all terminal events', async () => {
  jest.useFakeTimers();
  try {
    const h = harness(); h.request({ uploadData: [] });
    let settled = false;
    const done = h.native.settle().then((value) => { settled = value; });
    h.request({ id: 2, uploadData: [] }); h.complete();
    await Promise.resolve(); expect(settled).toBe(false);
    h.complete({ id: 2 }); await done;
    expect(settled).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
    h.native.stop(); await h.native.drain();
  } finally { jest.useRealTimers(); }
});

test('settlement timeout leaves unresolved entries unchanged and stop removes every listener', async () => {
  jest.useFakeTimers();
  try {
    const h = harness(); h.native.start(); h.request({ uploadData: [] });
    const done = h.native.settle();
    await jest.advanceTimersByTimeAsync(TAB.GET_BODY_TIMEOUT_MS);
    await expect(done).resolves.toBe(false);
    expect(h.native.exchanges[0].terminal).toBeUndefined();
    const stopped = h.native.settle(); h.native.stop();
    await expect(stopped).resolves.toBe(false);
    h.native.stop(); await h.native.drain();
    for (const name of hooks) { expect(h.webRequest[name]).toHaveBeenCalledTimes(2); expect(h.listeners.get(name)).toBeNull(); }
    expect(jest.getTimerCount()).toBe(0);
  } finally { jest.useRealTimers(); }
});
