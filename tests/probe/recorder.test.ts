import { EventEmitter } from 'node:events';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { WebContents } from 'electron';
import { TrafficRecorder } from '@/probe/recorder';
import { TAB } from '@/timing/config';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function harness(post?: Promise<unknown>, body?: Promise<unknown>) {
  const out = mkdtempSync(path.join(tmpdir(), 'epo-recorder-'));
  dirs.push(out);
  const dbg = Object.assign(new EventEmitter(), {
    sendCommand: jest.fn((method: string) => method === 'Network.getRequestPostData'
      ? post ?? Promise.resolve({ postData: 'doc_id=123' })
      : body ?? Promise.resolve({ body: '{"status":"ok"}', base64Encoded: false })),
  });
  const wc = { debugger: dbg } as unknown as WebContents;
  const emit = (method: string, params: object) => dbg.emit('message', {}, method, params);
  const request = (extra: object = {}) => emit('Network.requestWillBeSent', {
    requestId: 'one', request: { url: 'https://www.instagram.com/api/graphql', method: 'POST', ...extra },
  });
  const response = (status = 200, mimeType = 'application/json') => emit('Network.responseReceived', {
    requestId: 'one', response: { status, mimeType },
  });
  return { out, wc, emit, request, response };
}

test('response metadata survives while asynchronous POST metadata is pending', async () => {
  let resolvePost!: (value: unknown) => void;
  const h = harness(new Promise((resolve) => { resolvePost = resolve; }));
  const rec = new TrafficRecorder(h.wc, h.out);
  rec.start();
  h.request({ hasPostData: true });
  h.response(429);
  resolvePost({ postData: 'doc_id=123' });
  await Promise.resolve();
  await Promise.resolve();
  rec.stop();
  await rec.drain();
  expect(rec.exchanges).toHaveLength(1);
  expect(rec.exchanges[0]).toMatchObject({ status: 429, form: { doc_id: '123' } });
});

test('drain waits for a captured body before returning final evidence', async () => {
  let resolveBody!: (value: unknown) => void;
  const h = harness(undefined, new Promise((resolve) => { resolveBody = resolve; }));
  const rec = new TrafficRecorder(h.wc, h.out);
  rec.start(); h.request(); h.response(); h.emit('Network.loadingFinished', { requestId: 'one' });
  rec.stop();
  let done = false;
  const draining = rec.drain().then(() => { done = true; });
  await Promise.resolve();
  expect(done).toBe(false);
  resolveBody({ body: '{"status":"ok"}', base64Encoded: false });
  await draining;
  const files = readdirSync(path.join(h.out, 'bodies'));
  expect(files).toHaveLength(1);
  expect(JSON.parse(readFileSync(path.join(h.out, 'bodies', files[0]), 'utf8'))).toEqual({ status: 'ok' });
  expect(rec.exchanges[0].body).toBe(files[0]);
});

test.each([[429, 'application/json'], [200, 'text/html']])('reports an unsafe API response immediately (%s/%s)', (status, mime) => {
  const h = harness();
  const failure = jest.fn();
  const rec = new TrafficRecorder(h.wc, h.out, failure);
  rec.start(); h.request(); h.response(status, mime);
  expect(failure).toHaveBeenCalledTimes(1);
  rec.stop();
});

test('body failures remain evidence and do not reject drain', async () => {
  const h = harness(undefined, Promise.reject(new Error('cache gone')));
  const failure = jest.fn();
  const rec = new TrafficRecorder(h.wc, h.out, failure);
  rec.start(); h.request(); h.response(); h.emit('Network.loadingFinished', { requestId: 'one' });
  rec.stop();
  await expect(rec.drain()).resolves.toBeUndefined();
  expect(rec.exchanges[0].failed).toContain('cache gone');
  expect(failure).toHaveBeenCalled();
});

test('a stalled body read cannot hold shutdown beyond the existing tab deadline', async () => {
  jest.useFakeTimers();
  try {
    const h = harness(undefined, new Promise(() => {}));
    const failure = jest.fn();
    const rec = new TrafficRecorder(h.wc, h.out, failure);
    rec.start(); h.request(); h.response(); h.emit('Network.loadingFinished', { requestId: 'one' });
    rec.stop();
    const draining = rec.drain();
    await jest.advanceTimersByTimeAsync(TAB.GET_BODY_TIMEOUT_MS);
    await draining;
    expect(rec.exchanges[0].failed).toContain('timed out');
    expect(failure).toHaveBeenCalledTimes(1);
  } finally { jest.useRealTimers(); }
});
